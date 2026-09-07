// Data layer for CartRules. There is NO app database for rules — see
// README "Why no database?". A rule is a Shopify metaobject
// (type "cartrules_rule") that lives inside the merchant's own store, so
// uninstalling the app cleanly removes it and nothing is orphaned on our side.
//
// The Shopify Function that runs at checkout (extensions/cartrules-validation)
// cannot cheaply query metaobjects itself, so every write here also rebuilds
// a single JSON snapshot of the ACTIVE rules into a shop-level metafield
// (namespace "cartrules", key "rules_cache"). That metafield is the only
// thing the Function reads. This trades a little duplication for a checkout
// path that is fast and doesn't depend on metaobject query shape changes.

import { RULE_TYPES, TARGET_TYPES, RULE_STATUS } from "./ruleConstants";
import { getSettings } from "./settings.server";

export const METAOBJECT_TYPE = "cartrules_rule";
export const CACHE_NAMESPACE = "cartrules";
export const CACHE_KEY = "rules_cache";

// Re-exported for existing server-side callers; new code (and anything used
// from a route component) should import these from ./ruleConstants directly.
export { RULE_TYPES, TARGET_TYPES, RULE_STATUS };

/**
 * Creates the "cartrules_rule" metaobject definition if it doesn't exist yet.
 * Safe to call on every app load / OAuth callback — it's a no-op if present.
 */
export async function ensureMetaobjectDefinition(admin) {
  const existing = await admin.graphql(
    `#graphql
    query CartRulesDefinition($type: String!) {
      metaobjectDefinitionByType(type: $type) { id }
    }`,
    { variables: { type: METAOBJECT_TYPE } },
  );
  const existingJson = await existing.json();
  if (existingJson.data?.metaobjectDefinitionByType?.id) {
    return existingJson.data.metaobjectDefinitionByType.id;
  }

  const response = await admin.graphql(
    `#graphql
    mutation CreateCartRulesDefinition($definition: MetaobjectDefinitionCreateInput!) {
      metaobjectDefinitionCreate(definition: $definition) {
        metaobjectDefinition { id }
        userErrors { field message }
      }
    }`,
    {
      variables: {
        definition: {
          type: METAOBJECT_TYPE,
          name: "CartRules rule",
          fieldDefinitions: [
            { key: "title", name: "Title", type: "single_line_text_field" },
            { key: "rule_type", name: "Rule type", type: "single_line_text_field" },
            { key: "target_type", name: "Target type", type: "single_line_text_field" },
            { key: "target_value", name: "Target value", type: "single_line_text_field" },
            { key: "max_quantity", name: "Max quantity", type: "number_integer" },
            { key: "message", name: "Customer message", type: "multi_line_text_field" },
            { key: "status", name: "Status", type: "single_line_text_field" },
          ],
        },
      },
    },
  );
  const json = await response.json();
  const errors = json.data?.metaobjectDefinitionCreate?.userErrors;
  if (errors?.length) {
    throw new Error(
      `Could not create cartrules_rule metaobject definition: ${JSON.stringify(errors)}`,
    );
  }
  return json.data.metaobjectDefinitionCreate.metaobjectDefinition.id;
}

let rulesCacheDefinitionEnsured = false;

/**
 * Gives the `cartrules.rules_cache` shop metafield storefront (Liquid) read
 * access, so the optional theme app extension (extensions/cartrules-notice)
 * can read it directly with `shop.metafields.cartrules.rules_cache` — no
 * definition means no Liquid/Storefront API access to an app-owned metafield.
 * Idempotent: swallows the "already exists" userError.
 */
