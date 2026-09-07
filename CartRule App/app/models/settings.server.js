// Shop-wide CartRules settings — same pattern as getSetupFlags/setSetupFlag
// in rules.server.js (a JSON blob in a shop metafield, not a new database
// table). Read by syncRulesCache to populate the enable/notice flags that
// ship down in the rules_cache metafield (see that function's comment).

import { CACHE_NAMESPACE, getShopGid } from "./rules.server";
import { RULE_TYPES } from "./ruleConstants";

const SETTINGS_KEY = "settings";

export const DEFAULT_MESSAGES = {
  [RULE_TYPES.NO_DISCOUNT]: "This item is already at its best price - discount codes do not apply.",
  [RULE_TYPES.MAX_QUANTITY]: "There is a maximum quantity for this item per order.",
};

const DEFAULTS = {
  protectionEnabled: true,
  productNoticesEnabled: true,
  cartNoticesEnabled: true,
  defaultMessages: { ...DEFAULT_MESSAGES },
};

export async function getSettings(admin) {
  const response = await admin.graphql(
    `#graphql
    query ReadCartRulesSettings {
      shop {
        metafield(namespace: "${CACHE_NAMESPACE}", key: "${SETTINGS_KEY}") { value }
      }
    }`,
  );
  const json = await response.json();
  const raw = json.data?.shop?.metafield?.value;
  if (!raw) return { ...DEFAULTS, defaultMessages: { ...DEFAULT_MESSAGES } };
  try {
    const parsed = JSON.parse(raw);
    return {
      ...DEFAULTS,
      ...parsed,
      defaultMessages: { ...DEFAULT_MESSAGES, ...parsed.defaultMessages },
    };
  } catch (_err) {
    return { ...DEFAULTS, defaultMessages: { ...DEFAULT_MESSAGES } };
  }
}

export async function setSettings(admin, patch) {
  const current = await getSettings(admin);
  const next = {
    ...current,
    ...patch,
    defaultMessages: { ...current.defaultMessages, ...patch.defaultMessages },
  };
  const response = await admin.graphql(
    `#graphql
    mutation WriteCartRulesSettings($metafields: [MetafieldsSetInput!]!) {
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
            key: SETTINGS_KEY,
            type: "json",
            value: JSON.stringify(next),
          },
        ],
      },
    },
  );
  const json = await response.json();
  const errors = json.data?.metafieldsSet?.userErrors;
  if (errors?.length) {
    throw new Error(`Could not write settings metafield: ${JSON.stringify(errors)}`);
  }
  return next;
}
