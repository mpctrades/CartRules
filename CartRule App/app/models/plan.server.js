// Which plan a shop is on, and which rule features each plan unlocks. The
// matrix is the one shown on Plan & billing (PLAN_COPY in app.billing.jsx)
// — keep the two in sync. Gating happens when a rule is saved or activated,
// and on a downgrade (enforcePlanLimits pauses rules the new plan can't run).
import { BILLING_PLANS, FREE_PLAN_RULE_LIMIT } from "../shopify.server";
import { isDevelopmentStore } from "./shop.server";
import { listRules, setRuleStatus, syncRulesCache } from "./rules.server";
import { RULE_STATUS } from "./ruleConstants";
import { lockedFeaturesClient } from "./planFeatures";

/** { name: "Free" | "Growth" | "Pro", subscriptionId, isTest } */
export async function getPlan(admin, billing, shop) {
  const isTest = await isDevelopmentStore(admin, shop);
  const { hasActivePayment, appSubscriptions } = await billing.check({
    plans: Object.values(BILLING_PLANS),
    isTest,
  });
  if (!hasActivePayment) return { name: "Free", subscriptionId: null, isTest };
  // Pro wins if somehow both are active.
  const pro = appSubscriptions.find((s) => s.name === BILLING_PLANS.PRO);
  const sub = pro ?? appSubscriptions[0];
  return { name: sub?.name ?? "Growth", subscriptionId: sub?.id ?? null, isTest };
}

/**
 * Features this rule uses that `plan` doesn't include, as
 * [{ key, label, plan }]. Same function the rule form uses client-side
 * (planFeatures.js), so the two can't drift.
 */
export const lockedFeatures = lockedFeaturesClient;

/**
 * Checks a rule about to be saved. Features the stored version already had
 * stay allowed (a downgrade pauses such rules; editing their message
 * shouldn't be blocked on top).
 */
export function checkPlanForSave(rule, plan, existing = null) {
  const before = new Set(existing ? lockedFeatures(existing, plan).map((f) => f.key) : []);
  return lockedFeatures(rule, plan).filter((f) => !before.has(f.key));
}

/** Free plan: how many more rules can be active. Infinity on paid plans. */
export function activeRuleRoom(plan, activeCount) {
  return plan === "Free" ? Math.max(0, FREE_PLAN_RULE_LIMIT - activeCount) : Infinity;
}

/**
 * After a downgrade (or a subscription ending outside the app): pauses
 * rules that use features the plan no longer includes, then — on Free —
 * any active rules beyond the cap, keeping the most recently updated ones.
 * Returns the number of rules paused.
 */
export async function enforcePlanLimits(admin, plan) {
  const rules = await listRules(admin);
  const active = rules.filter((r) => r.status === RULE_STATUS.ACTIVE);
  const toPause = new Set(active.filter((r) => lockedFeatures(r, plan).length > 0).map((r) => r.id));
  if (plan === "Free") {
    const remaining = active.filter((r) => !toPause.has(r.id));
    for (const r of remaining.slice(FREE_PLAN_RULE_LIMIT)) toPause.add(r.id);
  }
  if (toPause.size === 0) return 0;
  for (const id of toPause) {
    await setRuleStatus(admin, id, RULE_STATUS.PAUSED, { sync: false });
  }
  await syncRulesCache(admin, { activateValidation: false });
  return toPause.size;
}
