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

// Shop GIDs whose rules_cache metafield definition is known to exist. Keyed
// per shop: this module is shared by every shop served by this process, so a
// single boolean would skip the definition for every shop after the first.
const rulesCacheDefinitionEnsured = new Set();

/**
 * Gives the `cartrules.rules_cache` shop metafield storefront (Liquid) read
 * access, so the optional theme app extension (extensions/cartrules-notice)
 * can read it directly with `shop.metafields.cartrules.rules_cache` — no
 * definition means no Liquid/Storefront API access to an app-owned metafield.
 * Idempotent: swallows the "already exists" userError.
 */
async function ensureRulesCacheMetafieldDefinition(admin, shopGid) {
  if (rulesCacheDefinitionEnsured.has(shopGid)) return;
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
  rulesCacheDefinitionEnsured.add(shopGid);
}

// Handle of the checkout Function extension (extensions/cartrules-validation
// shopify.extension.toml `handle`).
export const VALIDATION_FUNCTION_HANDLE = "cartrules-validation";

/**
 * Reads the CartRules checkout validation as Shopify has it — the source of
 * truth for "is checkout enforcing rules right now". Returns null if the
 * validation has never been created in this store.
 */
export async function getValidation(admin) {
  const response = await admin.graphql(
    `#graphql
    query CartRulesValidations {
      validations(first: 25) {
        nodes {
          id
          enabled
          shopifyFunction { id handle }
        }
      }
    }`,
  );
  const json = await response.json();
  if (json.errors?.length) {
    throw new Error(`Could not read checkout validations: ${JSON.stringify(json.errors)}`);
  }
  const node = (json.data?.validations?.nodes ?? []).find(
    (v) => v.shopifyFunction?.handle === VALIDATION_FUNCTION_HANDLE,
  );
  return node ? { id: node.id, enabled: node.enabled } : null;
}

/**
 * Page-load status check used by the Overview and Rules pages. If there are
 * active rules but the validation was NEVER created in this store (e.g. rules
 * saved before this fix shipped, and the afterAuth hook hasn't re-run), create
 * it now so those rules are enforced. A validation that exists but is
 * disabled was turned off by the merchant in Shopify, so it's left alone and
 * reported instead. Returns true/false for "enforcing at checkout", or null
 * if the status couldn't be read (the page then skips the warning).
 */
export async function getCheckoutEnforcement(admin, activeRuleCount) {
  try {
    const validation = await getValidation(admin);
    if (validation) return validation.enabled;
    if (activeRuleCount > 0) {
      await ensureValidationActive(admin);
      return true;
    }
    return false;
  } catch (error) {
    console.error("Could not read or create checkout validation", error);
    return null;
  }
}

/**
 * Deploying the Function only makes it AVAILABLE to a store — Shopify doesn't
 * run it at checkout until a Validation record exists for it with
 * `enabled: true` (Settings → Checkout → Checkout rules). Without this the
 * rules_cache metafield is written correctly but nothing ever reads it, so
 * rules aren't enforced (App Store review 2.1.4). Idempotent: creates the
 * validation once, re-enables it if it was turned off, otherwise no-op.
 */
