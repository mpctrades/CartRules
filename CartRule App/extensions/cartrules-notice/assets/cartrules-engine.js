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
//   exempt: ["cartrules-exempt", ...],          // customer tags that skip the rule
//   countries: ["US", ...] | null,
//   conditions: [{ field, op, value }],
// }
//
// Target type "mixed" (group_limit rules) mixes products, collections and
// tags in one list: values are "product:<id>", "collection:<gid>",
// "tag:<tag>". A line matching several of them is still one line.

const QUANTITY_TYPES = ["max_quantity", "min_quantity", "quantity_multiple"];

function lower(value) {
  return String(value == null ? "" : value).trim().toLowerCase();
}

function numericId(gid) {
  const s = String(gid == null ? "" : gid);
  const i = s.lastIndexOf("/");
  return i === -1 ? s : s.slice(i + 1);
}

// Lookups below are memoized: inside the Function's WebAssembly sandbox
// every string op is expensive, and re-normalizing each rule's ID/tag lists
// for every cart line blew Shopify's 11M-instruction budget on carts with
// ~10+ lines and product-targeted rules (InstructionCountLimitExceededError).
// Rules and lines aren't mutated during an evaluation, so caching by object
// identity is safe; WeakMaps let the admin simulator's objects be collected.
const lowerSets = new WeakMap();
const idSets = new WeakMap();

/** Lowercased Set of a list, built once per list object. */
function lowerSet(list) {
  if (!list || typeof list !== "object") return new Set();
  let set = lowerSets.get(list);
  if (!set) {
    set = new Set();
    for (const item of list) set.add(lower(item));
    lowerSets.set(list, set);
  }
  return set;
}

/**
 * Set of the IDs in a list, built once per list object. Holds each ID's
 * numeric form AND its Product / ProductVariant GID, so a cart line's ID can
 * be looked up as it comes ("gid://shopify/Product/1" in the Function and the
 * admin, "1" in the theme) without slicing a string per line.
 */
function idSet(list) {
  if (!list || typeof list !== "object") return new Set();
  let set = idSets.get(list);
  if (!set) {
    set = new Set();
    for (const v of list) {
      const n = numericId(v);
      set.add(n);
      set.add("gid://shopify/Product/" + n);
      set.add("gid://shopify/ProductVariant/" + n);
    }
    idSets.set(list, set);
  }
  return set;
}

/** Is this product / variant ID (GID or numeric, string or number) in an idSet? */
function idIn(set, raw) {
  if (set.size === 0) return false;
  if (set.has(raw)) return true;
  // A Product/ProductVariant GID misses only when it really isn't listed;
  // anything else (numbers, other GID shapes) is compared by numeric ID.
  if (typeof raw === "string" && raw.charCodeAt(0) === 103 && raw.lastIndexOf("gid://shopify/Product", 0) === 0) return false;
  return set.has(numericId(raw));
}

/** Plain Set of a list (collection GIDs), built once per list object. */
const plainSets = new WeakMap();
function plainSet(list) {
  if (!list || typeof list !== "object") return new Set();
  let set = plainSets.get(list);
  if (!set) {
    set = new Set(list);
    plainSets.set(list, set);
  }
  return set;
}

/** Does any of the line's tags (any case) appear in this lowercased Set? */
function tagIn(set, tags) {
  if (set.size === 0 || !tags) return false;
  for (const t of tags) if (set.has(lower(t))) return true;
  return false;
}

/** Is the line in any collection of this Set? */
function collectionIn(set, collections) {
  if (set.size === 0 || !collections) return false;
  for (const c of collections) if (set.has(c)) return true;
  return false;
}

const mixedParts = new WeakMap();

/** { product: Set<numeric id>, collection: Set<gid>, tag: Set<lowercase> } of a mixed target. */
function mixedSets(values) {
  if (!values || typeof values !== "object") return { product: new Set(), collection: new Set(), tag: new Set() };
  let parts = mixedParts.get(values);
  if (!parts) {
    parts = { product: new Set(), collection: new Set(), tag: new Set() };
    for (const raw of values) {
      const v = String(raw == null ? "" : raw);
      const i = v.indexOf(":");
      if (i === -1) continue;
      const kind = v.slice(0, i);
      const rest = v.slice(i + 1);
      if (kind === "product") {
        const n = numericId(rest);
        parts.product.add(n);
        parts.product.add("gid://shopify/Product/" + n);
      }
      else if (kind === "collection") parts.collection.add(rest);
      else if (kind === "tag") parts.tag.add(lower(rest));
    }
    mixedParts.set(values, parts);
  }
  return parts;
}

function lineMatchesMixed(line, values) {
  const parts = mixedSets(values);
  return idIn(parts.product, line.productId) || collectionIn(parts.collection, line.collections) || tagIn(parts.tag, line.tags);
}

function includesLower(list, value) {
  return lowerSet(list).has(lower(value));
}

