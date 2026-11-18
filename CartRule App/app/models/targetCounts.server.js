// How many products each rule's target covers ("Tag: Snow · 5 products" on
// the Rules page). Products/variants are counted from the rule itself; tags,
// vendors, types and collections are asked of Shopify in batched,
// aliased productsCount / collection.productsCount queries.
import { TARGET_TYPES, splitTarget } from "./ruleConstants";

const SEARCH_FIELD = { [TARGET_TYPES.TAG]: "tag", [TARGET_TYPES.VENDOR]: "vendor", [TARGET_TYPES.PRODUCT_TYPE]: "product_type" };
const quote = (v) => `'${String(v).replace(/['\\]/g, "\\$&")}'`;

/**
 * One product search covering every part of a group (tags, collections,
 * picked products), ORed so a product matching several parts counts once.
 */
export function groupSearchQuery(target) {
  const terms = [];
  for (const part of splitTarget(target)) {
    for (const v of part.values) {
      if (part.type === "tag") terms.push(`tag:${quote(v)}`);
      else if (part.type === "collection") terms.push(`collection_id:${String(v).split("/").pop()}`);
      else if (part.type === "product") terms.push(`id:${String(v).split("/").pop()}`);
    }
  }
  return terms.length ? terms.join(" OR ") : null;
}

/**
 * "→ 6 products, 42 variants" for the group form. Counts up to 250 products
 * exactly (variants summed per product); beyond that `more` is true.
 */
export async function countGroup(admin, target) {
  const query = groupSearchQuery(target);
  if (!query) return { products: 0, variants: 0, more: false };
  const response = await admin.graphql(
    `#graphql
    query CartRulesGroupCount($query: String) {
      productsCount(query: $query) { count }
      products(first: 250, query: $query) { nodes { variantsCount { count } } }
    }`,
    { variables: { query } },
  );
  const json = await response.json();
  if (json.errors?.length) throw new Error(JSON.stringify(json.errors));
  const nodes = json.data?.products?.nodes ?? [];
  const products = json.data?.productsCount?.count ?? nodes.length;
  const variants = nodes.reduce((sum, n) => sum + (n.variantsCount?.count ?? 0), 0);
  return { products, variants, more: products > nodes.length };
}

/** { [ruleId]: number | null } — null when the count isn't known (e.g. "All products"). */
export async function getTargetProductCounts(admin, rules) {
  const result = {};
  const queries = []; // { ruleId, kind: "search"|"collection", arg }
  for (const rule of rules) {
    const t = rule.target;
    if (!t || t.type === TARGET_TYPES.ALL) {
      result[rule.id] = null;
    } else if (t.type === TARGET_TYPES.PRODUCT) {
      result[rule.id] = t.values.length;
    } else if (t.type === TARGET_TYPES.MIXED) {
      const q = groupSearchQuery(t);
      if (q) queries.push({ ruleId: rule.id, kind: "search", arg: q });
      else result[rule.id] = null;
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
  return result;
}
