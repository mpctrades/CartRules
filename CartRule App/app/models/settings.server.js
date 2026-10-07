// Shop-wide CartRules settings — a JSON blob in a shop metafield (no app
// database for merchant configuration). Read by syncRulesCache, which ships
// the flags the Function and theme blocks need inside rules_cache.

import { CACHE_NAMESPACE, getShopGid } from "./rules.server";
import { CONFLICT_MODES } from "./ruleConstants";

const SETTINGS_KEY = "settings";

// Built-in default customer messages, per language. Used when a rule has no
// custom message. With "Automatically use store language" on, the store's
// primary language picks the set (English if we don't have it); merchants
// can still override any message in Settings.
const DEFAULTS_BY_LOCALE = {
  en: {
    max_quantity: "You can purchase a maximum of {{limit}} of {{product}}.",
    min_quantity: "{{product}} has a minimum order quantity of {{limit}}.",
    no_discount: "Discount codes can't be used on {{product}}.",
    cart_min_value: "Your cart must be at least {{limit}} to check out.",
    cart_max_value: "Your cart can't be more than {{limit}}.",
    quantity_multiple: "{{product}} is sold in multiples of {{limit}}.",
    max_cart_items: "Your cart can contain at most {{limit}} items.",
    product_combination: "{{product}} can't be purchased together with the other items in your cart.",
    generic: "Your cart doesn't meet this store's purchase rules.",
  },
  fr: {
    max_quantity: "Vous pouvez acheter au maximum {{limit}} × {{product}}.",
    min_quantity: "{{product}} doit être commandé par {{limit}} minimum.",
    no_discount: "Les codes de réduction ne s'appliquent pas à {{product}}.",
    cart_min_value: "Votre panier doit atteindre au moins {{limit}} pour passer commande.",
    cart_max_value: "Votre panier ne peut pas dépasser {{limit}}.",
    quantity_multiple: "{{product}} est vendu par multiples de {{limit}}.",
    max_cart_items: "Votre panier peut contenir au maximum {{limit}} articles.",
    product_combination: "{{product}} ne peut pas être acheté avec les autres articles de votre panier.",
    generic: "Votre panier ne respecte pas les conditions d'achat de la boutique.",
  },
  de: {
    max_quantity: "Sie können maximal {{limit}} × {{product}} kaufen.",
    min_quantity: "Für {{product}} gilt eine Mindestbestellmenge von {{limit}}.",
    no_discount: "Rabattcodes gelten nicht für {{product}}.",
    cart_min_value: "Ihr Warenkorb muss mindestens {{limit}} betragen.",
    cart_max_value: "Ihr Warenkorb darf {{limit}} nicht überschreiten.",
    quantity_multiple: "{{product}} wird nur in Vielfachen von {{limit}} verkauft.",
    max_cart_items: "Ihr Warenkorb darf höchstens {{limit}} Artikel enthalten.",
    product_combination: "{{product}} kann nicht zusammen mit den anderen Artikeln im Warenkorb gekauft werden.",
    generic: "Ihr Warenkorb erfüllt die Kaufbedingungen dieses Shops nicht.",
  },
  es: {
    max_quantity: "Puedes comprar como máximo {{limit}} de {{product}}.",
    min_quantity: "{{product}} tiene una cantidad mínima de pedido de {{limit}}.",
    no_discount: "Los códigos de descuento no se aplican a {{product}}.",
    cart_min_value: "Tu carrito debe ser de al menos {{limit}} para pagar.",
    cart_max_value: "Tu carrito no puede superar {{limit}}.",
    quantity_multiple: "{{product}} se vende en múltiplos de {{limit}}.",
    max_cart_items: "Tu carrito puede contener como máximo {{limit}} artículos.",
    product_combination: "{{product}} no se puede comprar junto con los demás artículos de tu carrito.",
    generic: "Tu carrito no cumple las condiciones de compra de esta tienda.",
  },
  it: {
    max_quantity: "Puoi acquistare al massimo {{limit}} di {{product}}.",
    min_quantity: "{{product}} ha una quantità minima d'ordine di {{limit}}.",
    no_discount: "I codici sconto non si applicano a {{product}}.",
    cart_min_value: "Il carrello deve essere di almeno {{limit}} per procedere.",
    cart_max_value: "Il carrello non può superare {{limit}}.",
    quantity_multiple: "{{product}} è venduto in multipli di {{limit}}.",
    max_cart_items: "Il carrello può contenere al massimo {{limit}} articoli.",
    product_combination: "{{product}} non può essere acquistato insieme agli altri articoli nel carrello.",
    generic: "Il carrello non rispetta le condizioni d'acquisto del negozio.",
  },
  nl: {
    max_quantity: "Je kunt maximaal {{limit}} van {{product}} kopen.",
    min_quantity: "Voor {{product}} geldt een minimale bestelhoeveelheid van {{limit}}.",
    no_discount: "Kortingscodes gelden niet voor {{product}}.",
    cart_min_value: "Je winkelwagen moet minimaal {{limit}} zijn om af te rekenen.",
    cart_max_value: "Je winkelwagen mag niet meer dan {{limit}} zijn.",
    quantity_multiple: "{{product}} wordt verkocht per {{limit}} stuks.",
    max_cart_items: "Je winkelwagen mag maximaal {{limit}} artikelen bevatten.",
    product_combination: "{{product}} kan niet samen met de andere artikelen in je winkelwagen worden gekocht.",
    generic: "Je winkelwagen voldoet niet aan de aankoopvoorwaarden van deze winkel.",
  },
  "pt-BR": {
    max_quantity: "Você pode comprar no máximo {{limit}} de {{product}}.",
    min_quantity: "{{product}} tem quantidade mínima de pedido de {{limit}}.",
    no_discount: "Códigos de desconto não se aplicam a {{product}}.",
    cart_min_value: "Seu carrinho precisa ter pelo menos {{limit}} para finalizar.",
    cart_max_value: "Seu carrinho não pode passar de {{limit}}.",
    quantity_multiple: "{{product}} é vendido em múltiplos de {{limit}}.",
    max_cart_items: "Seu carrinho pode ter no máximo {{limit}} itens.",
    product_combination: "{{product}} não pode ser comprado junto com os outros itens do carrinho.",
    generic: "Seu carrinho não atende às regras de compra desta loja.",
  },
  ja: {
    max_quantity: "{{product}}は1回のご注文につき{{limit}}点までです。",
    min_quantity: "{{product}}の最小注文数は{{limit}}点です。",
    no_discount: "{{product}}には割引コードを使用できません。",
    cart_min_value: "ご注文には{{limit}}以上のお買い上げが必要です。",
    cart_max_value: "カートの合計は{{limit}}までです。",
    quantity_multiple: "{{product}}は{{limit}}点単位での販売です。",
    max_cart_items: "カートに入れられる商品は{{limit}}点までです。",
    product_combination: "{{product}}はカート内の他の商品と一緒に購入できません。",
    generic: "カートの内容がこのストアの購入条件を満たしていません。",
  },
};

