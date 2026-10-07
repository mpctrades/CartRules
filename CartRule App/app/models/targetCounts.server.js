// How many products each rule's target covers ("Tag: Snow · 5 products" on
// the Rules page). Products/variants are counted from the rule itself; tags,
// vendors, types and collections are asked of Shopify in batched,
// aliased productsCount / collection.productsCount queries.
import { TARGET_TYPES } from "./ruleConstants";

const SEARCH_FIELD = { [TARGET_TYPES.TAG]: "tag", [TARGET_TYPES.VENDOR]: "vendor", [TARGET_TYPES.PRODUCT_TYPE]: "product_type" };
const quote = (v) => `'${String(v).replace(/['\\]/g, "\\$&")}'`;

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
