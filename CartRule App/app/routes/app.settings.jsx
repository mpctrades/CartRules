import { useMemo, useState } from "react";
import { json } from "@remix-run/node";
import { useFetcher, useLoaderData } from "@remix-run/react";
import { BlockStack, InlineStack, Text, Checkbox, TextField, Button, ChoiceList, Banner } from "@shopify/polaris";
import { loadAppContext } from "../models/context.server";
import {
  getSettings,
  setSettings,
  getBuiltInMessages,
  getPrimaryLocale,
  SUPPORTED_MESSAGE_LOCALES,
} from "../models/settings.server";
import { syncRulesCache } from "../models/rules.server";
import { getThemeBlockStatus } from "../models/theme.server";
import { notificationsAvailable } from "../models/notifications.server";
import { RULE_TYPE_INFO, RULE_TYPE_ORDER, CONFLICT_MODES, MESSAGE_VARIABLES } from "../models/ruleConstants";
import { getCartThemeEditorDeepLink, getThemeEditorDeepLink } from "../utils/themeEditor";
import { useActionToast } from "../utils/useActionToast";
import { AppPage, Box, StatusText } from "../components/ui";

const MESSAGE_KEYS = [...RULE_TYPE_ORDER, "generic"];

// Settings live in a shop metafield (settings.server.js). Saving re-runs
// syncRulesCache so the checkout Function and theme blocks pick up the new
// flags and messages immediately.
export const loader = async ({ request }) => {
  const { admin, settings: stored, shop } = await loadAppContext(request, { rules: false });
  const [locale, theme] = await Promise.all([getPrimaryLocale(admin), getThemeBlockStatus(admin, shop)]);
  let settings = stored;
  if (settings.shopLocale !== locale) {
    try {
      settings = await setSettings(admin, { shopLocale: locale });
    } catch (error) {
      console.error("Failed to store shop locale", error);
    }
  }
  return json({
    settings,
    locale,
    theme,
    shop,
    builtIn: getBuiltInMessages(settings.autoLanguage === false ? "en" : locale),
    supportedLocales: SUPPORTED_MESSAGE_LOCALES,
    emailAvailable: notificationsAvailable(),
  });
};

export const action = async ({ request }) => {
  const { admin } = await loadAppContext(request, { rules: false, settings: false });
  let payload;
  try {
    payload = JSON.parse((await request.formData()).get("payload") ?? "{}");
  } catch (_e) {
    return json({ ok: false, toast: "We couldn't read your changes. Please try again.", toastError: true });
  }

  try {
    const current = await getSettings(admin);
    // The form shows the defaults for the language that was active when it
    // loaded; the toggle may switch language on save — an unchanged default
    // in either language isn't a custom message.
    const builtIn = getBuiltInMessages(payload.autoLanguage === false ? "en" : current.shopLocale);
    const shownBuiltIn = getBuiltInMessages(current.autoLanguage === false ? "en" : current.shopLocale);
    // Store only messages that differ from the built-in default, so the rest
    // keep following the store's language.
    const customMessages = {};
    for (const key of MESSAGE_KEYS) {
      const value = String(payload.messages?.[key] ?? "").trim();
      if (value && value !== builtIn[key] && value !== shownBuiltIn[key]) customMessages[key] = value.slice(0, 500);
    }
    const patch = {
      protectionEnabled: Boolean(payload.protectionEnabled),
      conflictMode: payload.conflictMode === CONFLICT_MODES.PRIORITY ? CONFLICT_MODES.PRIORITY : CONFLICT_MODES.MOST_RESTRICTIVE,
      productNoticesEnabled: Boolean(payload.productNoticesEnabled),
      cartNoticesEnabled: Boolean(payload.cartNoticesEnabled),
      checkoutMessagesEnabled: Boolean(payload.checkoutMessagesEnabled),
      autoLanguage: Boolean(payload.autoLanguage),
      customMessages,
    };
    if (notificationsAvailable()) {
      patch.notifications = {
        ruleErrors: Boolean(payload.notifications?.ruleErrors),
        weeklySummary: Boolean(payload.notifications?.weeklySummary),
        scheduleReminders: Boolean(payload.notifications?.scheduleReminders),
      };
    }
    await setSettings(admin, patch);
    await syncRulesCache(admin, { activateValidation: false });
  } catch (error) {
    if (error instanceof Response) throw error;
    console.error("Failed to save settings", error);
    return json({ ok: false, toast: "We couldn't save your settings. Please try again.", toastError: true });
  }
  return json({ ok: true, toast: "Settings saved" });
};

const LOCALE_NAMES = {
  en: "English",
  fr: "French",
  de: "German",
  es: "Spanish",
  it: "Italian",
  nl: "Dutch",
  "pt-BR": "Portuguese (Brazil)",
  ja: "Japanese",
};

