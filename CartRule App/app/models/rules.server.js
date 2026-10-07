// Data layer for CartRules rules. Rule DEFINITIONS live in Shopify — a rule
// is a metaobject (type "cartrules_rule") inside the merchant's own store,
// so uninstalling the app cleanly removes it (README "Why no database?").
//
// The checkout Function (extensions/cartrules-validation) can't query
// metaobjects, so every write here also rebuilds a compact JSON snapshot of
// the rules that are live right now into the `cartrules.rules_cache` shop
// metafield. The Function and the theme blocks read that snapshot; both run
// the same engine (extensions/cartrules-validation/src/engine.js).
//
// Tag/collection/customer-tag rules are NOT expanded into product lists any
// more: the Function checks membership itself through hasTags/inCollections,
// fed by input query variables stored on the Validation. That keeps the
// cache small (no ~250-product ceiling) and means a newly tagged product is
// covered immediately, with no catalog webhooks.

import db from "../db.server";
import {
  RULE_TYPES,
  TARGET_TYPES,
  RULE_STATUS,
  CUSTOMER_TYPES,
  MARKET_TYPES,
  CONDITION_FIELDS,
  CONFLICT_MODES,
  RULE_TYPE_INFO,
} from "./ruleConstants";
import { isLive } from "./ruleDisplay";
import { getSettings, getDefaultMessages } from "./settings.server";
import { collectInputVariables } from "../../extensions/cartrules-validation/src/engine.js";

export const METAOBJECT_TYPE = "cartrules_rule";
export const CACHE_NAMESPACE = "cartrules";
export const CACHE_KEY = "rules_cache";
// Read by the Function as input query variables — must match
// [extensions.input.variables] in extensions/cartrules-validation/shopify.extension.toml.
const VARIABLES_NAMESPACE = "$app:cartrules";
const VARIABLES_KEY = "function_variables";
// Shopify caps each list-type input variable at 100 elements.
export const MAX_INPUT_VARIABLE_ITEMS = 100;

// Shopify Functions don't receive metafield values over 10,000 bytes — the
// Function's input gets `null` instead, and enforces nothing.
export const FUNCTION_METAFIELD_MAX_BYTES = 10000;

/**
 * Thrown when a rule write succeeded but rebuilding the checkout cache
 * afterwards failed — callers must not report the write itself as failed,
 * or a retry creates a duplicate rule.
 */
export class RulesCacheSyncError extends Error {
  constructor(cause) {
    super(`Rule saved, but the checkout cache sync failed: ${cause?.message ?? cause}`);
    this.name = "RulesCacheSyncError";
    this.cause = cause;
  }
}

export { RULE_TYPES, TARGET_TYPES, RULE_STATUS };

async function gql(admin, query, variables) {
  const response = await admin.graphql(query, variables ? { variables } : undefined);
  const json = await response.json();
  if (json.errors?.length) throw new Error(JSON.stringify(json.errors));
  return json.data;
}

const FIELD_DEFINITIONS = [
  { key: "title", name: "Title", type: "single_line_text_field" },
  { key: "rule_type", name: "Rule type", type: "single_line_text_field" },
  { key: "target_type", name: "Target type", type: "single_line_text_field" },
  { key: "target_value", name: "Target value", type: "single_line_text_field" },
  { key: "max_quantity", name: "Max quantity", type: "number_integer" },
  { key: "message", name: "Customer message", type: "multi_line_text_field" },
  { key: "status", name: "Status", type: "single_line_text_field" },
  // Everything added after v1 (targets, conditions, schedule, priority…).
  { key: "config", name: "Configuration", type: "json" },
];

// Shops whose definition is known to have every field above.
const definitionReady = new Set();

/**
 * Creates the "cartrules_rule" metaobject definition, or adds any field
 * that's missing from one created by an older version. Safe to call often.
 */
