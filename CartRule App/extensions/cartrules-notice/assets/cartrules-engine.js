// GENERATED from extensions/cartrules-validation/src/engine.js by scripts/sync-engine.mjs — do not edit.
// CartRules rule engine — the ONE place rule logic lives.
//
// Used by:
//  - the checkout Function (./index.js), which turns its GraphQL input into
//    the normalized cart below and blocks checkout on any violation;
//  - the admin app's rule simulator (app/models/simulator.server.js), which
//    builds the same normalized cart from real product data, so "Test a rule"
//    shows exactly what checkout would do.
//
// Pure JavaScript, no imports, no Date/Math.random — it has to run inside
// the Function's WebAssembly sandbox too.
//
// Normalized cart:
// {
//   lines: [{ productId, variantId, title, vendor, productType,
//             tags: string[] (lowercased, only tags some rule asks about),
//             collections: string[] (collection GIDs, same restriction),
//             quantity, subtotal, hasDiscount }],
//   customer: { loggedIn, b2b, tags: string[] (lowercased) },
//   country: "US" | null,
//   subtotal: number,
//   currency: "USD" | null,
//   discountCode: string | null,
// }
//
// Rule (as cached in the `cartrules.rules_cache` metafield, see
// buildRulesCache in app/models/rules.server.js):
// {
//   id, type, value, msg, priority,
//   target: { type, values: [] }, targetLabel,
//   comboTarget: { type, values: [] },          // product_combination only
//   customer: { type, tags: [] },
//   countries: ["US", ...] | null,
//   conditions: [{ field, op, value }],
// }

const QUANTITY_TYPES = ["max_quantity", "min_quantity", "quantity_multiple"];

function lower(value) {
  return String(value == null ? "" : value).trim().toLowerCase();
}

function numericId(gid) {
  const s = String(gid == null ? "" : gid);
  const i = s.lastIndexOf("/");
  return i === -1 ? s : s.slice(i + 1);
}

function includesLower(list, value) {
  const v = lower(value);
  for (const item of list || []) if (lower(item) === v) return true;
  return false;
}

function anyShared(list, wanted) {
  for (const w of wanted || []) if (includesLower(list, w)) return true;
  return false;
}

/** Does this cart line belong to the rule's target? */
export function lineMatchesTarget(line, target) {
  const type = target && target.type ? target.type : "all";
  const values = (target && target.values) || [];
  switch (type) {
    case "all":
      return true;
    case "product":
      return values.some((v) => numericId(v) === numericId(line.productId));
    case "variant":
      return values.some((v) => numericId(v) === numericId(line.variantId));
    case "collection":
      return values.some((v) => (line.collections || []).includes(v));
    case "tag":
      return anyShared(line.tags, values);
    case "vendor":
      return includesLower(values, line.vendor);
    case "product_type":
      return includesLower(values, line.productType);
    default:
      return false;
  }
}

function lineConditionsPass(line, conditions) {
  for (const c of conditions || []) {
    let hit;
    if (c.field === "product_tag") hit = includesLower(line.tags, c.value);
    else if (c.field === "product_vendor") hit = lower(line.vendor) === lower(c.value);
    else if (c.field === "product_type") hit = lower(line.productType) === lower(c.value);
    else continue;
    if (c.op === "is_not" ? hit : !hit) return false;
  }
  return true;
}

function cartConditionsPass(cart, conditions) {
  for (const c of conditions || []) {
    if (c.field === "customer_tag") {
      const hit = includesLower(cart.customer && cart.customer.tags, c.value);
      if (c.op === "not_contains" ? hit : !hit) return false;
    } else if (c.field === "country") {
      const hit = lower(cart.country) === lower(c.value);
      if (c.op === "is_not" ? hit : !hit) return false;
    } else if (c.field === "cart_subtotal") {
      const amount = Number(c.value);
      if (!Number.isFinite(amount)) continue;
      if (c.op === "gte" && !(cart.subtotal >= amount)) return false;
      if (c.op === "lte" && !(cart.subtotal <= amount)) return false;
    }
  }
  return true;
}

/** Customer, market and cart-level conditions — does the rule apply to this cart at all? */
export function cartQualifies(rule, cart) {
  const customer = cart.customer || {};
  const cond = rule.customer || { type: "everyone" };
  switch (cond.type) {
    case "logged_in":
      if (!customer.loggedIn) return false;
      break;
    case "guest":
      if (customer.loggedIn) return false;
      break;
    case "b2b":
      if (!customer.b2b) return false;
      break;
    case "tags":
      if (!anyShared(customer.tags, cond.tags)) return false;
      break;
    case "exclude_tags":
      if (anyShared(customer.tags, cond.tags)) return false;
      break;
    default:
      break;
  }
  if (Array.isArray(rule.countries) && rule.countries.length > 0) {
    if (!cart.country || !includesLower(rule.countries, cart.country)) return false;
  }
  return cartConditionsPass(cart, rule.conditions);
}

