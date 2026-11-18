// Group limit rules (CartRules Update 1): one maximum for the combined
// quantity of several products. Mirrors the brief's acceptance tests that
// the engine decides (checkout, cart guard and rule tester all run it).
import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluateCart, collectInputVariables, ruleAppliesToProduct } from "../extensions/cartrules-validation/src/engine.js";

const line = (o) => ({
  productId: "gid://shopify/Product/1",
  variantId: "gid://shopify/ProductVariant/11",
  title: "Hoodie Faith",
  vendor: "PoR",
  productType: "Hoodie",
  tags: ["hoodie"],
  collections: [],
  quantity: 1,
  subtotal: 48,
  hasDiscount: false,
  ...o,
});
const faith = (q, o = {}) => line({ quantity: q, ...o });
const faithL = (q) => line({ variantId: "gid://shopify/ProductVariant/12", quantity: q });
const faithS = (q) => line({ variantId: "gid://shopify/ProductVariant/13", quantity: q });
const hope = (q, o = {}) => line({ productId: "gid://shopify/Product/2", variantId: "gid://shopify/ProductVariant/21", title: "Hoodie Hope", quantity: q, ...o });
const shirt = (q) => line({ productId: "gid://shopify/Product/3", variantId: "gid://shopify/ProductVariant/31", title: "Long-sleeve Grace", tags: ["shirt"], quantity: q });
const cart = (lines, o = {}) => ({ lines, customer: { loggedIn: false, b2b: false, tags: [] }, country: "US", subtotal: 0, currency: "USD", discountCode: null, ...o });

const MSG = "For orders of three or more hoodies, please email us for a shipping quote before placing your order.";
const hoodies = {
  id: "g",
  type: "group_limit",
  value: 2,
  target: { type: "mixed", values: ["tag:hoodie"] },
  targetLabel: "hoodie",
  exempt: ["cartrules-exempt"],
  msg: MSG,
};
const blocked = (c, rules = [hoodies]) => evaluateCart(c, rules).violations.map((v) => v.ruleId);

test("1: 2 hoodies (different products) + 1 long-sleeve passes", () => {
  assert.deepEqual(blocked(cart([faith(1), hope(1), shirt(1)])), []);
});

test("2: 3 variants of the same hoodie is blocked with the exact message", () => {
  const { violations } = evaluateCart(cart([faith(1), faithL(1), faithS(1)]), [hoodies]);
  assert.equal(violations.length, 1);
  assert.equal(violations[0].message, MSG);
  assert.equal(violations[0].attempted, 3);
  assert.equal(violations[0].allowed, 2);
});

test("3: 2 x Hoodie A + 1 x Hoodie B is blocked", () => {
  assert.deepEqual(blocked(cart([faith(2), hope(1)])), ["g"]);
});

test("demo cart: 2 + 2 hoodies + 1 shirt is blocked at 4 units; shirt never counts", () => {
  const { violations } = evaluateCart(cart([faith(2), hope(2), shirt(1)]), [hoodies]);
  assert.equal(violations[0].attempted, 4);
  assert.deepEqual(blocked(cart([faith(2), shirt(9)])), []);
});

test("6: reducing to 2 hoodies passes", () => {
  assert.deepEqual(blocked(cart([faith(2), shirt(1)])), []);
});

test("7: evaluation never changes the cart", () => {
  const c = cart([faith(2), hope(2), shirt(1)]);
  const before = JSON.stringify(c);
  evaluateCart(c, [hoodies]);
  assert.equal(JSON.stringify(c), before);
});

test("9: a customer tagged cartrules-exempt with 4 hoodies passes", () => {
  const c = cart([faith(2), hope(2)], { customer: { loggedIn: true, b2b: false, tags: ["cartrules-exempt"] } });
  assert.deepEqual(blocked(c), []);
  // other tags don't exempt
  const other = cart([faith(2), hope(2)], { customer: { loggedIn: true, b2b: false, tags: ["vip"] } });
  assert.deepEqual(blocked(other), ["g"]);
});