export async function ensureMetaobjectDefinition(admin, shopKey = "default") {
  if (definitionReady.has(shopKey)) return;
  const existing = await gql(
    admin,
    `#graphql
    query CartRulesDefinition($type: String!) {
      metaobjectDefinitionByType(type: $type) { id fieldDefinitions { key } }
    }`,
    { type: METAOBJECT_TYPE },
  );
  const def = existing?.metaobjectDefinitionByType;
  if (def?.id) {
    const have = new Set(def.fieldDefinitions.map((f) => f.key));
    const missing = FIELD_DEFINITIONS.filter((f) => !have.has(f.key));
    if (missing.length) {
      const data = await gql(
        admin,
        `#graphql
        mutation AddCartRulesFields($id: ID!, $definition: MetaobjectDefinitionUpdateInput!) {
          metaobjectDefinitionUpdate(id: $id, definition: $definition) {
            metaobjectDefinition { id }
            userErrors { field message code }
          }
        }`,
        { id: def.id, definition: { fieldDefinitions: missing.map((f) => ({ create: f })) } },
      );
      const errors = data?.metaobjectDefinitionUpdate?.userErrors;
      if (errors?.length) throw new Error(`Could not update cartrules_rule definition: ${JSON.stringify(errors)}`);
    }
    definitionReady.add(shopKey);
    return;
  }

  const data = await gql(
    admin,
    `#graphql
    mutation CreateCartRulesDefinition($definition: MetaobjectDefinitionCreateInput!) {
      metaobjectDefinitionCreate(definition: $definition) {
        metaobjectDefinition { id }
        userErrors { field message }
      }
    }`,
    { definition: { type: METAOBJECT_TYPE, name: "CartRules rule", fieldDefinitions: FIELD_DEFINITIONS } },
  );
  const errors = data?.metaobjectDefinitionCreate?.userErrors;
  if (errors?.length) throw new Error(`Could not create cartrules_rule definition: ${JSON.stringify(errors)}`);
  definitionReady.add(shopKey);
}

// Shop GIDs whose rules_cache metafield definition is known to exist.
const rulesCacheDefinitionEnsured = new Set();

/**
 * Gives the `cartrules.rules_cache` shop metafield storefront (Liquid) read
 * access so the theme blocks can read it. Idempotent.
 */
async function ensureRulesCacheMetafieldDefinition(admin, shopGid) {
  if (rulesCacheDefinitionEnsured.has(shopGid)) return;
  const data = await gql(
    admin,
    `#graphql
    mutation EnsureRulesCacheDefinition($definition: MetafieldDefinitionInput!) {
      metafieldDefinitionCreate(definition: $definition) {
        createdDefinition { id }
        userErrors { field message code }
      }
    }`,
    {
      definition: {
        name: "CartRules rules cache",
        namespace: CACHE_NAMESPACE,
        key: CACHE_KEY,
        type: "json",
        ownerType: "SHOP",
        access: { storefront: "PUBLIC_READ" },
      },
    },
  );
  const errors = data?.metafieldDefinitionCreate?.userErrors ?? [];
  if (errors.length && !errors.some((e) => e.code === "TAKEN")) {
    throw new Error(`Could not create rules_cache metafield definition: ${JSON.stringify(errors)}`);
  }
  rulesCacheDefinitionEnsured.add(shopGid);
}

export const VALIDATION_FUNCTION_HANDLE = "cartrules-validation";

/**
 * Reads the CartRules checkout validation as Shopify has it — the source of
 * truth for "is checkout enforcing rules right now". Null if never created.
 */
export async function getValidation(admin) {
  const data = await gql(
    admin,
    `#graphql
    query CartRulesValidations {
      validations(first: 25) {
        nodes { id enabled shopifyFunction { id handle } }
      }
    }`,
  );
  const node = (data?.validations?.nodes ?? []).find((v) => v.shopifyFunction?.handle === VALIDATION_FUNCTION_HANDLE);
  return node ? { id: node.id, enabled: node.enabled } : null;
}

