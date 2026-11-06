// Plan gating, incl. grandfathering of rules saved before rules v2. Run: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";

// app/models uses extensionless imports (resolved by Vite); add ".js" here.
register(
  "data:text/javascript," +
    encodeURIComponent(`export async function resolve(s, c, next) {
      try { return await next(s, c); } catch (e) {
        if (s.startsWith(".") && !/\\.[cm]?js$/.test(s)) return next(s + ".js", c);
        throw e;
      }
    }`),
);
const { lockedFeaturesClient } = await import("../app/models/planFeatures.js");

const base = {
  ruleType: "max_quantity",
  target: { type: "collection", values: ["gid://shopify/Collection/1"] },
  message: "Max 2 per order",
};
const keys = (rule, plan) => lockedFeaturesClient(rule, plan).map((f) => f.key).sort();

test("new Free rules need Growth for collection targeting and custom messages", () => {
  assert.deepEqual(keys(base, "Free"), ["message", "target:collection"]);
  assert.deepEqual(keys({ ...base, target: { type: "tag", values: ["x"] } }, "Free"), ["message", "target:tag"]);
  assert.deepEqual(keys(base, "Growth"), []);
});

test("pre-v2 rules keep what v1's Free plan included", () => {
  assert.deepEqual(keys({ ...base, legacy: true }, "Free"), []);
  assert.deepEqual(keys({ ...base, legacy: true, target: { type: "tag", values: ["x"] } }, "Free"), []);
});

test("grandfathering never unlocks features v1 didn't have", () => {
  assert.deepEqual(keys({ ...base, legacy: true, target: { type: "vendor", values: ["Acme"] } }, "Free"), ["target:vendor"]);
  assert.deepEqual(keys({ ...base, legacy: true, priority: 5 }, "Growth"), ["priority"]);
  assert.deepEqual(keys({ ...base, legacy: true, ruleType: "cart_min_value" }, "Free"), ["type"]);
});
