// "Test a rule": builds a cart from real products and runs it through the
// SAME engine the checkout Function runs (extensions/cartrules-validation/
// src/engine.js), with the rule converted by the same buildRulesCache the
// live cache uses — so the result is what checkout would do, not a guess.
import { evaluateCart } from "../../extensions/cartrules-validation/src/engine.js";
import {
  buildRulesCache,
  listRules,
  getValidation,
  readRulesCache,
  FUNCTION_METAFIELD_MAX_BYTES,
  setSetupFlag,
} from "./rules.server";
import { getSettings } from "./settings.server";
import { recordEvents, EVENT_TYPE_BY_RULE_TYPE } from "./events.server";
import { getScheduleStatus } from "./ruleDisplay";
import { RULE_STATUS, CUSTOMER_TYPES } from "./ruleConstants";

async function loadLines(admin, items) {
  const ids = items.map((i) => i.variantId).filter(Boolean);
  if (ids.length === 0) return [];
  const response = await admin.graphql(
    `#graphql
    query CartRulesSimulatorVariants($ids: [ID!]!) {
      nodes(ids: $ids) {
        ... on ProductVariant {
          id
          price
          product {
            id
            title
            vendor
            productType
            tags
            collections(first: 250) { nodes { id } }
          }
        }
      }
    }`,
    { variables: { ids } },
  );
  const json = await response.json();
  const byId = new Map((json.data?.nodes ?? []).filter(Boolean).map((n) => [n.id, n]));
  return items
    .map((item) => {
      const v = byId.get(item.variantId);
      if (!v) return null;
      const quantity = Math.max(0, Math.floor(Number(item.quantity) || 0));
      return {
        productId: v.product.id,
        variantId: v.id,
        title: v.product.title,
        vendor: v.product.vendor,
        productType: v.product.productType,
        tags: (v.product.tags ?? []).map((t) => t.toLowerCase()),
        collections: (v.product.collections?.nodes ?? []).map((c) => c.id),
        quantity,
        subtotal: Math.round(Number(v.price) * quantity * 100) / 100,
        hasDiscount: false,
      };
    })
    .filter(Boolean);
}

/**
 * input: { ruleId | null (all live rules), items: [{ variantId, quantity }],
 *          customerType: "guest"|"logged_in"|"b2b", customerTags: [], country, discountCode }
 */
