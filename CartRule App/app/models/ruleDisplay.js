// Client-safe helpers that turn a normalized rule (see ruleFromMetaobject in
// rules.server.js) into what the merchant reads: status, target summary,
// one-line description. Shared by the Overview, Rules, Activity and
// Analytics pages so every screen words a rule the same way.
import {
  RULE_TYPE_INFO,
  RULE_TYPES,
  RULE_STATUS,
  TARGET_TYPES,
  TARGET_INFO,
  CUSTOMER_TYPES,
  CUSTOMER_INFO,
  DISPLAY_STATUS,
} from "./ruleConstants";

/** Active / Paused / Draft / Scheduled / Ended — before health is considered. */
export function getScheduleStatus(rule, now = Date.now()) {
  if (rule.status === RULE_STATUS.DRAFT) return DISPLAY_STATUS.DRAFT;
  if (rule.status !== RULE_STATUS.ACTIVE) return DISPLAY_STATUS.PAUSED;
  const start = rule.schedule?.startsAt ? Date.parse(rule.schedule.startsAt) : null;
  const end = rule.schedule?.endsAt ? Date.parse(rule.schedule.endsAt) : null;
  if (end != null && end <= now) return DISPLAY_STATUS.ENDED;
  if (start != null && start > now) return DISPLAY_STATUS.SCHEDULED;
  return DISPLAY_STATUS.ACTIVE;
}

/** True when the rule is enforced at checkout right now. */
export function isLive(rule, now = Date.now()) {
  return getScheduleStatus(rule, now) === DISPLAY_STATUS.ACTIVE;
}

/** Final status: health issues on an otherwise live/scheduled rule win. */
export function getDisplayStatus(rule, health, now = Date.now()) {
  const base = getScheduleStatus(rule, now);
  if (health?.issues?.length && (base === DISPLAY_STATUS.ACTIVE || base === DISPLAY_STATUS.SCHEDULED)) {
    return DISPLAY_STATUS.NEEDS_ATTENTION;
  }
  return base;
}

function listLabel(values, labels) {
  const shown = (labels?.length ? labels : values) ?? [];
  if (shown.length === 0) return "";
  if (shown.length === 1) return String(shown[0]);
  return `${shown[0]} +${shown.length - 1} more`;
}

/** "Tag: Snow", "All products", "Collection: Premium +1 more". */
export function describeTarget(target) {
  if (!target || target.type === TARGET_TYPES.ALL) return "All products";
  const noun = {
    [TARGET_TYPES.PRODUCT]: "Product",
    [TARGET_TYPES.VARIANT]: "Variant",
    [TARGET_TYPES.COLLECTION]: "Collection",
    [TARGET_TYPES.TAG]: "Tag",
    [TARGET_TYPES.VENDOR]: "Vendor",
    [TARGET_TYPES.PRODUCT_TYPE]: "Type",
  }[target.type];
  const plural = (target.values?.length ?? 0) > 1 ? "s" : "";
  return `${noun ?? TARGET_INFO[target.type]?.label ?? "Target"}${plural}: ${listLabel(target.values, target.labels)}`;
}

export function formatMoney(value, currency) {
  const n = Number(value);
  if (!Number.isFinite(n)) return String(value ?? "");
  try {
    return new Intl.NumberFormat(undefined, { style: "currency", currency: currency || "USD" }).format(n);
  } catch (_e) {
    return `${n.toFixed(2)} ${currency ?? ""}`.trim();
  }
}