/**
 * Page-load status check. If there are live rules but the validation was
 * NEVER created, create it so they're enforced. A validation that exists
 * but is disabled was turned off by the merchant in Shopify — left alone and
 * reported instead. Returns true/false, or null if it couldn't be read.
 */
export async function getCheckoutEnforcement(admin, activeRuleCount) {
  try {
    const validation = await getValidation(admin);
    if (validation) return validation.enabled;
    if (activeRuleCount > 0) {
      await ensureValidationActive(admin);
      await syncRulesCache(admin, { activateValidation: false });
      return true;
    }
    return false;
  } catch (error) {
    console.error("Could not read or create checkout validation", error);
    return null;
  }
}

/**
 * Deploying the Function only makes it AVAILABLE — Shopify doesn't run it
 * until a Validation exists for it with `enabled: true`. Idempotent.
 */
export async function ensureValidationActive(admin) {
  const existing = await getValidation(admin);
  if (existing?.enabled) return existing.id;

  if (existing) {
    const data = await gql(
      admin,
      `#graphql
      mutation EnableCartRulesValidation($id: ID!, $validation: ValidationUpdateInput!) {
        validationUpdate(id: $id, validation: $validation) {
          validation { id enabled }
          userErrors { field message code }
        }
      }`,
      { id: existing.id, validation: { enable: true } },
    );
    const errors = data?.validationUpdate?.userErrors;
    if (errors?.length || !data?.validationUpdate) {
      throw new Error(`Could not enable checkout validation: ${JSON.stringify(errors)}`);
    }
    return existing.id;
  }

  const data = await gql(
    admin,
    `#graphql
    mutation CreateCartRulesValidation($validation: ValidationCreateInput!) {
      validationCreate(validation: $validation) {
        validation { id enabled }
        userErrors { field message code }
      }
    }`,
    {
      validation: {
        functionHandle: VALIDATION_FUNCTION_HANDLE,
        title: "CartRules",
        enable: true,
        // A Function runtime error must not block every checkout.
        blockOnFailure: false,
      },
    },
  );
  const errors = data?.validationCreate?.userErrors;
  if (errors?.length || !data?.validationCreate?.validation) {
    throw new Error(`Could not create checkout validation: ${JSON.stringify(errors ?? data)}`);
  }
  return data.validationCreate.validation.id;
}

// ---------------------------------------------------------------------------
// Rule shape
// ---------------------------------------------------------------------------

function fieldsToObject(fields) {
  const obj = {};
  for (const f of fields) obj[f.key] = f.value;
  return obj;
}

function parseJson(raw, fallback) {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw);
  } catch (_e) {
    return fallback;
  }
}

/**
 * Normalized rule used everywhere in the app. Rules saved by v1 (only
 * target_type/target_value/max_quantity, no `config`) map onto the same shape.
 */
function ruleFromMetaobject(node) {
  const f = fieldsToObject(node.fields);
  const config = parseJson(f.config, {});
  const legacyTarget = f.target_type
    ? { type: f.target_type, values: f.target_value ? [f.target_value] : [], labels: [] }
    : { type: TARGET_TYPES.ALL, values: [], labels: [] };
  if (legacyTarget.type === TARGET_TYPES.PRODUCT && f.title && !config.target) legacyTarget.labels = [f.title];
  if (legacyTarget.type === TARGET_TYPES.TAG) legacyTarget.labels = legacyTarget.values;
  return {
    id: node.id,
    updatedAt: node.updatedAt ?? null,
    title: f.title ?? "",
    ruleType: f.rule_type,
    status: f.status ?? RULE_STATUS.ACTIVE,
    message: f.message ?? "",
    value: config.value ?? (f.max_quantity ? Number(f.max_quantity) : null),
    target: config.target ?? legacyTarget,
    comboTarget: config.comboTarget ?? null,
    customer: config.customer ?? { type: CUSTOMER_TYPES.EVERYONE, tags: [] },
    market: config.market ?? { type: MARKET_TYPES.ALL, countries: [], marketIds: [], labels: [] },
    conditions: Array.isArray(config.conditions) ? config.conditions : [],
    schedule: config.schedule ?? { startsAt: null, endsAt: null },
    priority: Number.isFinite(Number(config.priority)) ? Number(config.priority) : 0,
    templateId: config.templateId ?? null,
  };
}