async function ensureRulesCacheMetafieldDefinition(admin) {
  if (rulesCacheDefinitionEnsured) return;
  const response = await admin.graphql(
    `#graphql
    mutation EnsureRulesCacheDefinition($definition: MetafieldDefinitionInput!) {
      metafieldDefinitionCreate(definition: $definition) {
        createdDefinition { id }
        userErrors { field message code }
      }
    }`,
    {
      variables: {
        definition: {
          name: "CartRules rules cache",
          namespace: CACHE_NAMESPACE,
          key: CACHE_KEY,
          type: "json",
          ownerType: "SHOP",
          access: { storefront: "PUBLIC_READ" },
        },
      },
    },
  );
  const json = await response.json();
  const errors = json.data?.metafieldDefinitionCreate?.userErrors ?? [];
  const alreadyExists = errors.some((e) => e.code === "TAKEN");
  if (errors.length && !alreadyExists) {
    throw new Error(`Could not create rules_cache metafield definition: ${JSON.stringify(errors)}`);
  }
  rulesCacheDefinitionEnsured = true;
}

function fieldsToObject(fields) {
  const obj = {};
  for (const f of fields) obj[f.key] = f.value;
  return obj;
}

function ruleFromMetaobject(node) {
  const f = fieldsToObject(node.fields);
  return {
    id: node.id,
    title: f.title ?? "",
    ruleType: f.rule_type,
    targetType: f.target_type,
    targetValue: f.target_value,
    maxQuantity: f.max_quantity ? parseInt(f.max_quantity, 10) : null,
    message: f.message ?? "",
    status: f.status ?? RULE_STATUS.ACTIVE,
  };
}

/** Lists every rule (active and paused) for the dashboard, F4. */
export async function listRules(admin) {
  const response = await admin.graphql(
    `#graphql
    query ListCartRules {
      metaobjects(type: "${METAOBJECT_TYPE}", first: 250, sortKey: "updated_at", reverse: true) {
        nodes {
          id
          fields { key value }
        }
      }
    }`,
  );
  const json = await response.json();
  return (json.data?.metaobjects?.nodes ?? []).map(ruleFromMetaobject);
}

function ruleToFields(data) {
  const fields = [
    { key: "title", value: data.title ?? "" },
    { key: "rule_type", value: data.ruleType },
    { key: "target_type", value: data.targetType },
    { key: "target_value", value: data.targetValue },
    { key: "message", value: data.message ?? "" },
    { key: "status", value: data.status ?? RULE_STATUS.ACTIVE },
  ];
  if (data.ruleType === RULE_TYPES.MAX_QUANTITY) {
    fields.push({ key: "max_quantity", value: String(data.maxQuantity ?? 1) });
  }
  return fields;
}

/** Creates a rule from the 3-step wizard (F1/F2/F3) and refreshes the checkout cache. */
export async function createRule(admin, data) {
  await ensureMetaobjectDefinition(admin);
  const response = await admin.graphql(
    `#graphql
    mutation CreateCartRule($metaobject: MetaobjectCreateInput!) {
      metaobjectCreate(metaobject: $metaobject) {
        metaobject { id }
        userErrors { field message }
      }
    }`,
    {
      variables: {
        metaobject: { type: METAOBJECT_TYPE, fields: ruleToFields(data) },
      },
    },
  );
  const json = await response.json();
  const errors = json.data?.metaobjectCreate?.userErrors;
  if (errors?.length) {
    throw new Error(`Could not create rule: ${JSON.stringify(errors)}`);
  }
  await syncRulesCache(admin);
  return json.data.metaobjectCreate.metaobject.id;
}

/** Updates an existing rule (edit screen) and refreshes the checkout cache. */
export async function updateRule(admin, id, data) {
  const response = await admin.graphql(
    `#graphql
    mutation UpdateCartRule($id: ID!, $metaobject: MetaobjectUpdateInput!) {
      metaobjectUpdate(id: $id, metaobject: $metaobject) {
        metaobject { id }
        userErrors { field message }
      }
    }`,
    { variables: { id, metaobject: { fields: ruleToFields(data) } } },
  );
  const json = await response.json();
  const errors = json.data?.metaobjectUpdate?.userErrors;
  if (errors?.length) {
    throw new Error(`Could not update rule: ${JSON.stringify(errors)}`);
  }
  await syncRulesCache(admin);
}