function anyShared(list, wanted) {
  if (!list || !wanted || list.length === 0) return false;
  const have = lowerSet(list);
  for (const w of wanted) if (have.has(lower(w))) return true;
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
      return idIn(idSet(values), line.productId);
    case "variant":
      return idIn(idSet(values), line.variantId);
    case "collection":
      return collectionIn(plainSet(values), line.collections);
    case "tag":
      return tagIn(lowerSet(values), line.tags);
    case "vendor":
      return includesLower(values, line.vendor);
    case "product_type":
      return includesLower(values, line.productType);
    case "mixed":
      return lineMatchesMixed(line, values);
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
  // Exceptions: customers carrying one of these tags skip the rule entirely
  // (e.g. "cartrules-exempt" on a customer whose quote was agreed).
  if (Array.isArray(rule.exempt) && rule.exempt.length > 0 && anyShared(customer.tags, rule.exempt)) return false;
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

/**
 * Per-evaluation index of the cart: each line's numeric product / variant ID,
 * and which lines hold each ID. Built on first use, once per cart.
 */
function cartIndex(lines) {
  return { lines, pid: null, vid: null, byProduct: null, byVariant: null };
}

/** Numeric product IDs per line, and line indexes per product ID. */
function indexProducts(ix) {
  if (ix.pid) return ix;
  const n = ix.lines.length;
  const pid = new Array(n);
  const byProduct = new Map();
  for (let i = 0; i < n; i++) {
    const p = numericId(ix.lines[i].productId);
    pid[i] = p;
    const at = byProduct.get(p);
    if (at) at.push(i);
    else byProduct.set(p, [i]);
  }
  ix.pid = pid;
  ix.byProduct = byProduct;
  return ix;
}

/** Numeric variant IDs per line, and line indexes per variant ID. */
function indexVariants(ix) {
  if (ix.vid) return ix;
  const n = ix.lines.length;
  const vid = new Array(n);
  const byVariant = new Map();
  for (let i = 0; i < n; i++) {
    const v = numericId(ix.lines[i].variantId);
    vid[i] = v;
    const at = byVariant.get(v);
    if (at) at.push(i);
    else byVariant.set(v, [i]);
  }
  ix.vid = vid;
  ix.byVariant = byVariant;
  return ix;
}

/** Unique numeric IDs of a list of IDs / GIDs, built once per list object. */
const numericLists = new WeakMap();
function numericList(list) {
  if (!list || typeof list !== "object") return [];
  let out = numericLists.get(list);
  if (!out) {
    const seen = new Set();
    out = [];
    for (const v of list) {
      const n = numericId(v);
      if (seen.has(n)) continue;
      seen.add(n);
      out.push(n);
    }
    numericLists.set(list, out);
  }
  return out;
}

function byIndex(a, b) {
  return a - b;
}

/**
 * Indexes (in cart order) of the lines this rule applies to — the same lines
 * as lines.filter((l) => lineQualifies(rule, l)). Product and variant targets
 * look their own IDs up in the cart index, so a rule costs per listed ID, not
 * per cart line; other targets fetch their lookup Set once per rule. This is
 * the hot path at checkout, where every operation costs instructions.
 */
function qualifyingIdx(rule, ix) {
  const lines = ix.lines;
  const target = rule.target;
  const type = target && target.type ? target.type : "all";
  const values = (target && target.values) || [];
  const conditions = rule.conditions;
  const hasLineConditions = Array.isArray(conditions) && conditions.length > 0;
  const out = [];
  if (type === "product" || type === "variant") {
    const ids = numericList(values);
    if (ids.length === 0 || lines.length === 0) return out;
    const map = type === "product" ? indexProducts(ix).byProduct : indexVariants(ix).byVariant;
    for (const id of ids) {
      const at = map.get(id);
      if (!at) continue;
      for (const i of at) {
        if (hasLineConditions && !lineConditionsPass(lines[i], conditions)) continue;
        out.push(i);
      }
    }
    if (out.length > 1) out.sort(byIndex);
    return out;
  }
  let test;
  if (type === "all") {
    if (!hasLineConditions) {
      for (let i = 0; i < lines.length; i++) out.push(i);
      return out;
    }
    test = null;
  } else if (type === "collection") {
    const set = plainSet(values);
    if (set.size === 0) return out;
    test = (line) => collectionIn(set, line.collections);
  } else if (type === "tag") {
    const set = lowerSet(values);
    if (set.size === 0) return out;
    test = (line) => tagIn(set, line.tags);
  } else if (type === "mixed") {
    const parts = mixedSets(values);
    if (parts.product.size === 0 && parts.collection.size === 0 && parts.tag.size === 0) return out;
    test = (line) =>
      idIn(parts.product, line.productId) || collectionIn(parts.collection, line.collections) || tagIn(parts.tag, line.tags);
  } else {
    for (let i = 0; i < lines.length; i++) if (lineQualifies(rule, lines[i])) out.push(i);
    return out;
  }
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (test && !test(line)) continue;
    if (hasLineConditions && !lineConditionsPass(line, conditions)) continue;
    out.push(i);
  }
  return out;
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
  no_discount: "Discounts can't be applied to {{product}}. Remove the discount to continue.",
  cart_min_value: "Your cart must be at least {{limit}} to check out.",
  cart_max_value: "Your cart can't be more than {{limit}}.",
  quantity_multiple: "{{product}} is sold in multiples of {{limit}}.",
  group_limit: "You can buy at most {{limit}} items from {{collection}} per order.",
  max_cart_items: "Your cart can contain at most {{limit}} items.",
  product_combination: "{{product}} can't be purchased together with the other items in your cart.",
};