function lineQualifies(rule, line) {
  return lineMatchesTarget(line, rule.target) && lineConditionsPass(line, rule.conditions);
}

/**
 * Product page: does this rule apply to this product for this shopper?
 * Cart-subtotal conditions are skipped (there's no cart total yet).
 */
export function ruleAppliesToProduct(rule, line, context) {
  const conditions = (rule.conditions || []).filter((c) => c.field !== "cart_subtotal");
  const cart = { lines: [line], customer: context.customer || {}, country: context.country || null, subtotal: NaN };
  if (!cartQualifies({ ...rule, conditions }, cart)) return false;
  if (rule.type === "product_combination") {
    return lineMatchesTarget(line, rule.target) || lineMatchesTarget(line, rule.comboTarget);
  }
  return lineQualifies({ ...rule, conditions }, line);
}

function formatAmount(value, currency) {
  const n = Number(value);
  const text = Number.isFinite(n) ? n.toFixed(2) : String(value);
  return currency ? `${text} ${currency}` : text;
}

export const FALLBACK_MESSAGES = {
  max_quantity: "You can purchase a maximum of {{limit}} of {{product}}.",
  min_quantity: "{{product}} has a minimum order quantity of {{limit}}.",
  no_discount: "Discount codes can't be used on {{product}}.",
  cart_min_value: "Your cart must be at least {{limit}} to check out.",
  cart_max_value: "Your cart can't be more than {{limit}}.",
  quantity_multiple: "{{product}} is sold in multiples of {{limit}}.",
  max_cart_items: "Your cart can contain at most {{limit}} items.",
  product_combination: "{{product}} can't be purchased together with the other items in your cart.",
};

/** Fills {{product}}, {{limit}}, {{quantity}}, {{collection}}, {{discount_code}}. */
export function renderMessage(template, vars) {
  const text = template && String(template).trim() ? String(template) : FALLBACK_MESSAGES[vars.type] || "";
  return text.replace(/\{\{\s*(product|limit|quantity|collection|discount_code)\s*\}\}/g, (_m, key) => {
    const value = vars[key];
    return value == null || value === "" ? DEFAULT_VARS[key] : String(value);
  });
}

const DEFAULT_VARS = {
  product: "this item",
  limit: "",
  quantity: "",
  collection: "these products",
  discount_code: "your discount code",
};

function groupKey(rule, line) {
  return rule.target && rule.target.type === "variant" ? `v:${numericId(line.variantId)}` : `p:${numericId(line.productId)}`;
}

/**
 * For quantity rules: when several rules of the same type claim the same
 * product, only one may apply. "most_restrictive" keeps the lowest max /
 * highest min / largest multiple; "priority" keeps the highest priority rule
 * (ties fall back to most restrictive).
 */
function better(type, a, b, mode) {
  if (mode === "priority") {
    const pa = Number(a.rule.priority) || 0;
    const pb = Number(b.rule.priority) || 0;
    if (pa !== pb) return pa > pb ? a : b;
  }
  const va = Number(a.rule.value);
  const vb = Number(b.rule.value);
  if (type === "max_quantity") return vb < va ? b : a;
  return vb > va ? b : a;
}

/**
 * Runs every rule against the cart.
 * Returns { violations: [...], matches: [...] } where `matches` lists every
 * rule that applied to the cart (violated or not) — the simulator shows it.
 */