/** "Limit 1 per order on Snow-tagged products" style summary line. */
export function describeRule(rule, currency) {
  const target = describeTarget(rule.target);
  const scope = rule.target?.type === TARGET_TYPES.ALL ? "all products" : target;
  const v = rule.value;
  switch (rule.ruleType) {
    case RULE_TYPES.MAX_QUANTITY:
      return `Maximum ${v} per order · ${scope}`;
    case RULE_TYPES.MIN_QUANTITY:
      return `Minimum ${v} per order · ${scope}`;
    case RULE_TYPES.NO_DISCOUNT:
      return `Discount codes blocked · ${scope}`;
    case RULE_TYPES.CART_MIN_VALUE:
      return `Cart must be at least ${formatMoney(v, currency)} · ${scope}`;
    case RULE_TYPES.CART_MAX_VALUE:
      return `Cart can't exceed ${formatMoney(v, currency)} · ${scope}`;
    case RULE_TYPES.QUANTITY_MULTIPLE:
      return `Sold in multiples of ${v} · ${scope}`;
    case RULE_TYPES.MAX_CART_ITEMS:
      return `At most ${v} items in cart · ${scope}`;
    case RULE_TYPES.PRODUCT_COMBINATION:
      return `${target} can't be bought with ${describeTarget(rule.comboTarget)}`;
    default:
      return target;
  }
}

export function describeCustomer(customer) {
  if (!customer || customer.type === CUSTOMER_TYPES.EVERYONE) return "Everyone";
  if (customer.type === CUSTOMER_TYPES.TAGS) return `Customers tagged ${customer.tags?.join(", ")}`;
  if (customer.type === CUSTOMER_TYPES.EXCLUDE_TAGS) return `Except customers tagged ${customer.tags?.join(", ")}`;
  return CUSTOMER_INFO[customer.type] ?? "Everyone";
}

export function ruleTypeLabel(type) {
  return RULE_TYPE_INFO[type]?.title ?? type;
}

/** "Nov 20, 2026, 00:00" in the shop's timezone. */
export function formatDateTime(iso, timeZone) {
  if (!iso) return "";
  try {
    return new Intl.DateTimeFormat(undefined, {
      dateStyle: "medium",
      timeStyle: "short",
      hour12: false,
      ...(timeZone ? { timeZone } : {}),
    }).format(new Date(iso));
  } catch (_e) {
    return new Date(iso).toISOString();
  }
}

export function timeAgo(iso, now = Date.now()) {
  const diff = Math.max(0, now - Date.parse(iso));
  const min = Math.round(diff / 60000);
  if (min < 1) return "Just now";
  if (min < 60) return `${min} min ago`;
  const h = Math.round(min / 60);
  if (h < 24) return `${h} h ago`;
  const d = Math.round(h / 24);
  return d === 1 ? "Yesterday" : `${d} days ago`;
}

// Activity event types (see EVENT_TYPE_BY_RULE_TYPE in events.server.js).
export const EVENT_LABELS = {
  quantity_blocked: "Quantity limit triggered",
  minimum_not_met: "Minimum not met",
  multiple_not_met: "Quantity multiple not met",
  discount_blocked: "Discount blocked",
  minimum_cart_not_met: "Cart minimum not met",
  maximum_cart_value_blocked: "Maximum cart value blocked",
  max_items_blocked: "Too many items in cart",
  combination_blocked: "Product combination blocked",
  checkout_blocked: "Checkout blocked",
  rule_passed: "Rule passed",
};

/** "Customer attempted 4 units · Allowed: 1" / "Code SAVE20 was rejected" style line. */
export function describeEvent(event, currency) {
  const money = event.ruleType === "cart_min_value" || event.ruleType === "cart_max_value";
  const fmt = (n) => (money ? formatMoney(n, currency) : String(n));
  if (event.eventType === "discount_blocked") {
    return event.detail?.startsWith("Code ") ? `${event.detail} was rejected` : "Discount code rejected";
  }
  if (event.attempted != null && event.allowed != null) {
    if (money) return `Cart total ${fmt(event.attempted)} · Limit ${fmt(event.allowed)}`;
    return `Customer attempted ${fmt(event.attempted)} ${event.attempted === 1 ? "unit" : "units"} · Allowed: ${fmt(event.allowed)}`;
  }
  return event.detail ?? "";
}
