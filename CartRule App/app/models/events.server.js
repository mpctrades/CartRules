// Rule activity: what CartRules enforced, when, on which rule and product.
// Backed by the RuleEvent table (prisma/schema.prisma). Rows come from:
//  - the storefront (theme blocks → app proxy, app/routes/proxy.events.jsx)
//    whenever a shopper hits a rule on the product or cart page;
//  - the rule simulator ("test" source) — shown in Activity with a Test
//    badge, never counted in KPIs or Analytics.
// A checkout Function can't report what it blocked, so blocks that only
// happen at checkout (theme blocks not installed) aren't recorded — the
// Activity and Analytics pages say so.
//
// Privacy: no customer name, email, address or id is ever stored. cartKey
// is a one-way hash used only to count distinct carts.

import crypto from "node:crypto";
import db from "../db.server";

const DAY_MS = 24 * 60 * 60 * 1000;

// Violation rule type -> event type shown in Activity.
export const EVENT_TYPE_BY_RULE_TYPE = {
  max_quantity: "quantity_blocked",
  min_quantity: "minimum_not_met",
  quantity_multiple: "multiple_not_met",
  no_discount: "discount_blocked",
  cart_min_value: "minimum_cart_not_met",
  cart_max_value: "maximum_cart_value_blocked",
  max_cart_items: "max_items_blocked",
  product_combination: "combination_blocked",
};

export const QUANTITY_EVENTS = ["quantity_blocked", "minimum_not_met", "multiple_not_met", "max_items_blocked"];
export const DISCOUNT_EVENTS = ["discount_blocked"];
export const CART_EVENTS = ["minimum_cart_not_met", "maximum_cart_value_blocked", "combination_blocked"];
const BLOCKING_EVENTS = [...QUANTITY_EVENTS, ...DISCOUNT_EVENTS, ...CART_EVENTS, "checkout_blocked"];

// How far back each plan can look (matches Plan & billing copy).
export const HISTORY_DAYS = { Free: 7, Growth: 90, Pro: 365 };

export function hashCartKey(shop, token) {
  if (!token) return null;
  return crypto.createHash("sha256").update(`${shop}:${token}`).digest("hex").slice(0, 24);
}

/** Inserts events. Each: { ruleId, ruleTitle, ruleType, eventType, source, productId?, productTitle?, attempted?, allowed?, cartKey?, detail? } */
export async function recordEvents(shop, events) {
  const rows = (events ?? [])
    .filter((e) => e?.ruleId && e.eventType)
    .map((e) => ({
      shop,
      ruleId: String(e.ruleId),
      ruleTitle: String(e.ruleTitle ?? "").slice(0, 200) || "Rule",
      ruleType: String(e.ruleType ?? ""),
      eventType: String(e.eventType),
      source: e.source ?? "storefront",
      orderId: "",
      productId: e.productId ? String(e.productId) : null,
      productTitle: e.productTitle ? String(e.productTitle).slice(0, 200) : null,
      attempted: Number.isFinite(Number(e.attempted)) && e.attempted !== null ? Number(e.attempted) : null,
      allowed: Number.isFinite(Number(e.allowed)) && e.allowed !== null ? Number(e.allowed) : null,
      cartKey: e.cartKey ?? null,
      detail: e.detail ? String(e.detail).slice(0, 300) : null,
    }));
  if (rows.length === 0) return 0;
  await db.ruleEvent.createMany({ data: rows });
  return rows.length;
}

function clampDays(days, plan) {
  const max = HISTORY_DAYS[plan] ?? HISTORY_DAYS.Free;
  const n = Number(days) || 30;
  return Math.max(1, Math.min(n, max));
}

/** { start, end, days } for a preset (7/30/90) or custom range, clamped to the plan's history. */
export function resolveRange({ days, from, to }, plan, now = new Date()) {
  const maxDays = HISTORY_DAYS[plan] ?? HISTORY_DAYS.Free;
  const earliest = new Date(now.getTime() - maxDays * DAY_MS);
  if (from) {
    let start = new Date(`${from}T00:00:00Z`);
    let end = to ? new Date(`${to}T23:59:59.999Z`) : now;
    if (!Number.isFinite(start.getTime())) start = earliest;
    if (!Number.isFinite(end.getTime()) || end > now) end = now;
    if (start < earliest) start = earliest;
    if (end < start) end = start;
    return { start, end, days: Math.max(1, Math.ceil((end - start) / DAY_MS)), custom: true, clamped: maxDays };
  }
  const d = clampDays(days, plan);
  return { start: new Date(now.getTime() - d * DAY_MS), end: now, days: d, custom: false, clamped: maxDays };
}