export function evaluateCart(cart, rules, options) {
  const mode = (options && options.conflictMode) || "most_restrictive";
  const violations = [];
  const matches = [];
  const lines = cart.lines || [];
  const currency = cart.currency || null;

  // Quantity rules: collect per (type, product) claims first, resolve conflicts.
  const claims = new Map();
  for (const rule of rules || []) {
    if (!rule || !rule.type) continue;
    if (!cartQualifies(rule, cart)) continue;

    if (QUANTITY_TYPES.includes(rule.type)) {
      const value = Number(rule.value);
      if (!(value >= 1)) continue;
      const groups = new Map();
      for (const line of lines) {
        if (!lineQualifies(rule, line)) continue;
        const key = groupKey(rule, line);
        const g = groups.get(key) || { quantity: 0, line };
        g.quantity += Number(line.quantity) || 0;
        groups.set(key, g);
      }
      for (const [key, g] of groups) {
        const claimKey = `${rule.type}|${key}`;
        const candidate = { rule, quantity: g.quantity, line: g.line };
        const current = claims.get(claimKey);
        if (!current) {
          claims.set(claimKey, candidate);
          continue;
        }
        const winner = better(rule.type, current, candidate, mode);
        const loser = winner === current ? candidate : current;
        claims.set(claimKey, winner);
        matches.push({
          ruleId: loser.rule.id,
          type: rule.type,
          productId: g.line.productId,
          overriddenBy: winner.rule.id,
        });
      }
      continue;
    }

    const matched = lines.filter((line) => lineQualifies(rule, line));

    if (rule.type === "no_discount") {
      for (const line of matched) {
        matches.push({ ruleId: rule.id, type: rule.type, productId: line.productId });
        if (!line.hasDiscount) continue;
        violations.push({
          ruleId: rule.id,
          type: rule.type,
          productId: line.productId,
          productTitle: line.title,
          attempted: null,
          allowed: null,
          message: renderMessage(rule.msg, {
            type: rule.type,
            product: line.title,
            collection: rule.targetLabel,
            discount_code: cart.discountCode,
            quantity: line.quantity,
          }),
        });
      }
      continue;
    }

    if (rule.type === "cart_min_value" || rule.type === "cart_max_value" || rule.type === "max_cart_items") {
      if (matched.length === 0) continue;
      const isAll = !rule.target || rule.target.type === "all";
      const amount =
        rule.type === "max_cart_items"
          ? matched.reduce((sum, l) => sum + (Number(l.quantity) || 0), 0)
          : isAll && Number.isFinite(cart.subtotal)
            ? cart.subtotal
            : matched.reduce((sum, l) => sum + (Number(l.subtotal) || 0), 0);
      const limit = Number(rule.value);
      if (!Number.isFinite(limit)) continue;
      matches.push({ ruleId: rule.id, type: rule.type, productId: null });
      const broken =
        rule.type === "cart_min_value" ? amount < limit : amount > limit;
      if (!broken) continue;
      const money = rule.type !== "max_cart_items";
      violations.push({
        ruleId: rule.id,
        type: rule.type,
        productId: null,
        productTitle: null,
        attempted: money ? Math.round(amount * 100) / 100 : amount,
        allowed: limit,
        message: renderMessage(rule.msg, {
          type: rule.type,
          limit: money ? formatAmount(limit, currency) : limit,
          quantity: money ? formatAmount(amount, currency) : amount,
          collection: rule.targetLabel,
        }),
      });
      continue;
    }

    if (rule.type === "product_combination") {
      const groupB = lines.filter((line) => lineMatchesTarget(line, rule.comboTarget));
      if (matched.length === 0 || groupB.length === 0) continue;
      // The same line on both sides isn't a combination.
      const pair = matched.find((a) => groupB.some((b) => b !== a));
      matches.push({ ruleId: rule.id, type: rule.type, productId: matched[0].productId });
      if (!pair) continue;
      violations.push({
        ruleId: rule.id,
        type: rule.type,
        productId: pair.productId,
        productTitle: pair.title,
        attempted: null,
        allowed: null,
        message: renderMessage(rule.msg, { type: rule.type, product: pair.title, collection: rule.targetLabel }),
      });
    }
  }

  for (const claim of claims.values()) {
    const { rule, quantity, line } = claim;
    const limit = Number(rule.value);
    matches.push({ ruleId: rule.id, type: rule.type, productId: line.productId });
    let broken = false;
    if (rule.type === "max_quantity") broken = quantity > limit;
    else if (rule.type === "min_quantity") broken = quantity > 0 && quantity < limit;
    else if (rule.type === "quantity_multiple") broken = quantity % limit !== 0;
    if (!broken) continue;
    violations.push({
      ruleId: rule.id,
      type: rule.type,
      productId: line.productId,
      productTitle: line.title,
      attempted: quantity,
      allowed: limit,
      message: renderMessage(rule.msg, {
        type: rule.type,
        product: line.title,
        limit,
        quantity,
        collection: rule.targetLabel,
      }),
    });
  }

  return { violations, matches };
}

/** Every product tag / collection / customer tag the rules ask about — the Function's input variables. */
export function collectInputVariables(rules) {
  const productTags = new Set();
  const collectionIds = new Set();
  const customerTags = new Set();
  const addTarget = (target) => {
    if (!target) return;
    if (target.type === "tag") for (const v of target.values || []) productTags.add(String(v));
    if (target.type === "collection") for (const v of target.values || []) collectionIds.add(String(v));
  };
  for (const rule of rules || []) {
    addTarget(rule.target);
    addTarget(rule.comboTarget);
    for (const c of rule.conditions || []) {
      if (c.field === "product_tag") productTags.add(String(c.value));
      if (c.field === "customer_tag") customerTags.add(String(c.value));
    }
    if (rule.customer && (rule.customer.type === "tags" || rule.customer.type === "exclude_tags")) {
      for (const t of rule.customer.tags || []) customerTags.add(String(t));
    }
  }
  return {
    productTags: [...productTags],
    collectionIds: [...collectionIds],
    customerTags: [...customerTags],
  };
}