/** Every rule (any status), most recently updated first. */
export async function listRules(admin) {
  const data = await gql(
    admin,
    `#graphql
    query ListCartRules {
      metaobjects(type: "${METAOBJECT_TYPE}", first: 250, sortKey: "updated_at", reverse: true) {
        nodes { id updatedAt fields { key value } }
      }
    }`,
  );
  return (data?.metaobjects?.nodes ?? []).map(ruleFromMetaobject);
}

export async function getRule(admin, id) {
  const data = await gql(
    admin,
    `#graphql
    query GetCartRule($id: ID!) {
      metaobject(id: $id) { id type updatedAt fields { key value } }
    }`,
    { id },
  );
  const node = data?.metaobject;
  if (!node || node.type !== METAOBJECT_TYPE) return null;
  return ruleFromMetaobject(node);
}

const cleanList = (list) =>
  Array.from(new Set((Array.isArray(list) ? list : []).map((v) => String(v).trim()).filter(Boolean)));

function cleanTarget(target, { allowAll = true } = {}) {
  const type = Object.values(TARGET_TYPES).includes(target?.type) ? target.type : TARGET_TYPES.ALL;
  if (type === TARGET_TYPES.ALL) return allowAll ? { type, values: [], labels: [] } : null;
  const values = cleanList(target.values);
  const labels = Array.isArray(target.labels) ? target.labels.map(String).slice(0, values.length) : [];
  return { type, values, labels };
}

/**
 * Sanitizes rule data coming from the form (or a template/duplicate) into
 * the stored shape. Throws a user-facing Error on anything invalid.
 */
export function normalizeRuleInput(input) {
  const ruleType = input.ruleType;
  const info = RULE_TYPE_INFO[ruleType];
  if (!info) throw new Error("Choose a rule type.");

  const target = cleanTarget(input.target);
  if (target.type !== TARGET_TYPES.ALL && target.values.length === 0) {
    throw new Error("Choose at least one product, collection, tag, vendor or type this rule applies to.");
  }

  let value = null;
  if (info.valueLabel) {
    const n = Number(input.value);
    if (info.money ? !(Number.isFinite(n) && n > 0) : !(Number.isInteger(n) && n >= 1)) {
      throw new Error(info.money ? "Enter an amount greater than 0." : "Enter a whole number of 1 or more.");
    }
    value = info.money ? Math.round(n * 100) / 100 : n;
  }

  let comboTarget = null;
  if (ruleType === RULE_TYPES.PRODUCT_COMBINATION) {
    comboTarget = cleanTarget(input.comboTarget, { allowAll: false });
    if (!comboTarget || comboTarget.values.length === 0) {
      throw new Error("Choose the products that can't be bought together with the first group.");
    }
  }

  const customerType = Object.values(CUSTOMER_TYPES).includes(input.customer?.type)
    ? input.customer.type
    : CUSTOMER_TYPES.EVERYONE;
  const customer = { type: customerType, tags: cleanList(input.customer?.tags) };
  if ((customerType === CUSTOMER_TYPES.TAGS || customerType === CUSTOMER_TYPES.EXCLUDE_TAGS) && !customer.tags.length) {
    throw new Error("Add at least one customer tag.");
  }

  const marketType = Object.values(MARKET_TYPES).includes(input.market?.type) ? input.market.type : MARKET_TYPES.ALL;
  const market = {
    type: marketType,
    countries: cleanList(input.market?.countries).map((c) => c.toUpperCase()),
    marketIds: cleanList(input.market?.marketIds),
    labels: Array.isArray(input.market?.labels) ? input.market.labels.map(String) : [],
  };
  if (marketType === MARKET_TYPES.COUNTRIES && !market.countries.length) throw new Error("Choose at least one country.");
  if (marketType === MARKET_TYPES.MARKETS && !market.marketIds.length) throw new Error("Choose at least one market.");

  const conditions = (Array.isArray(input.conditions) ? input.conditions : [])
    .filter((c) => CONDITION_FIELDS[c?.field] && CONDITION_FIELDS[c.field].ops.includes(c.op))
    .map((c) => ({ field: c.field, op: c.op, value: String(c.value ?? "").trim() }))
    .filter((c) => c.value !== "");
  for (const c of conditions) {
    if (CONDITION_FIELDS[c.field].numeric && !Number.isFinite(Number(c.value))) {
      throw new Error(`${CONDITION_FIELDS[c.field].label} needs a number.`);
    }
  }

  const startsAt = input.schedule?.startsAt ? new Date(input.schedule.startsAt).toISOString() : null;
  const endsAt = input.schedule?.endsAt ? new Date(input.schedule.endsAt).toISOString() : null;
  if (startsAt && endsAt && Date.parse(endsAt) <= Date.parse(startsAt)) {
    throw new Error("The end date must be after the start date.");
  }

  const status = Object.values(RULE_STATUS).includes(input.status) ? input.status : RULE_STATUS.ACTIVE;
  const title = String(input.title ?? "").trim().slice(0, 120);
  if (!title) throw new Error("Give this rule a name.");

  return {
    title,
    ruleType,
    status,
    message: String(input.message ?? "").slice(0, 500),
    value,
    target,
    comboTarget,
    customer,
    market,
    conditions,
    schedule: { startsAt, endsAt },
    priority: Math.max(0, Math.min(100, Math.round(Number(input.priority) || 0))),
    templateId: input.templateId ? String(input.templateId) : null,
  };
}

