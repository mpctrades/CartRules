// The plan feature matrix — client-safe, so the rule form shows locks before
// saving; plan.server.js re-exports it as lockedFeatures for server checks.
import { RULE_TYPE_INFO, TARGET_INFO, CUSTOMER_TYPES, MARKET_TYPES, planAllows } from "./ruleConstants";

export const FEATURE_PLANS = {
  message: "Growth",
  schedule: "Growth",
  customer: "Pro",
  market: "Pro",
  conditions: "Pro",
  priority: "Pro",
};

// What v1's Free plan included that v2 moved to Growth. Rules merchants
// saved before v2 (rule.legacy) keep these on Free — existing stores must
// not lose rules they set up for free.
export const LEGACY_FREE_FEATURES = new Set(["target:collection", "target:tag", "message"]);

export function lockedFeaturesClient(rule, plan) {
  const locked = [];
  const need = (key, label, required) => {
    if (rule.legacy && LEGACY_FREE_FEATURES.has(key)) return;
    if (!planAllows(plan, required) && !locked.some((f) => f.key === key)) locked.push({ key, label, plan: required });
  };
  const typeInfo = RULE_TYPE_INFO[rule.ruleType];
  if (typeInfo) need("type", typeInfo.title, typeInfo.plan);
  for (const t of [rule.target, rule.comboTarget]) {
    if (t && TARGET_INFO[t.type]) need(`target:${t.type}`, `${TARGET_INFO[t.type].label} targeting`, TARGET_INFO[t.type].plan);
  }
  if (rule.message?.trim()) need("message", "Custom customer message", FEATURE_PLANS.message);
  if (rule.schedule?.startsAt || rule.schedule?.endsAt) need("schedule", "Scheduling", FEATURE_PLANS.schedule);
  if (rule.customer && rule.customer.type !== CUSTOMER_TYPES.EVERYONE) need("customer", "Customer conditions", FEATURE_PLANS.customer);
  if (rule.market && rule.market.type !== MARKET_TYPES.ALL) need("market", "Market conditions", FEATURE_PLANS.market);
  if (rule.conditions?.length) need("conditions", "Advanced conditions", FEATURE_PLANS.conditions);
  if (rule.priority) need("priority", "Rule priority", FEATURE_PLANS.priority);
  return locked;
}
