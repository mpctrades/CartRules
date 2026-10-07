// Plain constants shared by both server code (app/models/rules.server.js)
// and client-rendered route components. Deliberately NOT named `*.server.js`
// — Remix treats that suffix as server-only and strips such modules from the
// client bundle, which breaks any component that imports from it (see the
// "Server-only module referenced by client" build error this file fixes).
export const RULE_TYPES = {
  MAX_QUANTITY: "max_quantity",
  MIN_QUANTITY: "min_quantity",
  NO_DISCOUNT: "no_discount",
  CART_MIN_VALUE: "cart_min_value",
  CART_MAX_VALUE: "cart_max_value",
  QUANTITY_MULTIPLE: "quantity_multiple",
  MAX_CART_ITEMS: "max_cart_items",
  PRODUCT_COMBINATION: "product_combination",
};

// What the merchant picks in step 1 of the rule form. `valueLabel` is the
// field shown in step 3 (null = the type has no number to enter);
// `category` drives the Templates and Analytics groupings.
export const RULE_TYPE_INFO = {
  [RULE_TYPES.MAX_QUANTITY]: {
    title: "Maximum quantity",
    short: "Max quantity",
    description: "Limit how many units customers can buy.",
    valueLabel: "Maximum units per order",
    category: "quantity",
    plan: "Free",
  },
  [RULE_TYPES.MIN_QUANTITY]: {
    title: "Minimum quantity",
    short: "Min quantity",
    description: "Require a minimum purchase quantity.",
    valueLabel: "Minimum units per order",
    category: "quantity",
    plan: "Free",
  },
  [RULE_TYPES.NO_DISCOUNT]: {
    title: "Block discount codes",
    short: "Block discount",
    description: "Prevent discount codes from applying.",
    valueLabel: null,
    category: "discount",
    plan: "Free",
  },
  [RULE_TYPES.CART_MIN_VALUE]: {
    title: "Minimum cart value",
    short: "Min cart value",
    description: "Require a minimum cart amount.",
    valueLabel: "Minimum amount",
    money: true,
    category: "cart",
    plan: "Growth",
  },
  [RULE_TYPES.CART_MAX_VALUE]: {
    title: "Maximum cart value",
    short: "Max cart value",
    description: "Limit the maximum cart amount.",
    valueLabel: "Maximum amount",
    money: true,
    category: "cart",
    plan: "Growth",
  },
  [RULE_TYPES.QUANTITY_MULTIPLE]: {
    title: "Quantity multiples",
    short: "Multiples",
    description: "Require quantities such as 6, 12, 18.",
    valueLabel: "Sold in multiples of",
    category: "quantity",
    plan: "Growth",
  },
  [RULE_TYPES.MAX_CART_ITEMS]: {
    title: "Maximum cart items",
    short: "Max cart items",
    description: "Limit total items in the cart.",
    valueLabel: "Maximum items in cart",
    category: "cart",
    plan: "Growth",
  },
  [RULE_TYPES.PRODUCT_COMBINATION]: {
    title: "Product combination",
    short: "Combination",
    description: "Prevent selected products from being purchased together.",
    valueLabel: null,
    category: "cart",
    plan: "Growth",
  },
};

export const RULE_TYPE_ORDER = Object.keys(RULE_TYPE_INFO);

export const TARGET_TYPES = {
  ALL: "all",
  PRODUCT: "product",
  VARIANT: "variant",
  COLLECTION: "collection",
  TAG: "tag",
  VENDOR: "vendor",
  PRODUCT_TYPE: "product_type",
};

export const TARGET_INFO = {
  [TARGET_TYPES.ALL]: { label: "All products", plan: "Free" },
  [TARGET_TYPES.PRODUCT]: { label: "Specific products", noun: "Products", plan: "Free" },
  [TARGET_TYPES.VARIANT]: { label: "Specific variants", noun: "Variants", plan: "Free" },
  [TARGET_TYPES.COLLECTION]: { label: "Collections", noun: "Collections", plan: "Growth" },
  [TARGET_TYPES.TAG]: { label: "Product tags", noun: "Tags", plan: "Growth" },
  [TARGET_TYPES.VENDOR]: { label: "Product vendor", noun: "Vendors", plan: "Growth" },
  [TARGET_TYPES.PRODUCT_TYPE]: { label: "Product type", noun: "Product types", plan: "Growth" },
};