function ruleToFields(rule) {
  const firstValue = rule.target.values[0] ?? "";
  return [
    { key: "title", value: rule.title },
    { key: "rule_type", value: rule.ruleType },
    // v1 fields, still written so an older app version reading the same
    // metaobjects sees a sensible rule.
    { key: "target_type", value: rule.target.type },
    { key: "target_value", value: String(firstValue) },
    { key: "max_quantity", value: Number.isInteger(rule.value) && rule.value >= 1 ? String(rule.value) : "" },
    { key: "message", value: rule.message ?? "" },
    { key: "status", value: rule.status },
    {
      key: "config",
      value: JSON.stringify({
        value: rule.value,
        target: rule.target,
        comboTarget: rule.comboTarget,
        customer: rule.customer,
        market: rule.market,
        conditions: rule.conditions,
        schedule: rule.schedule,
        priority: rule.priority,
        templateId: rule.templateId,
      }),
    },
  ];
}

/** Resolves selected Shopify Markets into the countries the Function checks. */
async function resolveMarketCountries(admin, marketIds) {
  if (!marketIds?.length) return [];
  const data = await gql(
    admin,
    `#graphql
    query CartRulesMarketCountries($ids: [ID!]!) {
      nodes(ids: $ids) {
        ... on Market {
          id
          conditions {
            regionsCondition {
              regions(first: 250) { nodes { ... on MarketRegionCountry { code } } }
            }
          }
        }
      }
    }`,
    { ids: marketIds },
  );
  const codes = new Set();
  for (const node of data?.nodes ?? []) {
    for (const r of node?.conditions?.regionsCondition?.regions?.nodes ?? []) if (r?.code) codes.add(r.code);
  }
  return [...codes];
}