/** Copies an existing rule as a new PAUSED rule (merchant reviews/renames before activating). */
export async function duplicateRule(admin, id) {
  const rules = await listRules(admin);
  const source = rules.find((r) => r.id === id);
  if (!source) throw new Error(`Could not duplicate rule: ${id} not found`);
  return createRule(admin, {
    title: `${source.title || "Untitled rule"} (copy)`,
    ruleType: source.ruleType,
    targetType: source.targetType,
    targetValue: source.targetValue,
    maxQuantity: source.maxQuantity,
    message: source.message,
    status: RULE_STATUS.PAUSED,
  });
}

/** Toggles ACTIVE / PAUSED from the dashboard (F4). */
export async function setRuleStatus(admin, id, status) {
  const response = await admin.graphql(
    `#graphql
    mutation SetCartRuleStatus($id: ID!, $metaobject: MetaobjectUpdateInput!) {
      metaobjectUpdate(id: $id, metaobject: $metaobject) {
        userErrors { field message }
      }
    }`,
    { variables: { id, metaobject: { fields: [{ key: "status", value: status }] } } },
  );
  const json = await response.json();
  const errors = json.data?.metaobjectUpdate?.userErrors;
  if (errors?.length) {
    throw new Error(`Could not change rule status: ${JSON.stringify(errors)}`);
  }
  await syncRulesCache(admin);
}

export async function deleteRule(admin, id) {
  const response = await admin.graphql(
    `#graphql
    mutation DeleteCartRule($id: ID!) {
      metaobjectDelete(id: $id) { deletedId userErrors { field message } }
    }`,
    { variables: { id } },
  );
  const json = await response.json();
  const errors = json.data?.metaobjectDelete?.userErrors;
  if (errors?.length) {
    throw new Error(`Could not delete rule: ${JSON.stringify(errors)}`);
  }
  await syncRulesCache(admin);
}

/**
 * The cart-and-checkout-validation Function input schema exposes cart line
 * merchandise -> product { id }, plus `hasAnyTag`/`hasTags` predicates that
 * take a fixed, query-authoring-time list of tags — it does NOT expose a
 * plain product.tags list, and it does NOT expose collection membership.
 * Since our rules (and the tags/collections they target) are defined by the
 * merchant at runtime, neither shape can be checked from inside the Function.
 * So both COLLECTION- and TAG-targeted rules are resolved here, at
 * cache-build time, on the admin side (which has the full Admin GraphQL
 * schema), by expanding them into concrete member product IDs. That means a
 * product added to a targeted collection/tag AFTER the rule was saved won't
 * be covered until the cache is rebuilt. We rebuild on every rule create/
 * update/status-change/delete; if that staleness window matters for a given
 * store, add a `products/update` + `collections/update` webhook that calls
 * syncRulesCache(admin) again. Not implemented in v1 — flagged here on purpose.
 */
async function expandCollectionToProductIds(admin, collectionGid) {
  const productIds = [];
  let cursor = null;
  // Cap at 500 products per collection so a huge collection can't blow up
  // the rules_cache metafield (Shopify metafields have a value size limit).
  for (let page = 0; page < 5; page++) {
    const response = await admin.graphql(
      `#graphql
      query CollectionProducts($id: ID!, $cursor: String) {
        collection(id: $id) {
          products(first: 100, after: $cursor) {
            nodes { id }
            pageInfo { hasNextPage endCursor }
          }
        }
      }`,
      { variables: { id: collectionGid, cursor } },
    );
    const json = await response.json();
    const conn = json.data?.collection?.products;
    if (!conn) break;
    productIds.push(...conn.nodes.map((n) => n.id));
    if (!conn.pageInfo.hasNextPage) break;
    cursor = conn.pageInfo.endCursor;
  }
  return productIds;
}

/**
 * Same rationale and pagination cap as expandCollectionToProductIds — see
 * that function's comment. Uses the product search `tag:` filter, which
 * matches products carrying the exact tag.
 */