export const SUPPORTED_MESSAGE_LOCALES = Object.keys(DEFAULTS_BY_LOCALE);

function builtInDefaults(locale) {
  if (DEFAULTS_BY_LOCALE[locale]) return DEFAULTS_BY_LOCALE[locale];
  const base = String(locale ?? "").split("-")[0];
  return DEFAULTS_BY_LOCALE[base] ?? DEFAULTS_BY_LOCALE.en;
}

const DEFAULTS = {
  protectionEnabled: true,
  conflictMode: CONFLICT_MODES.MOST_RESTRICTIVE,
  productNoticesEnabled: true,
  cartNoticesEnabled: true,
  checkoutMessagesEnabled: true,
  autoLanguage: true,
  shopLocale: "en",
  // Only the messages the merchant changed — everything else follows the
  // built-in set for the store's language.
  customMessages: {},
  notifications: {
    ruleErrors: true,
    weeklySummary: false,
    scheduleReminders: true,
  },
};

/** Default message per rule type (+ `generic`), after language and merchant overrides. */
export function getDefaultMessages(settings) {
  const builtIn = builtInDefaults(settings?.autoLanguage === false ? "en" : settings?.shopLocale);
  return { ...builtIn, ...(settings?.customMessages ?? {}) };
}

export function getBuiltInMessages(locale) {
  return builtInDefaults(locale);
}

function merge(parsed) {
  // v1 stored every default under `defaultMessages`; only carry over the
  // ones the merchant actually changed from the v1 English defaults.
  const legacy = {};
  const v1 = {
    no_discount: "This item is already at its best price - discount codes do not apply.",
    max_quantity: "There is a maximum quantity for this item per order.",
  };
  for (const [k, v] of Object.entries(parsed?.defaultMessages ?? {})) {
    if (v && v !== v1[k]) legacy[k] = v;
  }
  return {
    ...DEFAULTS,
    ...parsed,
    customMessages: { ...legacy, ...(parsed?.customMessages ?? {}) },
    notifications: { ...DEFAULTS.notifications, ...(parsed?.notifications ?? {}) },
  };
}

export async function getSettings(admin) {
  const response = await admin.graphql(
    `#graphql
    query ReadCartRulesSettings {
      shop { metafield(namespace: "${CACHE_NAMESPACE}", key: "${SETTINGS_KEY}") { value } }
    }`,
  );
  const json = await response.json();
  const raw = json.data?.shop?.metafield?.value;
  if (!raw) return merge({});
  try {
    return merge(JSON.parse(raw));
  } catch (_err) {
    return merge({});
  }
}

export async function setSettings(admin, patch) {
  const current = await getSettings(admin);
  const next = {
    ...current,
    ...patch,
    customMessages: patch.customMessages ?? current.customMessages,
    notifications: { ...current.notifications, ...(patch.notifications ?? {}) },
  };
  delete next.defaultMessages;
  const response = await admin.graphql(
    `#graphql
    mutation WriteCartRulesSettings($metafields: [MetafieldsSetInput!]!) {
      metafieldsSet(metafields: $metafields) { userErrors { field message } }
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
  if (errors?.length) throw new Error(`Could not write settings metafield: ${JSON.stringify(errors)}`);
  return next;
}

/**
 * The store's primary language (needs read_locales). Falls back to "en" if
 * the scope isn't granted yet, so nothing else breaks.
 */
export async function getPrimaryLocale(admin) {
  try {
    const response = await admin.graphql(`#graphql
      query CartRulesPrimaryLocale { shopLocales { locale primary } }`);
    const json = await response.json();
    return json.data?.shopLocales?.find((l) => l.primary)?.locale ?? "en";
  } catch (_e) {
    return "en";
  }
}