export async function runSimulation(admin, shop, input) {
  const [rules, settings, cache, validation] = await Promise.all([
    listRules(admin),
    getSettings(admin),
    readRulesCache(admin),
    getValidation(admin).catch(() => null),
  ]);
  const lines = await loadLines(admin, input.items ?? []);
  if (lines.length === 0) return { error: "Choose a product to test with." };

  const discountCode = String(input.discountCode ?? "").trim() || null;
  // A code applies to every line in this simulation — Block discount rules
  // then decide whether checkout allows it.
  if (discountCode) for (const l of lines) l.hasDiscount = true;

  const customerType = input.customerType ?? "guest";
  const cart = {
    lines,
    customer: {
      loggedIn: customerType !== "guest",
      b2b: customerType === "b2b",
      tags: (input.customerTags ?? []).map((t) => String(t).trim().toLowerCase()).filter(Boolean),
    },
    country: input.country ? String(input.country).toUpperCase() : null,
    subtotal: Math.round(lines.reduce((s, l) => s + l.subtotal, 0) * 100) / 100,
    currency: input.currency ?? null,
    discountCode,
  };

  const target = input.ruleId ? rules.find((r) => r.id === input.ruleId) : null;
  if (input.ruleId && !target) return { error: "This rule no longer exists." };

  // The tested rule is evaluated as if live (so a paused or draft rule can be
  // tried before activating it), alongside every other live rule so conflicts
  // show up exactly as they would at checkout.
  const testedRules = target
    ? [...rules.filter((r) => r.id !== target.id), { ...target, status: RULE_STATUS.ACTIVE, schedule: {} }]
    : rules;
  const built = JSON.parse(buildRulesCache(testedRules, settings).value);
  const { violations, matches } = evaluateCart(cart, built.rules, { conflictMode: built.conflictMode });

  const relevantViolations = target ? violations.filter((v) => v.ruleId === target.id) : violations;
  const relevantMatches = target ? matches.filter((m) => m.ruleId === target.id) : matches;
  const overriddenBy = target ? relevantMatches.find((m) => m.overriddenBy)?.overriddenBy : null;
  const titleOf = (id) => rules.find((r) => r.id === id)?.title ?? "Another rule";

  // Why a rule might not be enforced at checkout right now, even if it triggers here.
  const notices = [];
  if (target) {
    const status = getScheduleStatus(target);
    if (status === "paused" || status === "draft") notices.push(`This rule is ${status} — it isn't enforced at checkout until you activate it.`);
    if (status === "scheduled") notices.push("This rule is scheduled — checkout enforces it once its start date arrives.");
    if (status === "ended") notices.push("This rule's schedule has ended — checkout no longer enforces it.");
  }
  if (!settings.protectionEnabled) notices.push("CartRules protection is turned off in Settings, so checkout enforces nothing.");
  if (validation && !validation.enabled) notices.push("CartRules is turned off in Shopify's checkout rules, so checkout enforces nothing.");
  if (cache.bytes > FUNCTION_METAFIELD_MAX_BYTES) notices.push("Your rules are too large for checkout to read — see Store health on the Overview.");

  const result = {
    triggered: relevantViolations.length > 0,
    matched: relevantMatches.length > 0,
    blocked: relevantViolations.length > 0,
    overriddenBy: overriddenBy ? { id: overriddenBy, title: titleOf(overriddenBy) } : null,
    violations: relevantViolations.map((v) => ({ ...v, ruleTitle: titleOf(v.ruleId) })),
    // Other rules that would ALSO block this cart (when testing one rule).
    otherViolations: target ? violations.filter((v) => v.ruleId !== target.id).map((v) => ({ ...v, ruleTitle: titleOf(v.ruleId) })) : [],
    cart: {
      lines: lines.map((l) => ({ title: l.title, quantity: l.quantity, subtotal: l.subtotal })),
      subtotal: cart.subtotal,
      customer: customerType,
      country: cart.country,
      discountCode,
    },
    notices,
    ruleTitle: target?.title ?? null,
    customerConditionNote:
      target && target.customer?.type !== CUSTOMER_TYPES.EVERYONE && !relevantMatches.length
        ? "This rule only applies to some customers — try a different customer type or tags."
        : null,
  };

  // Recorded as a test event (shown in Activity with a Test badge, never in KPIs).
  const events = result.violations.length
    ? result.violations.map((v) => ({
        ruleId: v.ruleId,
        ruleTitle: v.ruleTitle,
        ruleType: v.type,
        eventType: EVENT_TYPE_BY_RULE_TYPE[v.type],
        source: "test",
        productId: v.productId,
        productTitle: v.productTitle,
        attempted: v.attempted,
        allowed: v.allowed,
        detail: v.message,
      }))
    : target
      ? [
          {
            ruleId: target.id,
            ruleTitle: target.title,
            ruleType: target.ruleType,
            eventType: "rule_passed",
            source: "test",
            productId: lines[0].productId,
            productTitle: lines[0].title,
            attempted: lines[0].quantity,
            allowed: target.value,
            detail: result.matched ? "Cart is within this rule" : "Rule doesn't apply to this cart",
          },
        ]
      : [];
  await Promise.all([
    recordEvents(shop, events).catch((error) => console.error("Failed to record test event", error)),
    setSetupFlag(admin, "ruleTested", true).catch((error) => console.error("Failed to save setup flag", error)),
  ]);
  return result;
}