export async function ensureValidationActive(admin) {
  const existing = await getValidation(admin);

  if (existing?.enabled) return existing.id;

  if (existing) {
    const updateResponse = await admin.graphql(
      `#graphql
      mutation EnableCartRulesValidation($id: ID!, $validation: ValidationUpdateInput!) {
        validationUpdate(id: $id, validation: $validation) {
          validation { id enabled }
          userErrors { field message code }
        }
      }`,
      { variables: { id: existing.id, validation: { enable: true } } },
    );
    const updateJson = await updateResponse.json();
    const errors = updateJson.errors ?? updateJson.data?.validationUpdate?.userErrors;
    if (errors?.length || !updateJson.data?.validationUpdate) {
      throw new Error(`Could not enable checkout validation: ${JSON.stringify(errors)}`);
    }
    return existing.id;
  }

  const createResponse = await admin.graphql(
    `#graphql
    mutation CreateCartRulesValidation($validation: ValidationCreateInput!) {
      validationCreate(validation: $validation) {
        validation { id enabled }
        userErrors { field message code }
      }
    }`,
    {
      variables: {
        validation: {
          functionHandle: VALIDATION_FUNCTION_HANDLE,
          title: "CartRules",
          enable: true,
          // A Function runtime error (e.g. timeout) should not block every
          // checkout in the store — only real rule violations should.
          blockOnFailure: false,
        },
      },
    },
  );
  const createJson = await createResponse.json();
  const errors = createJson.errors ?? createJson.data?.validationCreate?.userErrors;
  if (errors?.length || !createJson.data?.validationCreate?.validation) {
    throw new Error(`Could not create checkout validation: ${JSON.stringify(errors ?? createJson)}`);
  }
  return createJson.data.validationCreate.validation.id;
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
    // Coerce to a whole number >= 1: a blank/0/"abc" value from the form
    // would otherwise be rejected by the number_integer field and surface
    // as an error page instead of a saved rule.
    const max = Math.floor(Number(data.maxQuantity));
    fields.push({ key: "max_quantity", value: String(Number.isFinite(max) && max >= 1 ? max : 1) });
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
 * update/status-change/delete, and on the products/* + collections/* webhooks
 * (resyncIfCatalogChangeAffectsRules, app/routes/webhooks.catalog.jsx).
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
 *
 * `activateValidation: false` is for background resyncs (product/collection
 * webhooks): those refresh the data but must not turn the checkout rule back
 * on if the merchant switched it off in Shopify's checkout settings.
 */
export async function syncRulesCache(admin, { activateValidation = true } = {}) {
  const shopGid = await getShopGid(admin);
  await ensureRulesCacheMetafieldDefinition(admin, shopGid);
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
            ownerId: shopGid,
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

  // The cache is only read if the checkout validation is live — make sure it
  // is, so a saved active rule is actually enforced at checkout.
  if (activateValidation && active.length > 0) {
    await ensureValidationActive(admin);
  }
}

/**
 * Keeps TAG/COLLECTION rules in step with the catalog (App Store requirement
 * 2.1.4). Those rules are expanded into product IDs at cache-build time (see
 * expandCollectionToProductIds), so without this a product tagged or added to
 * a targeted collection after the rule was saved would show as covered in the
 * app but not be enforced at checkout. Called from the products/* and
 * collections/update webhooks; only rebuilds when the change can affect an
 * active rule, since products/update fires often.
 */
export async function resyncIfCatalogChangeAffectsRules(admin, { productId, productTags, collectionId }) {
  const all = await listRules(admin);
  const dynamic = all.filter(
    (r) =>
      r.status === RULE_STATUS.ACTIVE &&
      (r.targetType === TARGET_TYPES.TAG || r.targetType === TARGET_TYPES.COLLECTION),
  );
  if (dynamic.length === 0) return false;

  let affected = false;
  if (collectionId) {
    affected = dynamic.some((r) => r.targetType === TARGET_TYPES.COLLECTION && r.targetValue === collectionId);
  }
  if (!affected && productId) {
    const tags = new Set((productTags ?? []).map((t) => t.trim().toLowerCase()).filter(Boolean));
    const cache = await readRulesCache(admin);
    const cachedIdsByRule = new Map(cache.rules.map((r) => [r.id, r.productIds ?? []]));
    affected = dynamic.some(
      (r) =>
        // Currently covered (tag removed / left the collection / deleted) …
        cachedIdsByRule.get(r.id)?.includes(productId) ||
        // … or newly matches a tag rule.
        (r.targetType === TARGET_TYPES.TAG && tags.has(String(r.targetValue).toLowerCase())),
    );
    const collectionRules = dynamic.filter((r) => r.targetType === TARGET_TYPES.COLLECTION);
    for (const rule of collectionRules) {
      if (affected) break;
      affected = await productInCollection(admin, productId, rule.targetValue);
    }
  }
  if (!affected) return false;

  await syncRulesCache(admin, { activateValidation: false });
  return true;
}

async function productInCollection(admin, productId, collectionId) {
  const response = await admin.graphql(
    `#graphql
    query CartRulesProductInCollection($productId: ID!, $collectionId: ID!) {
      product(id: $productId) { inCollection(id: $collectionId) }
    }`,
    { variables: { productId, collectionId } },
  );
  const json = await response.json();
  return Boolean(json.data?.product?.inCollection);
}

// Not cached: this module is shared by every shop served by this process,
// and `admin` doesn't expose which shop it belongs to, so a module-level
// cache would hand shop A's GID to shop B (metafieldsSet then fails with an
// owner error for every shop after the first one to load the app).
export async function getShopGid(admin) {
  const response = await admin.graphql(`#graphql
    query ShopGid { shop { id } }`);
  const json = await response.json();
  return json.data.shop.id;
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