function liveWhere(shop, start, end, extra = {}) {
  return { shop, source: { not: "test" }, createdAt: { gte: start, lt: end }, ...extra };
}

function pctChange(current, previous) {
  if (previous === 0) return current === 0 ? 0 : null; // null = no baseline
  return Math.round(((current - previous) / previous) * 100);
}

async function windowCounts(shop, start, end, ruleIds) {
  const events = await db.ruleEvent.findMany({
    where: liveWhere(shop, start, end, ruleIds ? { ruleId: { in: ruleIds } } : {}),
    select: { eventType: true, cartKey: true, orderId: true },
  });
  const blocking = events.filter((e) => BLOCKING_EVENTS.includes(e.eventType));
  return {
    triggers: blocking.length,
    discountsBlocked: blocking.filter((e) => DISCOUNT_EVENTS.includes(e.eventType)).length,
    quantityViolations: blocking.filter((e) => QUANTITY_EVENTS.includes(e.eventType)).length,
    checkoutsProtected: new Set(blocking.map((e) => e.cartKey || e.orderId).filter(Boolean)).size,
  };
}

/** KPI cards: the range vs the equal range before it. */
export async function getKpis(shop, range, { ruleIds = null } = {}) {
  const span = range.end.getTime() - range.start.getTime();
  const prevStart = new Date(range.start.getTime() - span);
  const [current, previous] = await Promise.all([
    windowCounts(shop, range.start, range.end, ruleIds),
    windowCounts(shop, prevStart, range.start, ruleIds),
  ]);
  const withChange = (key) => ({ value: current[key], changePct: pctChange(current[key], previous[key]) });
  return {
    triggers: withChange("triggers"),
    discountsBlocked: withChange("discountsBlocked"),
    quantityViolations: withChange("quantityViolations"),
    checkoutsProtected: withChange("checkoutsProtected"),
  };
}

/**
 * Category filter for charts/feeds: quantity / discount / cart use event
 * types; customer = events from rules that have customer conditions
 * (the caller passes those rule ids).
 */
export function categoryWhere(category, customerRuleIds = []) {
  if (category === "quantity") return { eventType: { in: QUANTITY_EVENTS } };
  if (category === "discount") return { eventType: { in: DISCOUNT_EVENTS } };
  if (category === "cart") return { eventType: { in: CART_EVENTS } };
  if (category === "customer") return { ruleId: { in: customerRuleIds } };
  return {};
}

/** Day-bucketed counts for the activity charts. */
export async function getActivitySeries(shop, range, { category = "all", customerRuleIds = [], ruleIds = null } = {}) {
  const events = await db.ruleEvent.findMany({
    where: liveWhere(shop, range.start, range.end, {
      eventType: { in: BLOCKING_EVENTS },
      ...categoryWhere(category, customerRuleIds),
      ...(ruleIds ? { ruleId: { in: ruleIds } } : {}),
    }),
    select: { createdAt: true },
  });
  const buckets = new Map();
  const startDay = Date.UTC(range.start.getUTCFullYear(), range.start.getUTCMonth(), range.start.getUTCDate());
  for (let t = startDay; t <= range.end.getTime(); t += DAY_MS) {
    buckets.set(new Date(t).toISOString().slice(0, 10), 0);
  }
  for (const e of events) {
    const key = e.createdAt.toISOString().slice(0, 10);
    if (buckets.has(key)) buckets.set(key, buckets.get(key) + 1);
  }
  return Array.from(buckets.entries()).map(([date, count]) => ({ date, count }));
}

