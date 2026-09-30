// Plain constants shared by both server code (app/models/rules.server.js)
// and client-rendered route components. Deliberately NOT named `*.server.js`
// — Remix treats that suffix as server-only and strips such modules from the
// client bundle, which breaks any component that imports from it (see the
// "Server-only module referenced by client" build error this file fixes).
export const RULE_TYPES = {
  NO_DISCOUNT: "no_discount",
  MAX_QUANTITY: "max_quantity",
};

export const TARGET_TYPES = {
  PRODUCT: "product",
  COLLECTION: "collection",
  TAG: "tag",
};

/** Max-quantity form input: a whole number of 1 or more. */
export function isValidMaxQuantity(value) {
  const n = Number(value);
  return Number.isInteger(n) && n >= 1;
}

export const RULE_STATUS = {
  ACTIVE: "active",
  PAUSED: "paused",
};
