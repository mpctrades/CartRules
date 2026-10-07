// Rule health ("Needs attention") and rule conflicts, from real store data.
//
// Health — per rule:
//  - targeted products / variants / collections that were deleted;
//  - tags, vendors or product types that no product has any more;
//  - features the current plan doesn't include (after a downgrade);
//  - more tags/collections than the checkout can check (100 per list).
// Conflicts — two live quantity rules of the same type that cover at least
// one common product; the shared engine's conflict mode decides which wins.
import { TARGET_TYPES, RULE_TYPES, RULE_STATUS, CONFLICT_MODES, RULE_TYPE_INFO } from "./ruleConstants";
import { getScheduleStatus } from "./ruleDisplay";
import { lockedFeatures } from "./plan.server";
import { MAX_INPUT_VARIABLE_ITEMS } from "./rules.server";

const TTL_MS = 60 * 1000;
const healthCache = new Map(); // shop -> { key, at, value }

function signature(rules, plan, mode) {
  return JSON.stringify([plan, mode, rules.map((r) => [r.id, r.updatedAt, r.status])]);
}

async function gql(admin, query, variables) {
  const response = await admin.graphql(query, { variables });
  const json = await response.json();
  if (json.errors?.length) throw new Error(JSON.stringify(json.errors));
  return json.data;
}

const quote = (v) => `'${String(v).replace(/['\\]/g, "\\$&")}'`;
const SEARCH_FIELD = { [TARGET_TYPES.TAG]: "tag", [TARGET_TYPES.VENDOR]: "vendor", [TARGET_TYPES.PRODUCT_TYPE]: "product_type" };

function relevant(rule) {
  const s = getScheduleStatus(rule);
  return s === "active" || s === "scheduled";
}

/** Map ruleId -> { issues: [{ code, message }] } for every rule. */
async function computeHealth(admin, rules, plan) {
  const health = Object.fromEntries(rules.map((r) => [r.id, { issues: [] }]));
  const targets = [];
  for (const rule of rules) {
    for (const t of [rule.target, rule.comboTarget]) if (t && t.type !== TARGET_TYPES.ALL) targets.push({ rule, t });
  }

  // Deleted products / variants / collections.
  const ids = [
    ...new Set(
      targets
        .filter(({ t }) => [TARGET_TYPES.PRODUCT, TARGET_TYPES.VARIANT, TARGET_TYPES.COLLECTION].includes(t.type))
        .flatMap(({ t }) => t.values),
    ),
  ];
  const existing = new Set();
  for (let i = 0; i < ids.length; i += 250) {
    const data = await gql(
      admin,
      `#graphql
      query CartRulesTargetsExist($ids: [ID!]!) { nodes(ids: $ids) { id } }`,
      { ids: ids.slice(i, i + 250) },
    );
    for (const n of data?.nodes ?? []) if (n?.id) existing.add(n.id);
  }

  // Tags / vendors / types nobody has: one productsCount per distinct value.
  const searches = [
    ...new Map(
      targets
        .filter(({ t }) => SEARCH_FIELD[t.type])
        .flatMap(({ t }) => t.values.map((v) => [`${t.type}|${v.toLowerCase()}`, { type: t.type, value: v }])),
    ).values(),
  ].slice(0, 40);
  const counts = new Map();
  for (let i = 0; i < searches.length; i += 10) {
    const chunk = searches.slice(i, i + 10);
    const vars = Object.fromEntries(chunk.map((s, j) => [`q${j}`, `${SEARCH_FIELD[s.type]}:${quote(s.value)}`]));
    const query = `query CartRulesTargetCounts(${chunk.map((_, j) => `$q${j}: String`).join(", ")}) {
      ${chunk.map((_, j) => `c${j}: productsCount(query: $q${j}) { count }`).join("\n")}
    }`;
    const data = await gql(admin, query, vars);
    chunk.forEach((s, j) => counts.set(`${s.type}|${s.value.toLowerCase()}`, data?.[`c${j}`]?.count ?? 0));
  }

  const noun = {
    [TARGET_TYPES.PRODUCT]: ["targeted product was", "targeted products were"],
    [TARGET_TYPES.VARIANT]: ["targeted variant was", "targeted variants were"],
    [TARGET_TYPES.COLLECTION]: ["targeted collection was", "targeted collections were"],
  };
  for (const { rule, t } of targets) {
    const issues = health[rule.id].issues;
    if (noun[t.type]) {
      const missing = t.values.filter((v) => !existing.has(v)).length;
      if (missing) {
        issues.push({ code: "deleted_targets", message: `${missing} ${noun[t.type][missing === 1 ? 0 : 1]} deleted` });
      }
    } else if (SEARCH_FIELD[t.type]) {
      const empty = t.values.filter((v) => counts.get(`${t.type}|${v.toLowerCase()}`) === 0);
      if (empty.length) {
        const what = { tag: "tag", vendor: "vendor", product_type: "product type" }[t.type];
        issues.push({ code: "empty_target", message: `No products have the ${what} “${empty.join("”, “")}”` });
      }
    }
  }

  for (const rule of rules) {
    if (rule.status !== RULE_STATUS.ACTIVE) continue;
    const locked = lockedFeatures(rule, plan);
    if (locked.length) {
      const needs = locked.some((f) => f.plan === "Pro") ? "Pro" : "Growth";
      health[rule.id].issues.push({
        code: "plan",
        message: `Uses ${locked.map((f) => f.label.toLowerCase()).join(", ")} — requires the ${needs} plan`,
      });
    }
  }

  const tagCount = new Set(
    rules.filter(relevant).flatMap((r) =>
      [r.target, r.comboTarget].filter((t) => t?.type === TARGET_TYPES.TAG).flatMap((t) => t.values),
    ),
  ).size;
  const collectionCount = new Set(
    rules.filter(relevant).flatMap((r) =>
      [r.target, r.comboTarget].filter((t) => t?.type === TARGET_TYPES.COLLECTION).flatMap((t) => t.values),
    ),
  ).size;
  if (tagCount > MAX_INPUT_VARIABLE_ITEMS || collectionCount > MAX_INPUT_VARIABLE_ITEMS) {
    for (const r of rules.filter(relevant)) {
      if ([r.target, r.comboTarget].some((t) => t?.type === TARGET_TYPES.TAG || t?.type === TARGET_TYPES.COLLECTION)) {
        health[r.id].issues.push({
          code: "too_many_targets",
          message: `Your rules use more than ${MAX_INPUT_VARIABLE_ITEMS} different tags or collections — checkout only checks the first ${MAX_INPUT_VARIABLE_ITEMS}`,
        });
      }
    }
  }
  return health;
}