function localeName(locale) {
  if (LOCALE_NAMES[locale]) return LOCALE_NAMES[locale];
  try {
    return new Intl.DisplayNames(["en"], { type: "language" }).of(locale) ?? locale;
  } catch (_e) {
    return locale;
  }
}

function isSupported(locale, supported) {
  return supported.includes(locale) || supported.includes(String(locale).split("-")[0]);
}

function messageLabel(key) {
  return key === "generic" ? "Generic checkout message" : RULE_TYPE_INFO[key].title;
}

function BlockStatus({ status, label, link }) {
  return (
    <div className="cr-list-row">
      <span style={{ fontSize: 14 }}>{label}</span>
      <InlineStack gap="300" blockAlign="center">
        {status === "installed" ? (
          <StatusText kind="ok">Installed</StatusText>
        ) : status === "disabled" ? (
          <StatusText kind="warn">Hidden in theme</StatusText>
        ) : status === "missing" ? (
          <StatusText kind="off">Not installed</StatusText>
        ) : (
          <StatusText kind="off">Couldn&apos;t check</StatusText>
        )}
        {status !== "installed" ? (
          <Button size="slim" onClick={() => window.open(link, "_blank")}>
            {label === "Product page notice" ? "Add to product page" : "Add to cart"}
          </Button>
        ) : null}
      </InlineStack>
    </div>
  );
}

