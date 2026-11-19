// The checkout Function runs in Rust (extensions/cartrules-validation/src),
// while the admin simulator and the storefront blocks run engine/engine.js.
// This test keeps them in step: it builds randomized checkout inputs, records
// what the JavaScript reference Function (engine/function.js) answers, and
// has `cargo test` replay every case against the Rust Function.
//
// Needs the Rust toolchain (rustup); skipped with a note when cargo is missing
// locally, but CI installs it, so a mismatch never ships.
import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { cartValidationsGenerateRun } from "../engine/function.js";

const FUNCTION_DIR = fileURLToPath(new URL("../extensions/cartrules-validation", import.meta.url));
const CASES = Number(process.env.PARITY_CASES || 4000);

let seed = 20261119;
const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
const pick = (a) => a[Math.floor(rnd() * a.length)];
const int = (n) => Math.floor(rnd() * n);
const maybe = (p, v) => (rnd() < p ? v() : undefined);

const TAGS = ["Hoodie", "hoodie", "snack", "Promo", "vip", " spaced ", "ÉTÉ"];
const COLLS = [1, 2, 3, 4].map((c) => `gid://shopify/Collection/${c}`);
const TYPES = ["max_quantity", "min_quantity", "quantity_multiple", "no_discount", "cart_min_value", "cart_max_value",
  "max_cart_items", "group_limit", "product_combination", "unknown_type"];
const VALUES = [0, 1, 2, 3, 5, 10, 50, 2.5, 0.125, 19.99, "4", " 3 ", "", null, "0x10", "abc", true, -1, 1e3, "1e1"];
const MESSAGES = ["", "   ", null, "Max {{limit}} of {{product}} ({{quantity}}) {{collection}}", "Plain words",
  "{{ product }} {{discount_code}}", "{{{product}}}", "{{limit}}{{limit}} {{unknown}} {{", "{{product", 42, "Group {{ collection }} max {{limit}}"];

function target(forGroup) {
  const t = forGroup ? pick(["mixed", "mixed", "tag"]) : pick(["all", "product", "variant", "collection", "tag", "vendor", "product_type", "mixed", "product", "", "bogus"]);
  const values = {
    all: [],
    product: Array.from({ length: int(5) }, () => pick([String(1 + int(8)), `gid://shopify/Product/${1 + int(8)}`, 1 + int(8)])),
    variant: Array.from({ length: int(5) }, () => pick([String(100 + int(12)), `gid://shopify/ProductVariant/${100 + int(12)}`])),
    collection: Array.from({ length: 1 + int(2) }, () => pick(COLLS)),
    tag: Array.from({ length: 1 + int(2) }, () => pick(TAGS)),
    vendor: [pick(["Acme", "acme ", "Zed"])],
    product_type: [pick(["Food", "food", "Toy"])],
    mixed: Array.from({ length: int(5) }, () => pick([`tag:${pick(TAGS)}`, `collection:${pick(COLLS)}`, `product:${1 + int(8)}`,
      `product:gid://shopify/Product/${1 + int(8)}`, "nocolon", "weird:x"])),
    "": [],
    bogus: ["1"],
  }[t];
  if (rnd() < 0.03) return null;
  if (rnd() < 0.03) return { values };
  return { type: t, values: rnd() < 0.03 ? "not-an-array" : values };
}

function rule(i) {
  if (rnd() < 0.02) return pick([null, "junk", { ruleType: "max_quantity", maxQuantity: pick([1, 2, "3"]), message: pick(MESSAGES), productIds: [`gid://shopify/Product/${1 + int(8)}`, String(1 + int(8))] }]);
  const type = pick(TYPES);
  const r = { id: `gid://shopify/Metaobject/${i}`, type, value: pick(VALUES), msg: pick(MESSAGES), priority: pick([0, 1, 2, "3", null]),
    targetLabel: pick([null, "hoodies", "", 7]), target: target(type === "group_limit") };
  if (type === "product_combination" || rnd() < 0.05) r.comboTarget = target(false);
  const customer = maybe(0.3, () => pick([{ type: "logged_in" }, { type: "guest" }, { type: "tags", tags: ["vip", "Gold"] },
    { type: "exclude_tags", tags: ["VIP"] }, { type: "b2b" }, { type: "everyone" }]));
  if (customer) r.customer = customer;
  if (rnd() < 0.2) r.exempt = ["cartrules-exempt"];
  if (rnd() < 0.15) r.countries = [pick(["US", "fr", " ca "])];
  if (rnd() < 0.35) {
    r.conditions = Array.from({ length: 1 + int(2) }, () => pick([
      { field: "product_tag", op: pick(["is", "is_not"]), value: pick(TAGS) },
      { field: "product_vendor", op: pick(["is", "is_not"]), value: "acme" },
      { field: "product_type", op: "is", value: "FOOD" },
      { field: "cart_subtotal", op: pick(["gte", "lte"]), value: pick([50, "120.5", "x"]) },
      { field: "customer_tag", op: pick(["contains", "not_contains"]), value: "vip" },
      { field: "country", op: pick(["is", "is_not"]), value: "us" },
      { field: "other", op: "is", value: 1 },
    ]));
  }
  return r;
}

