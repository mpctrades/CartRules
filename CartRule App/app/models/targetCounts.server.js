// How many products each rule's target covers ("Tag: Snow · 5 products" on
// the Rules page). Products/variants are counted from the rule itself; tags,
// vendors, types and collections are asked of Shopify in batched,
// aliased productsCount / collection.productsCount queries.
import { TARGET_TYPES, splitTarget } from "./ruleConstants";

const SEARCH_FIELD = { [TARGET_TYPES.TAG]: "tag", [TARGET_TYPES.VENDOR]: "vendor", [TARGET_TYPES.PRODUCT_TYPE]: "product_type" };
const quote = (v) => `'${String(v).replace(/['\\]/g, "\\$&")}'`;

/**
 * Product searches covering a group: one per part (all tags ORed together,
 * each collection, the picked products). Shopify's product search doesn't
 * reliably OR a tag filter with a collection_id filter — "tag:x OR
 * collection_id:y" came back with the tagged products only — so the parts
 * are searched separately and the products de-duplicated by ID.
 */
export function groupSearchQueries(target) {
  const tags = [];
  const collections = [];
  const products = [];
  for (const part of splitTarget(target)) {
    for (const v of part.values) {
      if (part.type === "tag") tags.push(`tag:${quote(v)}`);
      else if (part.type === "collection") collections.push(`collection_id:${String(v).split("/").pop()}`);
      else if (part.type === "product") products.push(`id:${String(v).split("/").pop()}`);
    }
  }
  const queries = [];
  if (tags.length) queries.push(tags.join(" OR "));
  queries.push(...collections);
  if (products.length) queries.push(products.join(" OR "));
  return queries;
}

/**
 * "→ 6 products, 42 variants" for the group form and the Rules list. A
 * product matched by several parts (tagged and in a selected collection)
 * counts once. Exact up to 250 products per part; beyond that `more` is true.
 */
export async function countGroup(admin, target) {
  const queries = groupSearchQueries(target);
  if (queries.length === 0) return { products: 0, variants: 0, more: false };
  const defs = queries.map((_, i) => `$q${i}: String`).join(", ");
  const fields = queries
    .map((_, i) => `p${i}: products(first: 250, query: $q${i}) { nodes { id variantsCount { count } } pageInfo { hasNextPage } }`)
    .join("\n");
  const response = await admin.graphql(`#graphql
    query CartRulesGroupCount(${defs}) { ${fields} }`, {
    variables: Object.fromEntries(queries.map((q, i) => [`q${i}`, q])),
  });
  const json = await response.json();
  if (json.errors?.length) throw new Error(JSON.stringify(json.errors));
  const seen = new Map();
  let more = false;
  queries.forEach((_, i) => {
    const conn = json.data?.[`p${i}`];
    if (conn?.pageInfo?.hasNextPage) more = true;
    for (const n of conn?.nodes ?? []) if (!seen.has(n.id)) seen.set(n.id, n.variantsCount?.count ?? 0);
  });
  let variants = 0;
  for (const v of seen.values()) variants += v;
  return { products: seen.size, variants, more };
}

/** { [ruleId]: number | null } — null when the count isn't known (e.g. "All products"). */
export async function getTargetProductCounts(admin, rules) {
  const result = {};
  const queries = []; // { ruleId, kind: "search"|"collection", arg }
  const groupRules = []; // counted with countGroup (one request each)
  for (const rule of rules) {
    const t = rule.target;
    if (!t || t.type === TARGET_TYPES.ALL) {
      result[rule.id] = null;
    } else if (t.type === TARGET_TYPES.PRODUCT) {
      result[rule.id] = t.values.length;
    } else if (t.type === TARGET_TYPES.MIXED) {
      groupRules.push(rule);
    } else if (t.type === TARGET_TYPES.VARIANT) {
      result[rule.id] = null;
    } else if (SEARCH_FIELD[t.type]) {
      // One search ORing every value counts each product once.
      const q = t.values.map((v) => `${SEARCH_FIELD[t.type]}:${quote(v)}`).join(" OR ");
      queries.push({ ruleId: rule.id, kind: "search", arg: q });
    } else if (t.type === TARGET_TYPES.COLLECTION && t.values.length === 1) {
      queries.push({ ruleId: rule.id, kind: "collection", arg: t.values[0] });
    } else {
      result[rule.id] = null;
    }
  }

  for (let i = 0; i < queries.length; i += 20) {
    const chunk = queries.slice(i, i + 20);
    const defs = chunk.map((q, j) => (q.kind === "search" ? `$s${j}: String` : `$c${j}: ID!`));
    const fields = chunk.map((q, j) =>
      q.kind === "search"
        ? `r${j}: productsCount(query: $s${j}) { count }`
        : `r${j}: collection(id: $c${j}) { productsCount { count } }`,
    );
    const variables = Object.fromEntries(chunk.map((q, j) => [q.kind === "search" ? `s${j}` : `c${j}`, q.arg]));
    try {
      const response = await admin.graphql(
        `query CartRulesTargetProductCounts(${defs.join(", ")}) { ${fields.join("\n")} }`,
        { variables },
      );
      const json = await response.json();
      chunk.forEach((q, j) => {
        const node = json.data?.[`r${j}`];
        result[q.ruleId] = q.kind === "search" ? (node?.count ?? null) : (node?.productsCount?.count ?? null);
      });
    } catch (error) {
      if (error instanceof Response) throw error;
      console.warn("Could not count rule target products", error?.message ?? String(error));
      for (const q of chunk) result[q.ruleId] = null;
    }
  }
  for (const rule of groupRules) {
    try {
      const { products, more } = await countGroup(admin, rule.target);
      result[rule.id] = more ? null : products;
    } catch (error) {
      if (error instanceof Response) throw error;
      console.warn("Could not count group products", error?.message ?? String(error));
      result[rule.id] = null;
    }
  }
  return result;
}
