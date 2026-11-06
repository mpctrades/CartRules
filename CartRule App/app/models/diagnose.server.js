// "Why isn't my rule working?" — checks one rule against everything that can
// stop it from applying and explains each finding with one way to fix it.
// Uses the same checks as the Overview and Rules pages, so answers agree.
import { getRulesHealth } from "./health.server";
import {
  getCheckoutEnforcement,
  readRulesCache,
  FUNCTION_METAFIELD_MAX_BYTES,
} from "./rules.server";
import { getThemeBlockStatus } from "./theme.server";
import { lockedFeatures } from "./plan.server";
import {
  CUSTOMER_TYPES,
  MARKET_TYPES,
  RULE_STATUS,
  RULE_TYPES,
} from "./ruleConstants";
import {
  describeCustomer,
  describeRule,
  formatDateTime,
  getScheduleStatus,
} from "./ruleDisplay";

const PRODUCT_RULES = new Set([
  RULE_TYPES.MAX_QUANTITY,
  RULE_TYPES.MIN_QUANTITY,
  RULE_TYPES.QUANTITY_MULTIPLE,
  RULE_TYPES.NO_DISCOUNT,
]);

/**
 * Returns { rule: { id, title, summary }, findings: [{ severity, title, detail, fix? }] }
 * severity: "bad" (rule can't apply), "warn" (partly broken), "info" (by design), "ok".
 * fix: { label, to } (app page) | { label, intent } (Help action) | { label, href } (new tab).
 */