test("10: a product in both the tag and the collection counts once", () => {
  const rule = { ...hoodies, target: { type: "mixed", values: ["tag:hoodie", "collection:gid://shopify/Collection/9", "product:1"] } };
  // Faith: tagged, in the collection AND picked — still 2 units, not 6.
  const c = cart([faith(2, { collections: ["gid://shopify/Collection/9"] })]);
  assert.deepEqual(blocked(c, [rule]), []);
  assert.equal(evaluateCart(cart([faith(3, { collections: ["gid://shopify/Collection/9"] })]), [rule]).violations[0].attempted, 3);
});

test("mixed targets: products, collections and tags each pull lines into the group", () => {
  const rule = { ...hoodies, target: { type: "mixed", values: ["product:gid://shopify/Product/3", "collection:gid://shopify/Collection/9"] } };
  // shirt picked by id (2) + Hope via collection (1) = 3 > 2; Faith (no collection, tag not targeted) ignored
  const c = cart([shirt(2), hope(1, { tags: [], collections: ["gid://shopify/Collection/9"] }), faith(5, { tags: [] })]);
  const v = evaluateCart(c, [rule]).violations;
  assert.equal(v.length, 1);
  assert.equal(v[0].attempted, 3);
});

test("tags match case-insensitively", () => {
  const rule = { ...hoodies, target: { type: "mixed", values: ["tag:Hoodie"] } };
  assert.deepEqual(blocked(cart([faith(3)]), [rule]), ["g"]);
});

test("several group rules are each checked on their own and all errors are returned", () => {
  const shirts = { id: "s", type: "group_limit", value: 1, target: { type: "mixed", values: ["tag:shirt"] }, msg: "One shirt max" };
  assert.deepEqual(blocked(cart([faith(3), shirt(2)]), [hoodies, shirts]).sort(), ["g", "s"]);
  assert.deepEqual(blocked(cart([faith(3), shirt(1)]), [hoodies, shirts]), ["g"]);
});

test("12: per-product and block-discount rules keep working next to a group rule", () => {
  const perProduct = { id: "p", type: "max_quantity", value: 1, target: { type: "tag", values: ["hoodie"] } };
  const noDiscount = { id: "d", type: "no_discount", target: { type: "tag", values: ["hoodie"] } };
  // 1 Faith + 1 Hope: per-product OK (1 each), group OK (2)
  assert.deepEqual(blocked(cart([faith(1), hope(1)]), [hoodies, perProduct]), []);
  // 2 Faith: per-product blocks, group OK
  assert.deepEqual(blocked(cart([faith(2)]), [hoodies, perProduct]), ["p"]);
  assert.deepEqual(blocked(cart([faith(1, { hasDiscount: true })]), [hoodies, noDiscount]), ["d"]);
  // A per-product max of 5 does not override the group max of 2.
  const loose = { ...perProduct, value: 5 };
  assert.deepEqual(blocked(cart([faith(3)]), [hoodies, loose]), ["g"]);
});

test("default message names the group", () => {
  const { msg, ...rule } = hoodies;
  const v = evaluateCart(cart([faith(3)]), [rule]).violations[0];
  assert.equal(v.message, "You can buy at most 2 items from hoodie per order.");
});

test("input variables include group tags, collections and exemption tags", () => {
  const rule = { ...hoodies, target: { type: "mixed", values: ["tag:hoodie", "collection:gid://shopify/Collection/9", "product:5"] } };
  assert.deepEqual(collectInputVariables([rule]), {
    productTags: ["hoodie"],
    collectionIds: ["gid://shopify/Collection/9"],
    customerTags: ["cartrules-exempt"],
  });
});

test("product page: a group rule applies to products in the group only", () => {
  assert.equal(ruleAppliesToProduct(hoodies, faith(1), { customer: {}, country: "US" }), true);
  assert.equal(ruleAppliesToProduct(hoodies, shirt(1), { customer: {}, country: "US" }), false);
});