export const CUSTOMER_TYPES = {
  EVERYONE: "everyone",
  LOGGED_IN: "logged_in",
  GUEST: "guest",
  TAGS: "tags",
  EXCLUDE_TAGS: "exclude_tags",
  B2B: "b2b",
};

export const CUSTOMER_INFO = {
  [CUSTOMER_TYPES.EVERYONE]: "Everyone",
  [CUSTOMER_TYPES.LOGGED_IN]: "Logged-in customers",
  [CUSTOMER_TYPES.GUEST]: "Guest customers",
  [CUSTOMER_TYPES.TAGS]: "Customers with tags",
  [CUSTOMER_TYPES.EXCLUDE_TAGS]: "Everyone except customer tags",
  [CUSTOMER_TYPES.B2B]: "B2B customers",
};

export const MARKET_TYPES = {
  ALL: "all",
  COUNTRIES: "countries",
  MARKETS: "markets",
};

// Extra "AND" conditions (step 3). Each is evaluated by the shared engine
// (extensions/cartrules-validation/src/engine.js). Product conditions are
// checked per cart line; the rest once per cart.
export const CONDITION_FIELDS = {
  product_tag: { label: "Product tag", scope: "line", ops: ["is", "is_not"] },
  product_vendor: { label: "Product vendor", scope: "line", ops: ["is", "is_not"] },
  product_type: { label: "Product type", scope: "line", ops: ["is", "is_not"] },
  customer_tag: { label: "Customer tag", scope: "cart", ops: ["contains", "not_contains"] },
  country: { label: "Country", scope: "cart", ops: ["is", "is_not"] },
  cart_subtotal: { label: "Cart subtotal", scope: "cart", ops: ["gte", "lte"], numeric: true },
};

export const CONDITION_OPS = {
  is: "is",
  is_not: "is not",
  contains: "contains",
  not_contains: "does not contain",
  gte: "is at least",
  lte: "is at most",
};

export const RULE_STATUS = {
  ACTIVE: "active",
  PAUSED: "paused",
  DRAFT: "draft",
};

// What the merchant sees — derived from the stored status plus schedule and
// health (see getRuleHealth in rules.server.js).
export const DISPLAY_STATUS = {
  ACTIVE: "active",
  PAUSED: "paused",
  DRAFT: "draft",
  SCHEDULED: "scheduled",
  ENDED: "ended",
  NEEDS_ATTENTION: "needs_attention",
};

export const DISPLAY_STATUS_INFO = {
  active: { label: "Active", tone: "success" },
  paused: { label: "Paused", tone: undefined },
  draft: { label: "Draft", tone: undefined },
  scheduled: { label: "Scheduled", tone: "info" },
  ended: { label: "Ended", tone: undefined },
  needs_attention: { label: "Needs attention", tone: "warning" },
};

export const CONFLICT_MODES = {
  MOST_RESTRICTIVE: "most_restrictive",
  PRIORITY: "priority",
};

export const MESSAGE_VARIABLES = ["{{product}}", "{{limit}}", "{{quantity}}", "{{collection}}", "{{discount_code}}"];

export const PLAN_RANK = { Free: 0, Growth: 1, Pro: 2 };

/** True when `plan` includes a feature introduced at `required`. */
export function planAllows(plan, required) {
  return (PLAN_RANK[plan] ?? 0) >= (PLAN_RANK[required] ?? 0);
}

/** Positive whole number (quantities, multiples, item counts). */
export function isValidWholeNumber(value) {
  const n = Number(value);
  return Number.isInteger(n) && n >= 1;
}

/** Positive amount (cart value rules). */
export function isValidAmount(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0;
}

// Kept for older imports.
export const isValidMaxQuantity = isValidWholeNumber;
