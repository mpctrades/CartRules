// Rule engine checks — the same engine runs at checkout (Function), on the
// storefront (theme blocks) and in the admin simulator. Run: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluateCart, collectInputVariables, ruleAppliesToProduct } from "../extensions/cartrules-validation/src/engine.js";
test("rule engine", () => {
const line = (o) => ({ productId: "gid://shopify/Product/1", variantId: "gid://shopify/ProductVariant/11", title: "Snow", vendor: "Acme", productType: "Board", tags: ["limited"], collections: [], quantity: 1, subtotal: 10, hasDiscount: false, ...o });
const cart = (lines, o = {}) => ({ lines, customer: { loggedIn: false, b2b: false, tags: [] }, country: "US", subtotal: lines.reduce((s, l) => s + l.subtotal, 0), currency: "USD", discountCode: null, ...o });
const all = { type: "all", values: [] };
const ids = (r) => r.violations.map((v) => v.ruleId).sort();

// min quantity: 0 < qty < min blocks; qty >= min passes
assert.deepEqual(ids(evaluateCart(cart([line({ quantity: 3 })]), [{ id: "min", type: "min_quantity", value: 12, target: all }])), ["min"]);
assert.deepEqual(ids(evaluateCart(cart([line({ quantity: 12 })]), [{ id: "min", type: "min_quantity", value: 12, target: all }])), []);
// multiples
assert.deepEqual(ids(evaluateCart(cart([line({ quantity: 7 })]), [{ id: "m", type: "quantity_multiple", value: 6, target: all }])), ["m"]);
assert.deepEqual(ids(evaluateCart(cart([line({ quantity: 12 })]), [{ id: "m", type: "quantity_multiple", value: 6, target: all }])), []);
// two variants of the same product count together
assert.deepEqual(ids(evaluateCart(cart([line({ quantity: 1 }), line({ variantId: "gid://shopify/ProductVariant/12", quantity: 1 })]), [{ id: "x", type: "max_quantity", value: 1, target: all }])), ["x"]);
// variant target counts only that variant
assert.deepEqual(ids(evaluateCart(cart([line({ quantity: 1 }), line({ variantId: "gid://shopify/ProductVariant/12", quantity: 5 })]), [{ id: "v", type: "max_quantity", value: 1, target: { type: "variant", values: ["11"] } }])), []);
// priority mode: higher priority wins even if less restrictive
const two = [{ id: "store", type: "max_quantity", value: 10, target: all, priority: 50 }, { id: "ltd", type: "max_quantity", value: 1, target: { type: "tag", values: ["Limited"] } }];
assert.deepEqual(ids(evaluateCart(cart([line({ quantity: 4 })]), two, { conflictMode: "priority" })), []);
assert.deepEqual(ids(evaluateCart(cart([line({ quantity: 4 })]), two)), ["ltd"]);
const m = evaluateCart(cart([line({ quantity: 4 })]), two).matches.find((x) => x.overriddenBy);
assert.equal(m.ruleId, "store"); assert.equal(m.overriddenBy, "ltd");
// customers
const vip = { id: "c", type: "max_quantity", value: 1, target: all, customer: { type: "tags", tags: ["VIP"] } };
assert.deepEqual(ids(evaluateCart(cart([line({ quantity: 2 })]), [vip])), []);
assert.deepEqual(ids(evaluateCart(cart([line({ quantity: 2 })], { customer: { loggedIn: true, b2b: false, tags: ["vip"] } }), [vip])), ["c"]);
const b2b = { id: "b", type: "min_quantity", value: 12, target: all, customer: { type: "b2b" } };
assert.deepEqual(ids(evaluateCart(cart([line({ quantity: 2 })]), [b2b])), []);
assert.deepEqual(ids(evaluateCart(cart([line({ quantity: 2 })], { customer: { loggedIn: true, b2b: true, tags: [] } }), [b2b])), ["b"]);
const guest = { id: "g", type: "max_quantity", value: 1, target: all, customer: { type: "guest" } };
assert.deepEqual(ids(evaluateCart(cart([line({ quantity: 2 })], { customer: { loggedIn: true, tags: [] } }), [guest])), []);
// countries
const ca = { id: "ca", type: "max_quantity", value: 1, target: all, countries: ["CA"] };
assert.deepEqual(ids(evaluateCart(cart([line({ quantity: 2 })]), [ca])), []);
assert.deepEqual(ids(evaluateCart(cart([line({ quantity: 2 })], { country: "CA" }), [ca])), ["ca"]);
// conditions: product tag is X AND customer tag not VIP
const cond = { id: "k", type: "max_quantity", value: 1, target: all, conditions: [{ field: "product_tag", op: "is", value: "Limited" }, { field: "customer_tag", op: "not_contains", value: "VIP" }] };
assert.deepEqual(ids(evaluateCart(cart([line({ quantity: 2 })]), [cond])), ["k"]);
assert.deepEqual(ids(evaluateCart(cart([line({ quantity: 2, tags: [] })]), [cond])), []);
assert.deepEqual(ids(evaluateCart(cart([line({ quantity: 2 })], { customer: { tags: ["vip"] } }), [cond])), []);
// cart subtotal condition
assert.deepEqual(ids(evaluateCart(cart([line({ quantity: 2, subtotal: 20 })]), [{ ...cond, conditions: [{ field: "cart_subtotal", op: "gte", value: "50" }] }])), []);
// cart value scoped to collection uses matched lines only
const cv = { id: "cv", type: "cart_min_value", value: 50, target: { type: "collection", values: ["gid://shopify/Collection/9"] } };
assert.deepEqual(ids(evaluateCart(cart([line({ subtotal: 100 })]), [cv])), []); // no matched lines -> n/a
assert.deepEqual(ids(evaluateCart(cart([line({ subtotal: 100 }), line({ productId: "gid://shopify/Product/2", collections: ["gid://shopify/Collection/9"], subtotal: 20 })]), [cv])), ["cv"]);
// max cart items
assert.deepEqual(ids(evaluateCart(cart([line({ quantity: 3 }), line({ productId: "gid://shopify/Product/2", quantity: 3 })]), [{ id: "i", type: "max_cart_items", value: 5, target: all }])), ["i"]);
// combination needs two different lines
const combo = { id: "co", type: "product_combination", target: { type: "product", values: ["1"] }, comboTarget: { type: "vendor", values: ["acme"] } };
assert.deepEqual(ids(evaluateCart(cart([line({ quantity: 3 })]), [combo])), []);
assert.deepEqual(ids(evaluateCart(cart([line(), line({ productId: "gid://shopify/Product/2" })]), [combo])), ["co"]);
// no_discount
assert.deepEqual(ids(evaluateCart(cart([line({ hasDiscount: true })]), [{ id: "d", type: "no_discount", target: all }])), ["d"]);
// message rendering
const msg = evaluateCart(cart([line({ quantity: 4 })]), [{ id: "x", type: "max_quantity", value: 1, target: all, msg: "Max {{limit}} of {{product}} (you had {{quantity}})" }]).violations[0].message;
assert.equal(msg, "Max 1 of Snow (you had 4)");
// input variables
assert.deepEqual(collectInputVariables([cond, two[1], vip, cv]), { productTags: ["Limited"], collectionIds: ["gid://shopify/Collection/9"], customerTags: ["VIP"] });
// product page applicability ignores cart subtotal conditions
assert.equal(ruleAppliesToProduct({ ...cond, conditions: [{ field: "cart_subtotal", op: "gte", value: "500" }] }, line(), { customer: {}, country: "US" }), true);
});