async function expandTagToProductIds(admin, tag) {
  const productIds = [];
  let cursor = null;
  for (let page = 0; page < 5; page++) {
    const response = await admin.graphql(
      `#graphql
      query ProductsByTag($query: String!, $cursor: String) {
        products(first: 100, after: $cursor, query: $query) {
          nodes { id }
          pageInfo { hasNextPage endCursor }
        }
      }`,
      { variables: { query: `tag:${JSON.stringify(tag)}`, cursor } },
    );
    const json = await response.json();
    const conn = json.data?.products;
    if (!conn) break;
    productIds.push(...conn.nodes.map((n) => n.id));
    if (!conn.pageInfo.hasNextPage) break;
    cursor = conn.pageInfo.endCursor;
  }
  return productIds;
}

/**
 * Rebuilds the `cartrules.rules_cache` shop metafield from every ACTIVE
 * metaobject rule. This is the JSON the Shopify Function reads at checkout —
 * see extensions/cartrules-validation/src/index.js.
 */
export async function syncRulesCache(admin) {
  await ensureRulesCacheMetafieldDefinition(admin);
  const all = await listRules(admin);
  const active = all.filter((r) => r.status === RULE_STATUS.ACTIVE);
  const settings = await getSettings(admin);

  const resolved = [];
  for (const rule of active) {
    const base = {
      id: rule.id,
      // `title` isn't read by the checkout Function (index.js only uses
      // matchType/productIds/maxQuantity/message) — it's carried through
      // here purely so the orders/create webhook can label activity-log
      // events with the merchant's own rule name instead of just its
      // customer-facing message. See app/models/events.server.js.
      title: rule.title,
      ruleType: rule.ruleType,
      message: rule.message,
      maxQuantity: rule.maxQuantity,
    };
    if (rule.targetType === TARGET_TYPES.PRODUCT) {
      resolved.push({ ...base, matchType: "product_id", productIds: [rule.targetValue] });
    } else if (rule.targetType === TARGET_TYPES.TAG) {
      const productIds = await expandTagToProductIds(admin, rule.targetValue);
      resolved.push({ ...base, matchType: "product_id", productIds });
    } else if (rule.targetType === TARGET_TYPES.COLLECTION) {
      const productIds = await expandCollectionToProductIds(admin, rule.targetValue);
      resolved.push({ ...base, matchType: "product_id", productIds });
    }
  }

  // Most restrictive wins: if more than one active max_quantity rule matches
  // the same product (e.g. a tag rule and a product-specific rule overlap),
  // only the rule with the lowest cap should actually fire at checkout —
  // otherwise the Function pushes one redundant/contradictory error per
  // matching rule for the same cart line. Ties keep whichever rule was
  // resolved first (stable, since listRules sorts by updated_at desc).
  const productMinCap = new Map();
  for (const rule of resolved) {
    if (rule.ruleType !== RULE_TYPES.MAX_QUANTITY || !rule.maxQuantity) continue;
    for (const pid of rule.productIds ?? []) {
      const current = productMinCap.get(pid);
      if (current == null || rule.maxQuantity < current) productMinCap.set(pid, rule.maxQuantity);
    }
  }
  const winningRuleForProduct = new Map();
  for (const rule of resolved) {
    if (rule.ruleType !== RULE_TYPES.MAX_QUANTITY || !rule.maxQuantity) continue;
    for (const pid of rule.productIds ?? []) {
      if (productMinCap.get(pid) === rule.maxQuantity && !winningRuleForProduct.has(pid)) {
        winningRuleForProduct.set(pid, rule.id);
      }
    }
  }
  for (const rule of resolved) {
    if (rule.ruleType !== RULE_TYPES.MAX_QUANTITY) continue;
    rule.productIds = (rule.productIds ?? []).filter((pid) => winningRuleForProduct.get(pid) === rule.id);
  }

  const response = await admin.graphql(
    `#graphql
    mutation SyncRulesCache($metafields: [MetafieldsSetInput!]!) {
      metafieldsSet(metafields: $metafields) {
        userErrors { field message }
      }
    }`,
    {
      variables: {
        metafields: [
          {
            ownerId: await getShopGid(admin),
            namespace: CACHE_NAMESPACE,
            key: CACHE_KEY,
            type: "json",
            value: JSON.stringify({
              rules: resolved,
              enabled: settings.protectionEnabled,
              productNoticesEnabled: settings.productNoticesEnabled,
              cartNoticesEnabled: settings.cartNoticesEnabled,
              generatedAt: new Date().toISOString(),
            }),
          },
        ],
      },
    },
  );
  const json = await response.json();
  const errors = json.data?.metafieldsSet?.userErrors;
  if (errors?.length) {
    throw new Error(`Could not sync rules cache metafield: ${JSON.stringify(errors)}`);
  }
}

