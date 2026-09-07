// Real rule-trigger history for the dashboard KPIs, the rule-activity
// chart, and the activity log — backed by the RuleEvent table (see
// prisma/schema.prisma for why this needed a real database: a shop
// metafield can hold a running counter, but not a queryable event history).
//
// Privacy boundary: recordOrderEvents only ever reads product ids/titles,
// quantities, and discount-allocation info off the order payload — never
// the customer's name, email, address, or any other identifying field.
//
// What each counter actually measures (documented approximations, not
// bugs — a Function can't report telemetry, so this is inferred from the
// finished order instead):
// - discountsBlocked: a line matching a "no_discount" rule, on an order
//   that had a discount code applied, whose line ended up with zero
//   discount allocation — i.e. the rule visibly did its job.
// - quantityViolations: a line matching a "max_quantity" rule whose final
//   quantity lands exactly on the cap. We can't see what the customer
//   originally tried to add (the Function blocks checkout before the order
//   exists) — landing exactly on the cap is the closest observable proxy
//   that the limit was actually reached.
// - checkoutsProtected: distinct orders containing at least one of the above.

import db from "../db.server";
import { readRulesCache } from "./rules.server";

const DAY_MS = 24 * 60 * 60 * 1000;

function matchesProduct(rule, productGid) {
  return Array.isArray(rule.productIds) && rule.productIds.includes(productGid);
}

/**
 * Called from the orders/create webhook. Cross-references the order's line
 * items against the rules_cache metafield (the same snapshot the checkout
 * Function used) and inserts one RuleEvent row per matched line.
 */
export async function recordOrderEvents(shop, admin, order) {
  const { rules } = await readRulesCache(admin);
  if (rules.length === 0) return;

  const maxQuantityRules = rules.filter((r) => r.ruleType === "max_quantity");
  const noDiscountRules = rules.filter((r) => r.ruleType === "no_discount");
  const hasOrderDiscount = (order.discount_applications?.length ?? 0) > 0;
  const orderId = String(order.id ?? "");
  const appliedCode = order.discount_codes?.[0]?.code;

  const rows = [];

  for (const line of order.line_items ?? []) {
    if (!line.product_id) continue;
    const productGid = `gid://shopify/Product/${line.product_id}`;
    const quantity = line.quantity ?? 0;
    const lineHasDiscount = (line.discount_allocations?.length ?? 0) > 0;

    for (const rule of maxQuantityRules) {
      if (rule.maxQuantity && quantity === rule.maxQuantity && matchesProduct(rule, productGid)) {
        rows.push({
          shop,
          orderId,
          ruleId: rule.id,
          ruleTitle: rule.title || rule.message || "Max quantity rule",
          ruleType: "max_quantity",
          productId: productGid,
          productTitle: line.title ?? null,
          detail: `Attempted/ordered ${quantity}, allowed ${rule.maxQuantity}`,
        });
      }
    }

    if (hasOrderDiscount && !lineHasDiscount) {
      for (const rule of noDiscountRules) {
        if (matchesProduct(rule, productGid)) {
          rows.push({
            shop,
            orderId,
            ruleId: rule.id,
            ruleTitle: rule.title || rule.message || "No discount rule",
            ruleType: "no_discount",
            productId: productGid,
            productTitle: line.title ?? null,
            detail: appliedCode ? `Code ${appliedCode}` : "Discount code blocked",
          });
        }
      }
    }
  }

  if (rows.length === 0) return;
  await db.ruleEvent.createMany({ data: rows });
}

function pctChange(current, previous) {
  if (previous === 0) return current === 0 ? 0 : null; // null = "new, no baseline"
  return Math.round(((current - previous) / previous) * 100);
}

async function windowCounts(shop, start, end) {
  const events = await db.ruleEvent.findMany({
    where: { shop, createdAt: { gte: start, lt: end } },
    select: { ruleType: true, orderId: true },
  });
  return {
    triggers: events.length,
    discountsBlocked: events.filter((e) => e.ruleType === "no_discount").length,
    quantityViolations: events.filter((e) => e.ruleType === "max_quantity").length,
    checkoutsProtected: new Set(events.map((e) => e.orderId)).size,
  };
}

/** KPI cards for the dashboard: current N-day window vs the prior equal window. */
export async function getKpis(shop, days = 30) {
  const now = new Date();
  const periodStart = new Date(now.getTime() - days * DAY_MS);
  const prevStart = new Date(now.getTime() - 2 * days * DAY_MS);

  const [current, previous] = await Promise.all([
    windowCounts(shop, periodStart, now),
    windowCounts(shop, prevStart, periodStart),
  ]);

  const withChange = (key) => ({
    value: current[key],
    changePct: pctChange(current[key], previous[key]),
  });

  return {
    triggers: withChange("triggers"),
    discountsBlocked: withChange("discountsBlocked"),
    quantityViolations: withChange("quantityViolations"),
    checkoutsProtected: withChange("checkoutsProtected"),
  };
}

/** Day-bucketed trigger counts for the rule-activity chart. */
export async function getActivitySeries(shop, days = 30, ruleType = null) {
  const now = new Date();
  const start = new Date(now.getTime() - days * DAY_MS);
  const events = await db.ruleEvent.findMany({
    where: { shop, createdAt: { gte: start }, ...(ruleType ? { ruleType } : {}) },
    select: { createdAt: true },
  });

  const buckets = new Map();
  for (let i = 0; i < days; i++) {
    const key = new Date(start.getTime() + i * DAY_MS).toISOString().slice(0, 10);
    buckets.set(key, 0);
  }
  for (const e of events) {
    const key = e.createdAt.toISOString().slice(0, 10);
    if (buckets.has(key)) buckets.set(key, buckets.get(key) + 1);
  }
  return Array.from(buckets.entries()).map(([date, count]) => ({ date, count }));
}

/** Most recent events for the dashboard's "Recent activity" card and the full Activity page. */
export async function getActivityFeed(shop, { limit = 10, ruleType = null, ruleId = null, since = null } = {}) {
  return db.ruleEvent.findMany({
    where: {
      shop,
      ...(ruleType ? { ruleType } : {}),
      ...(ruleId ? { ruleId } : {}),
      ...(since ? { createdAt: { gte: since } } : {}),
    },
    orderBy: { createdAt: "desc" },
    take: limit,
  });
}

/** Per-rule trigger counts (all time) for the Rules list "Triggers" column. */
export async function getTriggerCountsByRule(shop) {
  const grouped = await db.ruleEvent.groupBy({
    by: ["ruleId"],
    where: { shop },
    _count: { ruleId: true },
  });
  return new Map(grouped.map((g) => [g.ruleId, g._count.ruleId]));
}

export async function hasAnyEvent(shop) {
  const count = await db.ruleEvent.count({ where: { shop } });
  return count > 0;
}

/** Rule events since the start of the current calendar month, for the Billing summary. */
export async function getMonthlyEventCount(shop) {
  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  return db.ruleEvent.count({ where: { shop, createdAt: { gte: monthStart } } });
}