/** Analytics breakdowns: top rules, top products, rule-type mix. */
export async function getBreakdowns(shop, range, { ruleIds = null } = {}) {
  const where = liveWhere(shop, range.start, range.end, {
    eventType: { in: BLOCKING_EVENTS },
    ...(ruleIds ? { ruleId: { in: ruleIds } } : {}),
  });
  const [byRule, byProduct, byType] = await Promise.all([
    db.ruleEvent.groupBy({ by: ["ruleId", "ruleTitle"], where, _count: { _all: true } }),
    db.ruleEvent.groupBy({
      by: ["productId", "productTitle"],
      where: { ...where, productId: { not: null } },
      _count: { _all: true },
    }),
    db.ruleEvent.groupBy({ by: ["ruleType"], where, _count: { _all: true } }),
  ]);
  const top = (rows, n) => rows.sort((a, b) => b._count._all - a._count._all).slice(0, n);
  // A rule renamed mid-range shows up under each title — merge by id.
  const rules = new Map();
  for (const r of byRule) {
    const cur = rules.get(r.ruleId) ?? { ruleId: r.ruleId, title: r.ruleTitle, count: 0 };
    cur.count += r._count._all;
    rules.set(r.ruleId, cur);
  }
  const products = new Map();
  for (const p of byProduct) {
    const cur = products.get(p.productId) ?? { productId: p.productId, title: p.productTitle, count: 0 };
    cur.count += p._count._all;
    products.set(p.productId, cur);
  }
  return {
    topRules: [...rules.values()].sort((a, b) => b.count - a.count).slice(0, 5),
    topProducts: [...products.values()].sort((a, b) => b.count - a.count).slice(0, 5),
    byType: top(byType, 10).map((t) => ({ ruleType: t.ruleType, count: t._count._all })),
  };
}

/**
 * Activity feed with filters. `result`: "blocked" | "passed" | "all".
 * Returns { events, total }.
 */
export async function getActivityFeed(
  shop,
  { range = null, ruleId = null, eventType = null, result = "all", search = "", source = null, limit = 25, offset = 0 } = {},
) {
  const where = {
    shop,
    ...(range ? { createdAt: { gte: range.start, lt: range.end } } : {}),
    ...(ruleId ? { ruleId } : {}),
    ...(eventType ? { eventType } : {}),
    ...(source ? { source } : {}),
    // A chosen event type must also match the result filter (e.g. "Rule
    // passed" + "Blocked" is an empty set, not "Rule passed").
    ...(result === "blocked"
      ? { eventType: eventType ? (BLOCKING_EVENTS.includes(eventType) ? eventType : "__none__") : { in: BLOCKING_EVENTS } }
      : {}),
    ...(result === "passed" ? { eventType: !eventType || eventType === "rule_passed" ? "rule_passed" : "__none__" } : {}),
    ...(search
      ? { OR: [{ ruleTitle: { contains: search } }, { productTitle: { contains: search } }, { detail: { contains: search } }] }
      : {}),
  };
  const [events, total] = await Promise.all([
    db.ruleEvent.findMany({ where, orderBy: { createdAt: "desc" }, take: limit, skip: offset }),
    db.ruleEvent.count({ where }),
  ]);
  return { events, total };
}

/** Per-rule counts in the plan's history window, for the Rules table "Activity" column. */
export async function getTriggerCountsByRule(shop, plan) {
  const since = new Date(Date.now() - (HISTORY_DAYS[plan] ?? HISTORY_DAYS.Free) * DAY_MS);
  const grouped = await db.ruleEvent.groupBy({
    by: ["ruleId"],
    where: { shop, source: { not: "test" }, eventType: { in: BLOCKING_EVENTS }, createdAt: { gte: since } },
    _count: { _all: true },
  });
  return Object.fromEntries(grouped.map((g) => [g.ruleId, g._count._all]));
}

export async function hasAnyEvent(shop, { includeTests = true } = {}) {
  const count = await db.ruleEvent.count({ where: { shop, ...(includeTests ? {} : { source: { not: "test" } }) } });
  return count > 0;
}

/** Rule events this calendar month (UTC), for the Billing summary. */
export async function getMonthlyEventCount(shop) {
  const now = new Date();
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  return db.ruleEvent.count({
    where: { shop, source: { not: "test" }, eventType: { in: BLOCKING_EVENTS }, createdAt: { gte: monthStart } },
  });
}

/** Removes events older than the longest history any plan offers. */
export async function purgeOldEvents() {
  const cutoff = new Date(Date.now() - (HISTORY_DAYS.Pro + 30) * DAY_MS);
  const { count } = await db.ruleEvent.deleteMany({ where: { createdAt: { lt: cutoff } } });
  return count;
}

export async function deleteShopEvents(shop) {
  await db.ruleEvent.deleteMany({ where: { shop } });
  await db.shopState.deleteMany({ where: { shop } });
}