const PRICES = ["12.5", "0.10", "19.99", "100.0", "3.333", "0.125"];

function input() {
  const lines = Array.from({ length: int(16) }, () => {
    const p = 1 + int(8);
    const v = 100 + int(12);
    const tags = TAGS.filter(() => rnd() < 0.3);
    const colls = COLLS.filter(() => rnd() < 0.3);
    return {
      quantity: pick([1, 1, 2, 3, 4, 6, 0]),
      cost: { subtotalAmount: { amount: pick(PRICES) } },
      discountAllocations: rnd() < 0.2 ? [{ __typename: "DiscountAllocation" }] : [],
      merchandise: rnd() < 0.03 ? { __typename: "CustomProduct" } : {
        __typename: "ProductVariant",
        id: `gid://shopify/ProductVariant/${v}`,
        product: {
          id: `gid://shopify/Product/${p}`,
          title: pick([`Product ${p}`, "", `Café ${p}`]),
          vendor: pick(["Acme", "Zed", null]),
          productType: pick(["Food", "Toy", null]),
          hasTags: TAGS.map((t) => ({ tag: t, hasTag: tags.includes(t) })),
          inCollections: COLLS.map((c) => ({ collectionId: c, isMember: colls.includes(c) })),
        },
      },
    };
  });
  const loggedIn = rnd() < 0.5;
  const customerTags = ["vip", "Gold", "cartrules-exempt"].filter(() => rnd() < 0.3);
  const rules = Array.from({ length: 1 + int(6) }, (_, i) => rule(i));
  const cache = { v: 2, rules, enabled: rnd() < 0.97 ? pick([true, undefined]) : false };
  const mode = pick(["most_restrictive", "priority", undefined, ""]);
  if (mode !== undefined) cache.conflictMode = mode;
  if (rnd() < 0.1) cache.checkoutMessagesEnabled = false;
  if (rnd() < 0.05) cache.genericMessage = pick(["Custom generic", ""]);
  return {
    buyerJourney: { step: pick(["CART_INTERACTION", "CHECKOUT_INTERACTION", "CHECKOUT_COMPLETION", null]) },
    cart: {
      lines,
      cost: { subtotalAmount: { amount: pick(["0", "45.5", "120.75", "300"]), currencyCode: pick(["USD", "EUR", "KRW"]) } },
      buyerIdentity: rnd() < 0.2 ? null : {
        isAuthenticated: loggedIn,
        customer: loggedIn ? { hasTags: ["vip", "gold", "cartrules-exempt"].map((t) => ({ tag: t, hasTag: customerTags.map((x) => x.toLowerCase()).includes(t) })) } : null,
        purchasingCompany: rnd() < 0.1 ? { company: { id: "gid://shopify/Company/1" } } : null,
      },
    },
    localization: { country: { isoCode: pick(["US", "FR", "CA", "KR"]) } },
    cache: rnd() < 0.02 ? null : cache,
  };
}

function messagesOf(output) {
  return (output.operations || []).flatMap((op) => op.validationAdd.errors.map((e) => e.message));
}

test("Rust checkout Function gives the same answers as engine/function.js", (t) => {
  const rows = [];
  let blocked = 0;
  for (let n = 0; n < CASES; n++) {
    const { cache, ...rest } = input();
    // JavaScript reads `value` (a JSON string); Rust reads `jsonValue`.
    const jsInput = { ...rest, shop: { metafield: cache ? { value: JSON.stringify(cache) } : null } };
    const rustInput = { ...rest, shop: { metafield: cache ? { jsonValue: JSON.parse(JSON.stringify(cache)) } : null } };
    const expected = messagesOf(cartValidationsGenerateRun(jsInput));
    if (expected.length) blocked++;
    rows.push(JSON.stringify({ input: rustInput, expected }));
  }
  writeFileSync(`${FUNCTION_DIR}/tests/parity-cases.jsonl`, rows.join("\n") + "\n");
  assert.ok(blocked > CASES / 5, `only ${blocked} blocked carts — generator too tame`);

  const cargo = spawnSync("cargo", ["--version"], { encoding: "utf8" });
  if (cargo.error) {
    t.skip("cargo not installed — install Rust (rustup) to run the Rust side of this test");
    return;
  }
  const run = spawnSync("cargo", ["test", "--quiet", "--", "--nocapture"], { cwd: FUNCTION_DIR, encoding: "utf8" });
  assert.equal(run.status, 0, `cargo test failed:\n${run.stdout}\n${run.stderr}`);
  assert.match(run.stderr + run.stdout, new RegExp(`${CASES} parity cases match`));
});
