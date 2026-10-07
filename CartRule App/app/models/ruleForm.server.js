// Server side of the shared rule form (app/components/RuleForm.jsx), used by
// both /app/rules/new and /app/rules/:id.
import { json } from "@remix-run/node";
import {
  createRule,
  updateRule,
  listRules,
  normalizeRuleInput,
  RulesCacheSyncError,
} from "./rules.server";
import { getPlan, checkPlanForSave, activeRuleRoom } from "./plan.server";
import { getDefaultMessages } from "./settings.server";
import { RULE_STATUS } from "./ruleConstants";
import { redirectWithToast } from "../utils/toastRedirect.server";

/** Tags / vendors / types for autocomplete, and Shopify Markets (needs read_markets). */
export async function loadRuleFormOptions(admin) {
  const options = { tags: [], vendors: [], types: [], markets: [], marketsAvailable: true };
  try {
    const response = await admin.graphql(`#graphql
      query RuleFormOptions {
        productTags(first: 250) { nodes }
        productVendors(first: 250) { nodes }
        productTypes(first: 250) { nodes }
      }`);
    const data = (await response.json()).data;
    options.tags = data?.productTags?.nodes ?? [];
    options.vendors = data?.productVendors?.nodes ?? [];
    options.types = (data?.productTypes?.nodes ?? []).filter(Boolean);
  } catch (error) {
    if (error instanceof Response) throw error;
    console.warn("Could not load rule form suggestions", error?.message ?? String(error));
  }
  try {
    const response = await admin.graphql(`#graphql
      query RuleFormMarkets { markets(first: 50) { nodes { id name } } }`);
    const body = await response.json();
    if (body.errors?.length) throw new Error(JSON.stringify(body.errors));
    options.markets = body.data?.markets?.nodes ?? [];
  } catch (error) {
    if (error instanceof Response) throw error;
    // read_markets not granted yet: the form hides the Markets option.
    options.marketsAvailable = false;
  }
  return options;
}

export function formDefaults(settings) {
  return getDefaultMessages(settings);
}

/**
 * Validates and saves the posted rule. `existing` is the stored rule when
 * editing. Returns a Response (redirect) on success or json({ ok: false, error }).
 */
export async function saveRuleFromForm({ admin, billing, shop, formData, existing = null }) {
  let payload;
  try {
    payload = JSON.parse(formData.get("rule") ?? "{}");
  } catch (_e) {
    return json({ ok: false, error: "The form couldn't be read. Please try again." }, { status: 400 });
  }

  let rule;
  try {
    rule = normalizeRuleInput(payload);
  } catch (error) {
    return json({ ok: false, error: error.message });
  }

  try {
    const [plan, rules] = await Promise.all([getPlan(admin, billing, shop), listRules(admin)]);
    const locked = checkPlanForSave(rule, plan.name, existing);
    if (locked.length) {
      const needs = locked.some((f) => f.plan === "Pro") ? "Pro" : "Growth";
      return json({
        ok: false,
        error: `${locked.map((f) => f.label).join(", ")} ${locked.length === 1 ? "needs" : "need"} the ${needs} plan. Upgrade in Plan & billing, or remove ${locked.length === 1 ? "it" : "them"} to save on ${plan.name}.`,
        upgrade: true,
      });
    }

    let capped = false;
    if (rule.status === RULE_STATUS.ACTIVE && existing?.status !== RULE_STATUS.ACTIVE) {
      const activeCount = rules.filter((r) => r.status === RULE_STATUS.ACTIVE && r.id !== existing?.id).length;
      if (activeRuleRoom(plan.name, activeCount) <= 0) {
        rule.status = RULE_STATUS.PAUSED;
        capped = true;
      }
    }

    if (existing) await updateRule(admin, existing.id, rule);
    else await createRule(admin, rule);

    if (capped) {
      return redirectWithToast(
        "/app/rules",
        `Free plan limit reached — "${rule.title}" was saved as paused. Upgrade to activate it.`,
        { isError: true },
      );
    }
    const scheduled = rule.status === RULE_STATUS.ACTIVE && rule.schedule.startsAt && Date.parse(rule.schedule.startsAt) > Date.now();
    const verb = existing
      ? "updated"
      : rule.status === RULE_STATUS.DRAFT
        ? "saved as a draft"
        : scheduled
          ? "scheduled"
          : rule.status === RULE_STATUS.ACTIVE
            ? "created and activated"
            : "saved";
    return redirectWithToast("/app/rules", `Rule "${rule.title}" ${verb}`);
  } catch (error) {
    if (error instanceof Response) throw error;
    if (error instanceof RulesCacheSyncError) {
      // The rule exists — a retry would create a duplicate.
      console.error("Rule saved but checkout sync failed", error.cause);
      return redirectWithToast(
        "/app/rules",
        "Rule saved, but checkout couldn't be updated yet. Pause and resume the rule to retry.",
        { isError: true },
      );
    }
    console.error("Failed to save rule", error);
    return json({ ok: false, error: "We couldn't save this rule. Please try again." });
  }
}