/** Product ids a target covers (capped at 250 per value — enough to detect overlap). */
async function sampleProducts(admin, target, memo) {
  if (target.type === TARGET_TYPES.ALL) return { all: true, ids: new Set(), titles: new Map() };
  const ids = new Set();
  const titles = new Map();
  const add = (nodes) => {
    for (const n of nodes ?? []) {
      if (!n?.id) continue;
      ids.add(n.id);
      titles.set(n.id, n.title);
    }
  };
  for (const value of target.values) {
    const key = `${target.type}|${value}`;
    if (!memo.has(key)) {
      let nodes = [];
      if (target.type === TARGET_TYPES.PRODUCT) {
        nodes = [{ id: value }];
      } else if (target.type === TARGET_TYPES.VARIANT) {
        const data = await gql(admin, `#graphql
          query CartRulesVariantProduct($id: ID!) { productVariant(id: $id) { product { id title } } }`, { id: value });
        nodes = data?.productVariant?.product ? [data.productVariant.product] : [];
      } else if (target.type === TARGET_TYPES.COLLECTION) {
        const data = await gql(admin, `#graphql
          query CartRulesCollectionSample($id: ID!) { collection(id: $id) { products(first: 250) { nodes { id title } } } }`, { id: value });
        nodes = data?.collection?.products?.nodes ?? [];
      } else if (SEARCH_FIELD[target.type]) {
        const data = await gql(admin, `#graphql
          query CartRulesSearchSample($query: String) { products(first: 250, query: $query) { nodes { id title } } }`, {
          query: `${SEARCH_FIELD[target.type]}:${quote(value)}`,
        });
        nodes = data?.products?.nodes ?? [];
      }
      memo.set(key, nodes);
    }
    add(memo.get(key));
  }
  return { all: false, ids, titles };
}