/** Creates a rule and refreshes the checkout cache. Returns the new id. */
export async function createRule(admin, input) {
  await ensureMetaobjectDefinition(admin);
  const rule = normalizeRuleInput(input);
  if (rule.market.type === MARKET_TYPES.MARKETS) rule.market.countries = await resolveMarketCountries(admin, rule.market.marketIds);
  const data = await gql(
    admin,
    `#graphql
    mutation CreateCartRule($metaobject: MetaobjectCreateInput!) {
      metaobjectCreate(metaobject: $metaobject) {
        metaobject { id }
        userErrors { field message }
      }
    }`,
    { metaobject: { type: METAOBJECT_TYPE, fields: ruleToFields(rule) } },
  );
  const errors = data?.metaobjectCreate?.userErrors;
  if (errors?.length) throw new Error(`Could not create rule: ${JSON.stringify(errors)}`);
  const id = data.metaobjectCreate.metaobject.id;
  try {
    await syncRulesCache(admin, { activateValidation: rule.status === RULE_STATUS.ACTIVE });
  } catch (error) {
    throw new RulesCacheSyncError(error);
  }
  return id;
}

/** Replaces a rule's definition and refreshes the checkout cache. */
export async function updateRule(admin, id, input) {
  await ensureMetaobjectDefinition(admin);
  const rule = normalizeRuleInput(input);
  if (rule.market.type === MARKET_TYPES.MARKETS) rule.market.countries = await resolveMarketCountries(admin, rule.market.marketIds);
  const data = await gql(
    admin,
    `#graphql
    mutation UpdateCartRule($id: ID!, $metaobject: MetaobjectUpdateInput!) {
      metaobjectUpdate(id: $id, metaobject: $metaobject) {
        metaobject { id }
        userErrors { field message }
      }
    }`,
    { id, metaobject: { fields: ruleToFields(rule) } },
  );
  const errors = data?.metaobjectUpdate?.userErrors;
  if (errors?.length) throw new Error(`Could not update rule: ${JSON.stringify(errors)}`);
  // Editing must not switch back on a validation the merchant turned off.
  try {
    await syncRulesCache(admin, { activateValidation: false });
  } catch (error) {
    throw new RulesCacheSyncError(error);
  }
}

/** Copies a rule as a new PAUSED rule. */
export async function duplicateRule(admin, id) {
  const source = await getRule(admin, id);
  if (!source) throw new Error(`Could not duplicate rule: ${id} not found`);
  return createRule(admin, { ...source, title: `${source.title || "Untitled rule"} (copy)`, status: RULE_STATUS.PAUSED });
}

export async function setRuleStatus(admin, id, status, { sync = true } = {}) {
  const data = await gql(
    admin,
    `#graphql
    mutation SetCartRuleStatus($id: ID!, $metaobject: MetaobjectUpdateInput!) {
      metaobjectUpdate(id: $id, metaobject: $metaobject) { userErrors { field message } }
    }`,
    { id, metaobject: { fields: [{ key: "status", value: status }] } },
  );
  const errors = data?.metaobjectUpdate?.userErrors;
  if (errors?.length) throw new Error(`Could not change rule status: ${JSON.stringify(errors)}`);
  if (!sync) return;
  // Only activating a rule may switch the checkout validation on.
  await syncRulesCache(admin, { activateValidation: status === RULE_STATUS.ACTIVE });
}

export async function deleteRule(admin, id) {
  const data = await gql(
    admin,
    `#graphql
    mutation DeleteCartRule($id: ID!) {
      metaobjectDelete(id: $id) { deletedId userErrors { field message } }
    }`,
    { id },
  );
  const errors = data?.metaobjectDelete?.userErrors;
  if (errors?.length) throw new Error(`Could not delete rule: ${JSON.stringify(errors)}`);
  await syncRulesCache(admin, { activateValidation: false });
}

// ---------------------------------------------------------------------------
// Checkout cache
// ---------------------------------------------------------------------------

const numericId = (gid) => String(gid).split("/").pop();

function compactTarget(target) {
  if (!target || target.type === TARGET_TYPES.ALL) return { type: TARGET_TYPES.ALL, values: [] };
  // Product/variant GIDs are stored as plain ids — they're the bulk of the cache.
  const values =
    target.type === TARGET_TYPES.PRODUCT || target.type === TARGET_TYPES.VARIANT
      ? target.values.map(numericId)
      : target.values;
  return { type: target.type, values };
}