let cachedShopGid = null;
export async function getShopGid(admin) {
  if (cachedShopGid) return cachedShopGid;
  const response = await admin.graphql(`#graphql
    query { shop { id } }`);
  const json = await response.json();
  cachedShopGid = json.data.shop.id;
  return cachedShopGid;
}

/**
 * Reads back the exact JSON blob the checkout Function reads (see
 * extensions/cartrules-validation) — used by the dashboard/analytics layer
 * to reason about "what rules were actually live" without re-deriving it
 * from the metaobjects (which could disagree if a sync is in flight).
 */
export async function readRulesCache(admin) {
  const response = await admin.graphql(
    `#graphql
    query ReadCartRulesCache {
      shop {
        metafield(namespace: "${CACHE_NAMESPACE}", key: "${CACHE_KEY}") { value }
      }
    }`,
  );
  const json = await response.json();
  const raw = json.data?.shop?.metafield?.value;
  if (!raw) return { rules: [] };
  try {
    const parsed = JSON.parse(raw);
    return { rules: Array.isArray(parsed.rules) ? parsed.rules : [] };
  } catch (_err) {
    return { rules: [] };
  }
}

/** Enforces the Free-plan cap (brief section 08: 3 active rules on Free). */
export async function countActiveRules(admin) {
  const all = await listRules(admin);
  return all.filter((r) => r.status === RULE_STATUS.ACTIVE).length;
}

const SETUP_FLAGS_KEY = "setup_flags";

/**
 * Small merchant-self-attested checklist flags (currently just "I added the
 * storefront message block in the theme editor") — we have no reliable way
 * to detect that automatically (it'd mean parsing every template JSON in
 * the active theme for our app block), so rather than fake it, the
 * dashboard checklist lets the merchant mark it done themselves.
 */
export async function getSetupFlags(admin) {
  const response = await admin.graphql(
    `#graphql
    query ReadCartRulesSetupFlags {
      shop {
        metafield(namespace: "${CACHE_NAMESPACE}", key: "${SETUP_FLAGS_KEY}") { value }
      }
    }`,
  );
  const json = await response.json();
  const raw = json.data?.shop?.metafield?.value;
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch (_err) {
    return {};
  }
}

export async function setSetupFlag(admin, key, value) {
  const flags = await getSetupFlags(admin);
  flags[key] = value;
  const response = await admin.graphql(
    `#graphql
    mutation WriteCartRulesSetupFlags($metafields: [MetafieldsSetInput!]!) {
      metafieldsSet(metafields: $metafields) {
        userErrors { field message }
      }
    }`,
    {
      variables: {
        metafields: [
          {
            ownerId: await getShopGid(admin),
            namespace: CACHE_NAMESPACE,
            key: SETUP_FLAGS_KEY,
            type: "json",
            value: JSON.stringify(flags),
          },
        ],
      },
    },
  );
  const json = await response.json();
  const errors = json.data?.metafieldsSet?.userErrors;
  if (errors?.length) {
    throw new Error(`Could not write setup flags metafield: ${JSON.stringify(errors)}`);
  }
}