const QUANTITY_TYPES = [RULE_TYPES.MAX_QUANTITY, RULE_TYPES.MIN_QUANTITY, RULE_TYPES.QUANTITY_MULTIPLE];

function winnerOf(a, b, mode) {
  if (mode === CONFLICT_MODES.PRIORITY && (a.priority || 0) !== (b.priority || 0)) {
    return (a.priority || 0) > (b.priority || 0) ? a : b;
  }
  if (a.ruleType === RULE_TYPES.MAX_QUANTITY) return Number(b.value) < Number(a.value) ? b : a;
  return Number(b.value) > Number(a.value) ? b : a;
}

function valuePhrase(rule) {
  if (rule.ruleType === RULE_TYPES.MAX_QUANTITY) return `Maximum ${rule.value}`;
  if (rule.ruleType === RULE_TYPES.MIN_QUANTITY) return `Minimum ${rule.value}`;
  return `Multiples of ${rule.value}`;
}

/** [{ ruleIds, ruleType, productTitle, sharedCount, winnerId, message }] */
async function computeConflicts(admin, rules, mode) {
  const live = rules.filter((r) => relevant(r) && QUANTITY_TYPES.includes(r.ruleType));
  const memo = new Map();
  const samples = new Map();
  for (const r of live) samples.set(r.id, await sampleProducts(admin, r.target, memo));

  const conflicts = [];
  for (let i = 0; i < live.length; i++) {
    for (let j = i + 1; j < live.length; j++) {
      const a = live[i];
      const b = live[j];
      if (a.ruleType !== b.ruleType) continue;
      const sa = samples.get(a.id);
      const sb = samples.get(b.id);
      let shared = [];
      let titles = sa.titles.size ? sa.titles : sb.titles;
      if (sa.all && sb.all) shared = ["*"];
      else if (sa.all) shared = [...sb.ids];
      else if (sb.all) shared = [...sa.ids];
      else shared = [...sa.ids].filter((id) => sb.ids.has(id));
      if (shared.length === 0) continue;
      const winner = winnerOf(a, b, mode);
      const loser = winner === a ? b : a;
      const productTitle = shared[0] === "*" ? null : (sa.titles.get(shared[0]) ?? sb.titles.get(shared[0]) ?? titles.get(shared[0]));
      const subject =
        shared[0] === "*"
          ? "Every product matches 2 rules"
          : shared.length === 1
            ? `${productTitle ?? "A product"} matches 2 rules`
            : `${shared.length} products match 2 rules`;
      const reason =
        mode === CONFLICT_MODES.PRIORITY && (a.priority || 0) !== (b.priority || 0)
          ? `“${winner.title}” has the higher priority`
          : "the most restrictive rule wins";
      conflicts.push({
        ruleIds: [a.id, b.id],
        ruleType: a.ruleType,
        productTitle,
        sharedCount: shared[0] === "*" ? null : shared.length,
        winnerId: winner.id,
        loserId: loser.id,
        message: `${subject}: “${a.title}” (${valuePhrase(a)}) and “${b.title}” (${valuePhrase(b)}). ${valuePhrase(winner)} will apply because ${reason}.`,
        typeLabel: RULE_TYPE_INFO[a.ruleType]?.title,
      });
    }
  }
  return conflicts;
}

/**
 * { health: { [ruleId]: { issues } }, conflicts: [...] } — cached for a
 * minute per shop and rule set, since it costs several Admin API calls.
 */
export async function getRulesHealth(admin, shop, rules, { plan, conflictMode }) {
  const key = signature(rules, plan, conflictMode);
  const hit = healthCache.get(shop);
  if (hit && hit.key === key && Date.now() - hit.at < TTL_MS) return hit.value;
  let value;
  try {
    const [health, conflicts] = await Promise.all([
      computeHealth(admin, rules, plan),
      computeConflicts(admin, rules, conflictMode ?? CONFLICT_MODES.MOST_RESTRICTIVE),
    ]);
    value = { health, conflicts };
  } catch (error) {
    console.error("Rule health check failed", { shop, error: error?.message ?? String(error) });
    value = { health: {}, conflicts: [], failed: true };
  }
  healthCache.set(shop, { key, at: Date.now(), value });
  return value;
}

export function clearHealthCache(shop) {
  healthCache.delete(shop);
}