export default function Settings() {
  const { settings, locale, theme, shop, builtIn, supportedLocales, emailAvailable } = useLoaderData();
  const fetcher = useFetcher();
  useActionToast(fetcher);

  const initial = useMemo(
    () => ({
      protectionEnabled: settings.protectionEnabled,
      conflictMode: settings.conflictMode ?? CONFLICT_MODES.MOST_RESTRICTIVE,
      productNoticesEnabled: settings.productNoticesEnabled,
      cartNoticesEnabled: settings.cartNoticesEnabled,
      checkoutMessagesEnabled: settings.checkoutMessagesEnabled,
      autoLanguage: settings.autoLanguage,
      notifications: { ...settings.notifications },
      messages: Object.fromEntries(MESSAGE_KEYS.map((k) => [k, settings.customMessages?.[k] ?? builtIn[k] ?? ""])),
    }),
    [settings, builtIn],
  );
  const [form, setForm] = useState(initial);
  const dirty = JSON.stringify(form) !== JSON.stringify(initial);
  const set = (patch) => setForm((f) => ({ ...f, ...patch }));
  const setMessage = (key, value) => setForm((f) => ({ ...f, messages: { ...f.messages, [key]: value } }));
  const setNotification = (key, value) =>
    setForm((f) => ({ ...f, notifications: { ...f.notifications, [key]: value } }));

  const save = () => fetcher.submit({ payload: JSON.stringify(form) }, { method: "post" });
  const saving = fetcher.state !== "idle";

  const actions = (
    <>
      <Button disabled={!dirty || saving} onClick={() => setForm(initial)}>
        Discard
      </Button>
      <Button variant="primary" disabled={!dirty} loading={saving} onClick={save}>
        Save changes
      </Button>
    </>
  );

  return (
    <AppPage title="Settings" subtitle="Control how CartRules enforces rules and talks to shoppers, store-wide." actions={actions}>
      <Box title="General">
        <Checkbox
          label="CartRules protection"
          helpText="When off, no rule is enforced at checkout or shown on your storefront. Your rules are kept — nothing is deleted."
          checked={form.protectionEnabled}
          onChange={(v) => set({ protectionEnabled: v })}
        />
        {!form.protectionEnabled ? (
          <div style={{ marginTop: 12 }}>
            <Banner tone="warning">Protection is off — checkout won&apos;t enforce any rule until you turn it back on.</Banner>
          </div>
        ) : null}
      </Box>

      <Box title="Rule behavior" subtitle="When more than one quantity rule of the same type matches a product, only one applies.">
        <ChoiceList
          title="When multiple rules match"
          choices={[
            {
              label: "Most restrictive rule wins",
              value: CONFLICT_MODES.MOST_RESTRICTIVE,
              helpText: "The lowest maximum, highest minimum or largest multiple applies.",
            },
            {
              label: "Highest priority rule wins",
              value: CONFLICT_MODES.PRIORITY,
              helpText: "The rule with the highest priority number applies (ties fall back to most restrictive). Priority is set per rule on the Pro plan.",
            },
          ]}
          selected={[form.conflictMode]}
          onChange={([v]) => set({ conflictMode: v })}
        />
      </Box>

      <Box title="Storefront" subtitle="What shoppers see before checkout. Checkout still enforces every rule either way.">
        <BlockStack gap="300">
          <Checkbox
            label="Product page notices"
            helpText="Shows the rules that apply to a product on its page (needs the Product rule notice block)."
            checked={form.productNoticesEnabled}
            onChange={(v) => set({ productNoticesEnabled: v })}
          />
          <Checkbox
            label="Cart warnings"
            helpText="Explains broken rules on the cart page and lowers quantities above a maximum (needs the Cart quantity guard block)."
            checked={form.cartNoticesEnabled}
            onChange={(v) => set({ cartNoticesEnabled: v })}
          />
          <Checkbox
            label="Checkout messages"
            helpText="Show each rule's own message at checkout. When off, checkout is still blocked but shows the generic checkout message below."
            checked={form.checkoutMessagesEnabled}
            onChange={(v) => set({ checkoutMessagesEnabled: v })}
          />
          <div style={{ marginTop: 8 }}>
            <Text as="h3" variant="headingSm">
              Theme blocks{theme.themeName ? ` in “${theme.themeName}”` : ""}
            </Text>
            <div className="cr-list" style={{ marginTop: 8 }}>
              <BlockStatus status={theme.productNotice} label="Product page notice" link={getThemeEditorDeepLink(shop)} />
              <BlockStatus status={theme.cartGuard} label="Cart quantity guard" link={getCartThemeEditorDeepLink(shop)} />
            </div>
          </div>
        </BlockStack>
      </Box>

      <Box
        title="Default customer messages"
        subtitle="Used by every rule that doesn't have its own message. Changes apply to those rules right away."
      >
        <BlockStack gap="400">
          <Text as="p" tone="subdued">
            You can use {MESSAGE_VARIABLES.join(", ")} — they&apos;re filled in when the message is shown.
          </Text>
          {MESSAGE_KEYS.map((key) => {
            const changed = form.messages[key] !== builtIn[key];
            return (
              <TextField
                key={key}
                label={messageLabel(key)}
                value={form.messages[key]}
                onChange={(v) => setMessage(key, v)}
                multiline={2}
                autoComplete="off"
                placeholder={builtIn[key]}
                helpText={key === "generic" ? "Shown at checkout when Checkout messages is off." : undefined}
                connectedRight={
                  changed ? (
                    <Button onClick={() => setMessage(key, builtIn[key])}>Reset to default</Button>
                  ) : undefined
                }
              />
            );
          })}
        </BlockStack>
      </Box>

      <Box title="Language / localization">
        <BlockStack gap="300">
          <Checkbox
            label="Automatically use store language"
            helpText="Default messages follow your store's primary language. Turn off to always use English defaults."
            checked={form.autoLanguage}
            onChange={(v) => set({ autoLanguage: v })}
          />
          <Text as="p">
            Store language: <strong>{localeName(locale)}</strong>
            {isSupported(locale, supportedLocales)
              ? ""
              : " — built-in defaults aren't available in this language yet, so English is used. Edit the messages above to translate them."}
          </Text>
          <Text as="p" tone="subdued">
            Built-in default messages are available in {supportedLocales.map(localeName).join(", ")}. Messages you
            write yourself — here or on a rule — are shown exactly as written, in any language.
          </Text>
          {dirty && form.autoLanguage !== initial.autoLanguage ? (
            <Text as="p" tone="subdued">
              Save to see the default messages above in the new language.
            </Text>
          ) : null}
        </BlockStack>
      </Box>

      <Box title="Notifications" subtitle="Emails to your store's contact address.">
        {emailAvailable ? (
          <BlockStack gap="300">
            <Checkbox
              label="Rule error notifications"
              helpText="Email me when a rule needs attention, e.g. its products were deleted."
              checked={form.notifications.ruleErrors}
              onChange={(v) => setNotification("ruleErrors", v)}
            />
            <Checkbox
              label="Weekly protection summary"
              helpText="A short weekly email with your rule activity."
              checked={form.notifications.weeklySummary}
              onChange={(v) => setNotification("weeklySummary", v)}
            />
            <Checkbox
              label="Scheduled rule reminders"
              helpText="Email me the day before a scheduled rule starts."
              checked={form.notifications.scheduleReminders}
              onChange={(v) => setNotification("scheduleReminders", v)}
            />
          </BlockStack>
        ) : (
          <BlockStack gap="300">
            <Checkbox label="Rule error notifications" checked={false} disabled onChange={() => {}} />
            <Checkbox label="Weekly protection summary" checked={false} disabled onChange={() => {}} />
            <Checkbox label="Scheduled rule reminders" checked={false} disabled onChange={() => {}} />
            <Text as="p" tone="subdued">
              Email notifications aren&apos;t available yet — email sending isn&apos;t set up for CartRules. Rule issues
              are always shown on the Overview and Rules pages.
            </Text>
          </BlockStack>
        )}
      </Box>

      <InlineStack align="end" gap="200">
        {actions}
      </InlineStack>
    </AppPage>
  );
}