/**
 * Pure: the JSON the Function and theme blocks read, built from the rules
 * that are live at `now`. Also returns the Function's input variables and
 * the next time a schedule starts or ends (for the scheduler).
 */
export function buildRulesCache(rules, settings, now = Date.now()) {
  const defaults = getDefaultMessages(settings);
  const live = rules.filter((r) => isLive(r, now));
  const cacheRules = live.map((r) => {
    const entry = {
      id: r.id,
      type: r.ruleType,
      msg: r.message?.trim() ? r.message : defaults[r.ruleType],
      target: compactTarget(r.target),
    };
    if (r.value != null) entry.value = r.value;
    if (r.target?.labels?.length) entry.targetLabel = r.target.labels.join(", ");
    if (r.comboTarget) entry.comboTarget = compactTarget(r.comboTarget);
    if (r.customer && r.customer.type !== CUSTOMER_TYPES.EVERYONE) entry.customer = r.customer;
    if (r.market?.type !== MARKET_TYPES.ALL && r.market?.countries?.length) entry.countries = r.market.countries;
    if (r.conditions?.length) entry.conditions = r.conditions;
    if (r.priority) entry.priority = r.priority;
    return entry;
  });

  let nextBoundary = null;
  for (const r of rules) {
    if (r.status !== RULE_STATUS.ACTIVE) continue;
    for (const iso of [r.schedule?.startsAt, r.schedule?.endsAt]) {
      const t = iso ? Date.parse(iso) : NaN;
      if (Number.isFinite(t) && t > now && (nextBoundary == null || t < nextBoundary)) nextBoundary = t;
    }
  }

  const variables = collectInputVariables(cacheRules);
  const truncated = Object.entries(variables)
    .filter(([, list]) => list.length > MAX_INPUT_VARIABLE_ITEMS)
    .map(([key]) => key);
  for (const key of Object.keys(variables)) variables[key] = variables[key].slice(0, MAX_INPUT_VARIABLE_ITEMS);

  const value = JSON.stringify({
    v: 2,
    rules: cacheRules,
    enabled: settings.protectionEnabled,
    conflictMode: settings.conflictMode ?? CONFLICT_MODES.MOST_RESTRICTIVE,
    productNoticesEnabled: settings.productNoticesEnabled,
    cartNoticesEnabled: settings.cartNoticesEnabled,
    checkoutMessagesEnabled: settings.checkoutMessagesEnabled,
    genericMessage: defaults.generic,
    generatedAt: new Date(now).toISOString(),
  });

  return { value, variables, truncated, nextBoundary, liveCount: live.length };
}

/**
 * Rebuilds the `cartrules.rules_cache` metafield and the Function's input
 * variables, and records the next schedule boundary so the scheduler
 * (app/scheduler.server.js) rebuilds again when a rule starts or ends.
 *
 * `activateValidation: false` is for background resyncs: they must not turn
 * the checkout rule back on if the merchant switched it off in Shopify.
 */
