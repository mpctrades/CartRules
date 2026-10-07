// CartRules — Cart and Checkout Validation Function
//
// Target: cart.validations.generate.run
// Docs: https://shopify.dev/docs/api/functions/latest/cart-and-checkout-validation
//
// Rules come from the `cartrules.rules_cache` shop metafield, which the admin
// app rebuilds on every rule or settings change (buildRulesCache in
// app/models/rules.server.js). Tag/collection/customer-tag membership comes
// from hasTags/inCollections, whose tag and collection lists are input query
// variables (see cart_validations_generate_run.graphql). The decision itself
// is made by ./engine.js — the same code the admin app's rule simulator runs.

import { evaluateCart } from "./engine";

/**
 * @param {any} input - shape defined by cart_validations_generate_run.graphql
 */
export function cartValidationsGenerateRun(input) {
  const cacheRaw = input?.shop?.metafield?.value;
  if (!cacheRaw) return { operations: [] };

  let cache;
  try {
    cache = JSON.parse(cacheRaw);
  } catch (_err) {
    // A malformed cache must never break checkout — fail open.
    return { operations: [] };
  }
  // `enabled` is the shop-wide "CartRules protection" switch in Settings.
  if (!cache || cache.enabled === false) return { operations: [] };
  const rules = (Array.isArray(cache.rules) ? cache.rules : []).map(fromLegacy);
  if (rules.length === 0) return { operations: [] };

  const { violations } = evaluateCart(toEngineCart(input), rules, { conflictMode: cache.conflictMode });
  if (violations.length === 0) return { operations: [] };

  // Settings → Storefront → "Checkout messages" off: block with one neutral
  // message instead of each rule's own wording.
  const generic = cache.checkoutMessagesEnabled === false;
  // One rule over several products would otherwise repeat the same message.
  const seen = new Set();
  const errors = [];
  for (const v of violations) {
    const message = generic ? cache.genericMessage || "Your cart doesn't meet this store's purchase rules." : v.message;
    if (!message || seen.has(message)) continue;
    seen.add(message);
    errors.push({ message, target: "$.cart" });
  }
  return { operations: [{ validationAdd: { errors } }] };
}

// Caches written before rules v2 ({ ruleType, maxQuantity, productIds }) stay
// enforced until the app rewrites them on the merchant's next visit.
function fromLegacy(rule) {
  if (!rule || rule.type || !rule.ruleType) return rule;
  return {
    id: rule.id,
    type: rule.ruleType,
    value: rule.maxQuantity,
    msg: rule.message,
    target: { type: "product", values: Array.isArray(rule.productIds) ? rule.productIds : [] },
  };
}

function trueTags(list) {
  return (list || []).filter((t) => t.hasTag).map((t) => String(t.tag).toLowerCase());
}

export function toEngineCart(input) {
  const cart = input?.cart || {};
  const lines = [];
  for (const line of cart.lines || []) {
    const merchandise = line.merchandise;
    if (!merchandise || merchandise.__typename !== "ProductVariant" || !merchandise.product) continue;
    const product = merchandise.product;
    lines.push({
      productId: product.id,
      variantId: merchandise.id,
      title: product.title,
      vendor: product.vendor,
      productType: product.productType,
      tags: trueTags(product.hasTags),
      collections: (product.inCollections || []).filter((c) => c.isMember).map((c) => c.collectionId),
      quantity: line.quantity,
      subtotal: Number(line.cost?.subtotalAmount?.amount) || 0,
      // Any discount allocation counts — the input can't reliably tell a
      // code from an automatic discount (see the Block discount rule's help text).
      hasDiscount: (line.discountAllocations?.length ?? 0) > 0,
    });
  }
  const buyer = cart.buyerIdentity;
  const subtotal = Number(cart.cost?.subtotalAmount?.amount);
  return {
    lines,
    customer: {
      loggedIn: Boolean(buyer?.isAuthenticated),
      b2b: Boolean(buyer?.purchasingCompany?.company?.id),
      tags: trueTags(buyer?.customer?.hasTags),
    },
    country: input?.localization?.country?.isoCode ?? null,
    subtotal: Number.isFinite(subtotal) ? subtotal : 0,
    currency: cart.cost?.subtotalAmount?.currencyCode ?? null,
    discountCode: null,
  };
}