/** Fills {{product}}, {{limit}}, {{quantity}}, {{collection}}, {{discount_code}}. */
export function renderMessage(template, vars) {
  const text = template && String(template).trim() ? String(template) : FALLBACK_MESSAGES[vars.type] || "";
  if (text.indexOf("{{") === -1) return text;
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
  // `matches` is for the admin simulator; the checkout Function passes
  // { matches: false } and skips building it (it costs instructions).
  const keepMatches = !(options && options.matches === false);
  const matches = [];
  const lines = cart.lines || [];
  const currency = cart.currency || null;
  const ix = cartIndex(lines);

  // Quantity rules: collect per (type, product) claims first, resolve conflicts.
  // Claims are kept in first-claimed order (claimList); claimIndex finds a
  // claim by rule type -> "product"/"variant" -> line ID without building
  // a string key per line.
  const claimList = [];
  const claimIndex = {};
  for (const rule of rules || []) {
    if (!rule || !rule.type) continue;
    if (!cartQualifies(rule, cart)) continue;

    if (QUANTITY_TYPES.includes(rule.type)) {
      const value = Number(rule.value);
      if (!(value >= 1)) continue;
      const byVariant = rule.target && rule.target.type === "variant";
      const idx = qualifyingIdx(rule, ix);
      if (idx.length === 0) continue;
      const keys = byVariant ? indexVariants(ix).vid : indexProducts(ix).pid;
      // Units per product (or variant), in cart order of first appearance.
      const groupList = [];
      const groupAt = new Map();
      for (const i of idx) {
        const line = lines[i];
        const key = keys[i];
        const at = groupAt.get(key);
        if (at === undefined) {
          groupAt.set(key, groupList.length);
          groupList.push({ key, quantity: Number(line.quantity) || 0, line });
        } else groupList[at].quantity += Number(line.quantity) || 0;
      }
      const forType = claimIndex[rule.type] || (claimIndex[rule.type] = { product: new Map(), variant: new Map() });
      const index = byVariant ? forType.variant : forType.product;
      for (const g of groupList) {
        const candidate = { rule, quantity: g.quantity, line: g.line };
        const at = index.get(g.key);
        if (at === undefined) {
          index.set(g.key, claimList.length);
          claimList.push(candidate);
          continue;
        }
        const current = claimList[at];
        const winner = better(rule.type, current, candidate, mode);
        const loser = winner === current ? candidate : current;
        claimList[at] = winner;
        if (keepMatches) matches.push({
          ruleId: loser.rule.id,
          type: rule.type,
          productId: g.line.productId,
          overriddenBy: winner.rule.id,
        });
      }
      continue;
    }

    const matched = [];
    for (const i of qualifyingIdx(rule, ix)) matched.push(lines[i]);

    if (rule.type === "no_discount") {
      for (const line of matched) {
        if (keepMatches) matches.push({ ruleId: rule.id, type: rule.type, productId: line.productId });
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
      if (keepMatches) matches.push({ ruleId: rule.id, type: rule.type, productId: null });
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

    if (rule.type === "group_limit") {
      // Every matching line counts toward ONE total — any product, any
      // variant. qualifyingIdx yields each cart line once, so a product
      // that is both tagged and in a selected collection counts once.
      const limit = Number(rule.value);
      if (!(limit >= 1) || matched.length === 0) continue;
      let total = 0;
      for (const l of matched) total += Number(l.quantity) || 0;
      if (keepMatches) matches.push({ ruleId: rule.id, type: rule.type, productId: null, attempted: total });
      if (total <= limit) continue;
      violations.push({
        ruleId: rule.id,
        type: rule.type,
        productId: matched[0].productId,
        productTitle: matched[0].title,
        attempted: total,
        allowed: limit,
        message: renderMessage(rule.msg, {
          type: rule.type,
          limit,
          quantity: total,
          product: rule.targetLabel,
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
      if (keepMatches) matches.push({ ruleId: rule.id, type: rule.type, productId: matched[0].productId });
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

  for (const claim of claimList) {
    const { rule, quantity, line } = claim;
    const limit = Number(rule.value);
    if (keepMatches) matches.push({ ruleId: rule.id, type: rule.type, productId: line.productId });
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
    if (target.type === "mixed") {
      for (const raw of target.values || []) {
        const v = String(raw);
        if (v.startsWith("tag:")) productTags.add(v.slice(4));
        else if (v.startsWith("collection:")) collectionIds.add(v.slice(11));
      }
    }
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
    for (const t of rule.exempt || []) customerTags.add(String(t));
  }
  return {
    productTags: [...productTags],
    collectionIds: [...collectionIds],
    customerTags: [...customerTags],
  };
}
