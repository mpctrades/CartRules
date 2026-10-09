// CartRules — Cart and Checkout Validation Function
//
// Target: cart.validations.generate.run
// Docs: https://shopify.dev/docs/api/functions/latest/cart-and-checkout-validation
//
// This function does NOT read Shopify directly for rules. It reads a single
// JSON blob cached in a shop metafield (namespace "cartrules", key
// "rules_cache") that the Remix admin app rebuilds on every rule change —
// see app/models/rules.server.js `syncRulesCache`. Metaobject definitions
// aren't cheaply queryable from a Function's static input query, and this
// schema's Product has no plain `tags` list (only `hasAnyTag`/`hasTags`,
// which need a fixed tag list at query-authoring time), so the admin app
// pre-resolves everything — including expanding tags and collections into
// product ID lists — before the Function ever runs. Every rule this
// function sees is matchType "product_id".

/**
 * @param {any} input - shape defined by cart_validations_generate_run.graphql
 * @returns {{ operations: Array<{ validationAdd: { errors: Array<{ message: string, target: string }> } }> }}
 */
export function cartValidationsGenerateRun(input) {
  const cacheRaw = input?.shop?.metafield?.value;
  if (!cacheRaw) {
    return { operations: [] };
  }

  let rules = [];
  try {
    const parsed = JSON.parse(cacheRaw);
    // `enabled` is the merchant's shop-wide "CartRules protection" switch
    // (app/routes/app.settings.jsx) — undefined counts as enabled so this
    // stays backward-compatible with a cache written before Settings existed.
    if (parsed.enabled === false) {
      return { operations: [] };
    }
    rules = Array.isArray(parsed.rules) ? parsed.rules : [];
  } catch (_err) {
    // A malformed cache should never break checkout for every merchant on
    // this app — fail open (no validation errors) instead of fail closed.
    return { operations: [] };
  }

  if (rules.length === 0) {
    return { operations: [] };
  }

  const maxQuantityRules = rules.filter((r) => r.ruleType === "max_quantity");
  const noDiscountRules = rules.filter((r) => r.ruleType === "no_discount");

  const errors = [];

  // F1/F5 — max quantity per order, counted per PRODUCT across all its cart
  // lines: two variants of the same product (e.g. Small ×1 + Large ×1) are 2
  // of that item, not 1 each.
  const quantityByProduct = new Map();
  for (const line of input.cart.lines) {
    const merchandise = line.merchandise;
    const productId = merchandise && merchandise.__typename === "ProductVariant" ? merchandise.product?.id : null;
    if (!productId) continue;
    quantityByProduct.set(productId, (quantityByProduct.get(productId) ?? 0) + line.quantity);
  }
  for (const rule of maxQuantityRules) {
    if (rule.matchType !== "product_id" || !Array.isArray(rule.productIds) || !rule.maxQuantity) continue;
    for (const productId of rule.productIds) {
      if ((quantityByProduct.get(productId) ?? 0) > rule.maxQuantity) {
        errors.push({
          message: rule.message || `Maximum ${rule.maxQuantity} per order for this item.`,
          target: "$.cart",
        });
      }
    }
  }

  for (const line of input.cart.lines) {
    const merchandise = line.merchandise;
    const product = merchandise && merchandise.__typename === "ProductVariant" ? merchandise.product : null;
    if (!product) continue;

    const productId = product.id;

    const matchesRule = (rule) => {
      return rule.matchType === "product_id" && Array.isArray(rule.productIds) && rule.productIds.includes(productId);
    };

    // F2 — no discount codes.
    // Simplification (documented, not accidental): this blocks on ANY
    // discount allocation on the line, not only discount-code discounts —
    // the input query doesn't expose enough of the DiscountApplication union
    // to safely distinguish "code" vs "automatic" vs "manual" in every API
    // version. For CartRules' actual use case (protect margin on excluded
    // products) that's the intended, conservative behavior. If a merchant
    // needs automatic discounts to still apply, that's a documented v2 gap.
    const hasDiscount = (line.discountAllocations?.length ?? 0) > 0;
    if (hasDiscount) {
      for (const rule of noDiscountRules) {
        if (matchesRule(rule)) {
          errors.push({
            message: rule.message || "Discounts can't be applied to this item. Remove the discount to continue.",
            target: "$.cart",
          });
        }
      }
    }
  }

  if (errors.length === 0) {
    return { operations: [] };
  }

  // One rule over several cart products (e.g. a collection limit) would
  // otherwise show the same message once per product at checkout.
  const seen = new Set();
  const unique = errors.filter((e) => {
    const key = `${e.target}|${e.message}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  return { operations: [{ validationAdd: { errors: unique } }] };
}
