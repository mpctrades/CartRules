// Rule templates (Templates page). "Use template" opens the rule form at
// /app/rules/new?template=<id> with these fields pre-filled — the merchant
// still picks their own products and saves; nothing is activated by the
// template itself. Client-safe (no *.server suffix).
import { RULE_TYPES, TARGET_TYPES } from "./ruleConstants";

export const TEMPLATE_CATEGORIES = [
  { id: "all", label: "All" },
  { id: "quantity", label: "Quantity" },
  { id: "discount", label: "Discount" },
  { id: "cart", label: "Cart" },
  { id: "customers", label: "Customers" },
  { id: "wholesale", label: "Wholesale" },
];

// `rule` holds the form defaults. A tag target is pre-filled with a
// suggested tag the merchant can change; targets needing a picker are left
// empty for the merchant to choose.
export const TEMPLATES = [
  {
    id: "limited-edition",
    title: "Limited edition",
    summary: "Maximum 1 per order",
    description: "Stop one shopper from buying up a limited drop.",
    categories: ["quantity"],
    rule: {
      title: "Limited edition – max 1",
      ruleType: RULE_TYPES.MAX_QUANTITY,
      value: 1,
      target: { type: TARGET_TYPES.TAG, values: ["limited-edition"], labels: [] },
    },
  },
  {
    id: "no-discount",
    title: "No discount",
    summary: "Block discount codes",
    description: "Keep discount codes off products that are already at their best price.",
    categories: ["discount"],
    rule: {
      title: "No discount codes",
      ruleType: RULE_TYPES.NO_DISCOUNT,
      target: { type: TARGET_TYPES.TAG, values: ["no-discount"], labels: [] },
    },
  },
  {
    id: "wholesale-moq",
    title: "Wholesale MOQ",
    summary: "Minimum 12 units",
    description: "Require B2B buyers to order at least a case.",
    categories: ["wholesale", "quantity", "customers"],
    rule: {
      title: "Wholesale minimum – 12 units",
      ruleType: RULE_TYPES.MIN_QUANTITY,
      value: 12,
      target: { type: TARGET_TYPES.ALL, values: [], labels: [] },
      customer: { type: "b2b", tags: [] },
    },
  },
  {
    id: "bulky-item",
    title: "Bulky item cap",
    summary: "Maximum 2 per order",
    description: "Limit oversized items that are expensive to ship.",
    categories: ["quantity"],
    rule: {
      title: "Bulky items – max 2",
      ruleType: RULE_TYPES.MAX_QUANTITY,
      value: 2,
      target: { type: TARGET_TYPES.TAG, values: ["bulky"], labels: [] },
    },
  },
  {
    id: "reseller-protection",
    title: "Reseller protection",
    summary: "Maximum 3 per order",
    description: "Make bulk buying for resale harder, while letting VIP customers buy more.",
    categories: ["quantity", "customers"],
    rule: {
      title: "Reseller protection – max 3",
      ruleType: RULE_TYPES.MAX_QUANTITY,
      value: 3,
      target: { type: TARGET_TYPES.ALL, values: [], labels: [] },
      customer: { type: "exclude_tags", tags: ["VIP"] },
    },
  },
  {
    id: "free-gift",
    title: "Free gift protection",
    summary: "Maximum 1 per order",
    description: "One free gift per order — no stacking.",
    categories: ["quantity", "cart"],
    rule: {
      title: "Free gift – max 1",
      ruleType: RULE_TYPES.MAX_QUANTITY,
      value: 1,
      target: { type: TARGET_TYPES.TAG, values: ["free-gift"], labels: [] },
    },
  },
  {
    id: "flash-sale",
    title: "Flash sale",
    summary: "Scheduled quantity limit",
    description: "Cap quantities only while your sale runs — it starts and ends on its own.",
    categories: ["quantity"],
    rule: {
      title: "Flash sale – max 2",
      ruleType: RULE_TYPES.MAX_QUANTITY,
      value: 2,
      target: { type: TARGET_TYPES.COLLECTION, values: [], labels: [] },
      scheduled: true,
    },
  },
  {
    id: "pre-order",
    title: "Pre-order limit",
    summary: "Maximum quantity for preorder items",
    description: "Keep pre-orders to what you can actually fulfil.",
    categories: ["quantity"],
    rule: {
      title: "Pre-order – max 2",
      ruleType: RULE_TYPES.MAX_QUANTITY,
      value: 2,
      target: { type: TARGET_TYPES.TAG, values: ["pre-order"], labels: [] },
    },
  },
];

export function getTemplate(id) {
  return TEMPLATES.find((t) => t.id === id) ?? null;
}