export async function diagnoseRule(ctx, ruleId) {
  const { admin, shop, plan, rules, settings, timezone, currency } = ctx;
  const rule = rules.find((r) => r.id === ruleId);
  if (!rule) return null;
  const edit = {
    label: "Edit rule",
    to: `/app/rules/${encodeURIComponent(rule.id)}`,
  };
  const liveCount = rules.filter(
    (r) => getScheduleStatus(r) === "active",
  ).length;

  const [health, enforcing, cache, theme] = await Promise.all([
    getRulesHealth(admin, shop, rules, {
      plan: plan.name,
      conflictMode: settings.conflictMode,
    }),
    getCheckoutEnforcement(admin, liveCount),
    readRulesCache(admin),
    getThemeBlockStatus(admin, shop),
  ]);

  const findings = [];
  const add = (severity, title, detail, fix) =>
    findings.push({ severity, title, detail, fix: fix ?? null });

  // 1. Store-wide switches.
  if (!settings.protectionEnabled) {
    add(
      "bad",
      "CartRules protection is turned off",
      "While it's off, no rule is enforced anywhere.",
      {
        label: "Open Settings",
        to: "/app/settings",
      },
    );
  }
  if (enforcing === false && liveCount > 0) {
    add(
      "bad",
      "Checkout validation is off in Shopify",
      "Shopify isn't running CartRules at checkout, so every rule is skipped.",
      { label: "Turn it on", intent: "enableValidation" },
    );
  }
  if (cache.bytes > FUNCTION_METAFIELD_MAX_BYTES) {
    add(
      "bad",
      "Your rules are too large for checkout",
      "Checkout can't read the rule list. Pause or simplify some rules.",
      {
        label: "Review rules",
        to: "/app/rules",
      },
    );
  }

  // 2. This rule's own status and schedule.
  const status = getScheduleStatus(rule);
  if (rule.status === RULE_STATUS.DRAFT || status === "draft") {
    add(
      "bad",
      "This rule is a draft",
      "Drafts aren't enforced. Activate it when you're ready.",
      edit,
    );
  } else if (rule.status !== RULE_STATUS.ACTIVE) {
    add(
      "bad",
      "This rule is paused",
      "Paused rules aren't enforced. Activate it from the Rules page.",
      {
        label: "Go to rules",
        to: "/app/rules?tab=paused",
      },
    );
  } else if (status === "ended") {
    add(
      "bad",
      "This rule's schedule has ended",
      `It stopped on ${formatDateTime(rule.schedule.endsAt, timezone)}. Change or remove the end date to use it again.`,
      edit,
    );
  } else if (status === "scheduled") {
    add(
      "warn",
      "This rule hasn't started yet",
      `It's scheduled to start on ${formatDateTime(rule.schedule.startsAt, timezone)}.`,
      edit,
    );
  }

  // 3. Plan: a rule using features the plan doesn't include is paused on downgrade.
  const locked = lockedFeatures(rule, plan.name);
  if (locked.length) {
    const needs = locked.some((f) => f.plan === "Pro") ? "Pro" : "Growth";
    add(
      "bad",
      `Uses ${needs} features`,
      `${locked.map((f) => f.label).join(", ")} ${locked.length === 1 ? "isn't" : "aren't"} included in your ${plan.name} plan.`,
      { label: "See plans", to: "/app/billing" },
    );
  }

  // 4. Targeting problems (deleted products, empty tags/collections…).
  for (const issue of health.health[rule.id]?.issues ?? []) {
    add(
      "warn",
      issue.message,
      "The rule can't match products that no longer exist or aren't in the target.",
      edit,
    );
  }

  // 5. Another rule wins on the same products.
  for (const c of health.conflicts.filter(
    (c) => c.ruleIds.includes(rule.id) && c.winnerId && c.winnerId !== rule.id,
  )) {
    const winner = rules.find((r) => r.id === c.winnerId);
    add(
      "warn",
      `"${winner?.title || "Another rule"}" applies instead on some products`,
      c.message,
      { label: "Compare rules", to: "/app/rules" },
    );
  }

  // 6. By design: who and where the rule applies to.
  if (rule.customer?.type && rule.customer.type !== CUSTOMER_TYPES.EVERYONE) {
    add(
      "info",
      `Only for ${describeCustomer(rule.customer).toLowerCase()}`,
      "Other shoppers aren't affected — test with a matching customer.",
    );
  }
  if (rule.market?.type && rule.market.type !== MARKET_TYPES.ALL) {
    add(
      "info",
      "Only in some countries",
      "Shoppers checking out from other countries aren't affected.",
    );
  }
  if (rule.conditions?.length) {
    add(
      "info",
      `Has ${rule.conditions.length} extra condition${rule.conditions.length === 1 ? "" : "s"}`,
      "The rule only applies when every condition is met.",
    );
  }
  if (rule.ruleType === RULE_TYPES.NO_DISCOUNT) {
    add(
      "info",
      "Discounts aren't removed — checkout is held",
      "Shopify can't take a discount off one product, so checkout stops until the shopper removes the discount.",
    );
  }

  // 7. Storefront notices: checkout still enforces without them.
  if (
    PRODUCT_RULES.has(rule.ruleType) &&
    theme.productNotice === "missing" &&
    theme.cartGuard === "missing"
  ) {
    add(
      "info",
      "Shoppers only find out at checkout",
      "Neither CartRules block is in your theme, so there's no warning on the product or cart page. Checkout still enforces the rule.",
      { label: "Add product page notice", to: "/app/settings" },
    );
  }

  if (!findings.some((f) => f.severity === "bad" || f.severity === "warn")) {
    findings.unshift({
      severity: "ok",
      title: "Nothing is stopping this rule",
      detail:
        "It's active and enforced at checkout. Run a test cart to see exactly what a shopper is told.",
      fix: {
        label: "Test this rule",
        to: `/app/test?ruleId=${encodeURIComponent(rule.id)}`,
      },
    });
  }

  const order = { bad: 0, warn: 1, ok: 2, info: 3 };
  findings.sort((a, b) => order[a.severity] - order[b.severity]);
  return {
    rule: {
      id: rule.id,
      title: rule.title || "Untitled rule",
      summary: describeRule(rule, currency),
    },
    findings,
  };
}