export async function syncRulesCache(admin, { activateValidation = true } = {}) {
  const shop = await getShopIdentity(admin);
  await ensureRulesCacheMetafieldDefinition(admin, shop.id);
  const [all, settings] = await Promise.all([listRules(admin), getSettings(admin)]);
  const built = buildRulesCache(all, settings);

  if (Buffer.byteLength(built.value, "utf8") > FUNCTION_METAFIELD_MAX_BYTES) {
    // Still written so the admin and theme stay accurate — the Overview and
    // Rules pages read the size back and tell the merchant.
    console.warn("rules_cache exceeds the Function metafield limit", { shop: shop.domain });
  }

  let validation = await getValidation(admin);
  if (activateValidation && built.liveCount > 0 && !validation?.enabled) {
    await ensureValidationActive(admin);
    validation = await getValidation(admin);
  }

  const metafields = [
    { ownerId: shop.id, namespace: CACHE_NAMESPACE, key: CACHE_KEY, type: "json", value: built.value },
  ];
  if (validation?.id) {
    metafields.push({
      ownerId: validation.id,
      namespace: VARIABLES_NAMESPACE,
      key: VARIABLES_KEY,
      type: "json",
      value: JSON.stringify(built.variables),
    });
  }
  const data = await gql(
    admin,
    `#graphql
    mutation SyncRulesCache($metafields: [MetafieldsSetInput!]!) {
      metafieldsSet(metafields: $metafields) { userErrors { field message } }
    }`,
    { metafields },
  );
  const errors = data?.metafieldsSet?.userErrors;
  if (errors?.length) throw new Error(`Could not sync rules cache metafield: ${JSON.stringify(errors)}`);

  await db.shopState.upsert({
    where: { shop: shop.domain },
    create: { shop: shop.domain, nextScheduleAt: built.nextBoundary ? new Date(built.nextBoundary) : null },
    update: { nextScheduleAt: built.nextBoundary ? new Date(built.nextBoundary) : null },
  });
  return built;
}

export async function getShopIdentity(admin) {
  const data = await gql(admin, `#graphql
    query CartRulesShopIdentity { shop { id myshopifyDomain ianaTimezone currencyCode } }`);
  return {
    id: data.shop.id,
    domain: data.shop.myshopifyDomain,
    timezone: data.shop.ianaTimezone,
    currency: data.shop.currencyCode,
  };
}

// Not cached: this module serves every shop, and `admin` doesn't expose which.
export async function getShopGid(admin) {
  return (await getShopIdentity(admin)).id;
}

/** Reads back the exact JSON the checkout Function reads. */
export async function readRulesCache(admin) {
  const data = await gql(
    admin,
    `#graphql
    query ReadCartRulesCache {
      shop { metafield(namespace: "${CACHE_NAMESPACE}", key: "${CACHE_KEY}") { value } }
    }`,
  );
  const raw = data?.shop?.metafield?.value;
  if (!raw) return { rules: [], enabled: true, bytes: 0, exists: false };
  const bytes = Buffer.byteLength(raw, "utf8");
  const parsed = parseJson(raw, null);
  if (!parsed) return { rules: [], enabled: true, bytes, exists: true };
  return {
    rules: Array.isArray(parsed.rules) ? parsed.rules : [],
    enabled: parsed.enabled !== false,
    conflictMode: parsed.conflictMode ?? CONFLICT_MODES.MOST_RESTRICTIVE,
    version: parsed.v ?? 1,
    bytes,
    exists: true,
  };
}

/** Active rules (status only — schedule doesn't count against plan limits). */
export async function countActiveRules(admin) {
  const all = await listRules(admin);
  return all.filter((r) => r.status === RULE_STATUS.ACTIVE).length;
}

const SETUP_FLAGS_KEY = "setup_flags";

/** Small merchant-attested checklist flags (fallback when theme detection can't tell). */
export async function getSetupFlags(admin) {
  const data = await gql(
    admin,
    `#graphql
    query ReadCartRulesSetupFlags {
      shop { metafield(namespace: "${CACHE_NAMESPACE}", key: "${SETUP_FLAGS_KEY}") { value } }
    }`,
  );
  return parseJson(data?.shop?.metafield?.value, {});
}

export async function setSetupFlag(admin, key, value) {
  const flags = await getSetupFlags(admin);
  flags[key] = value;
  const data = await gql(
    admin,
    `#graphql
    mutation WriteCartRulesSetupFlags($metafields: [MetafieldsSetInput!]!) {
      metafieldsSet(metafields: $metafields) { userErrors { field message } }
    }`,
    {
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
  );
  const errors = data?.metafieldsSet?.userErrors;
  if (errors?.length) throw new Error(`Could not write setup flags metafield: ${JSON.stringify(errors)}`);
}
