import { useState } from "react";
import { json } from "@remix-run/node";
import {
  useFetcher,
  useLoaderData,
  useNavigate,
  useSearchParams,
} from "@remix-run/react";
import {
  Badge,
  BlockStack,
  Button,
  Icon,
  InlineStack,
  Text,
} from "@shopify/polaris";
import {
  AlertTriangleIcon,
  CartIcon,
  CashDollarIcon,
  CheckCircleIcon,
  ChartLineIcon,
  ClockIcon,
  DiscountIcon,
  InventoryIcon,
  PackageIcon,
  ShieldCheckMarkIcon,
} from "@shopify/polaris-icons";
import { authenticate } from "../shopify.server";
import { loadAppContext } from "../models/context.server";
import {
  getCheckoutEnforcement,
  ensureValidationActive,
  getSetupFlags,
  setSetupFlag,
  readRulesCache,
  FUNCTION_METAFIELD_MAX_BYTES,
} from "../models/rules.server";
import { getRulesHealth } from "../models/health.server";
import { getThemeBlockStatus } from "../models/theme.server";
import {
  getKpis,
  getActivitySeries,
  getActivityFeed,
  hasAnyEvent,
  resolveRange,
  HISTORY_DAYS,
} from "../models/events.server";
import {
  CUSTOMER_TYPES,
  RULE_STATUS,
  RULE_TYPES,
} from "../models/ruleConstants";
import {
  getScheduleStatus,
  EVENT_LABELS,
  describeEvent,
  describeRule,
  describeCustomer,
  timeAgo,
} from "../models/ruleDisplay";
import {
  getCartThemeEditorDeepLink,
  getThemeEditorDeepLink,
} from "../utils/themeEditor";
import { useFlashToast } from "../utils/useFlashToast";
import { useActionToast } from "../utils/useActionToast";
import {
  AppPage,
  Box,
  KpiCard,
  ActivityChart,
  StatusText,
  ProgressLine,
  Segmented,
  EmptyBlock,
  RangePicker,
  rangeFromSearch,
  applyRange,
} from "../components/ui";

const CATEGORIES = [
  { label: "All activity", value: "all" },
  { label: "Quantity", value: "quantity" },
  { label: "Discount", value: "discount" },
  { label: "Cart", value: "cart" },
  { label: "Customer", value: "customer" },
];

// Overview: answers "Is my store protected? What's active? What did
// CartRules block? Is anything broken? How do I create or test a rule?"
// Everything below comes from the store (rules, Shopify's checkout rule,
// the live theme) or the RuleEvent table — nothing is hard-coded.
export const loader = async ({ request }) => {
  const ctx = await loadAppContext(request);
  const { admin, shop, plan, rules, settings } = ctx;
  const url = new URL(request.url);
  const category = url.searchParams.get("type") ?? "all";
  const range = resolveRange(
    {
      days: url.searchParams.get("days") ?? 30,
      from: url.searchParams.get("from"),
      to: url.searchParams.get("to"),
    },
    plan.name,
  );

  const statuses = rules.map((r) => getScheduleStatus(r));
  const liveCount = statuses.filter((s) => s === "active").length;
  const customerRuleIds = rules
    .filter(
      (r) => r.customer?.type && r.customer.type !== CUSTOMER_TYPES.EVERYONE,
    )
    .map((r) => r.id);

  const [
    health,
    theme,
    cache,
    checkoutEnforcing,
    setupFlags,
    kpis,
    series,
    recent,
    hasEvents,
  ] = await Promise.all([
    getRulesHealth(admin, shop, rules, {
      plan: plan.name,
      conflictMode: settings.conflictMode,
    }),
    getThemeBlockStatus(admin, shop),
    readRulesCache(admin),
    getCheckoutEnforcement(admin, liveCount),
    getSetupFlags(admin),
    getKpis(shop, range),
    getActivitySeries(shop, range, { category, customerRuleIds }),
    getActivityFeed(shop, { limit: 5 }),
    hasAnyEvent(shop),
  ]);

  const needsAttention = rules.filter(
    (r, i) =>
      (statuses[i] === "active" || statuses[i] === "scheduled") &&
      health.health[r.id]?.issues?.length,
  );

  return json({
    shop,
    plan: plan.name,
    historyDays: HISTORY_DAYS[plan.name] ?? 7,
    category,
    counts: {
      total: rules.length,
      live: liveCount,
      scheduled: statuses.filter((s) => s === "scheduled").length,
      paused: rules.filter((r) => r.status === RULE_STATUS.PAUSED).length,
      drafts: statuses.filter((s) => s === "draft").length,
    },
    protectionEnabled: settings.protectionEnabled,
    noticesEnabled: {
      product: settings.productNoticesEnabled,
      cart: settings.cartNoticesEnabled,
    },
    checkoutEnforcing,
    cacheTooLarge: cache.bytes > FUNCTION_METAFIELD_MAX_BYTES,
    theme,
    conflicts: health.conflicts,
    attention: needsAttention.map((r) => ({
      id: r.id,
      title: r.title,
      issue: health.health[r.id].issues[0].message,
    })),
    kpis,
    series,
    recent: recent.events,
    currency: ctx.currency,
    // Live and scheduled rules, in plain words, for the "Your rules" card.
    liveRules: rules
      .map((r, i) => ({ r, status: statuses[i] }))
      .filter(({ status }) => status === "active" || status === "scheduled")
      .map(({ r, status }) => ({
        id: r.id,
        title: r.title || "Untitled rule",
        ruleType: r.ruleType,
        summary: describeRule(r, ctx.currency),
        customer:
          r.customer?.type && r.customer.type !== CUSTOMER_TYPES.EVERYONE
            ? describeCustomer(r.customer)
            : null,
        scheduled: status === "scheduled",
        issue: health.health[r.id]?.issues?.[0]?.message ?? null,
      })),
    checklist: {
      createdRule: rules.length > 0,
      activatedRule: rules.some((r) => r.status === RULE_STATUS.ACTIVE),
      // Detected from the live theme; the manual flag only counts when the
      // theme couldn't be read (e.g. the theme scope isn't granted yet).
      addedStorefrontMessages:
        theme.productNotice === "installed" ||
        theme.cartGuard === "installed" ||
        (theme.productNotice === "unknown" &&
          Boolean(setupFlags.storefrontMessagesAdded)),
      testedRule: hasEvents || Boolean(setupFlags.ruleTested),
    },
  });
};

export const action = async ({ request }) => {
  const { admin } = await authenticate.admin(request);
  const intent = (await request.formData()).get("intent");
  try {
    if (intent === "enableValidation") {
      await ensureValidationActive(admin);
      return json({ ok: true, toast: "CartRules is now enforced at checkout" });
    }
    if (intent === "markStorefrontMessagesAdded") {
      await setSetupFlag(admin, "storefrontMessagesAdded", true);
      return json({ ok: true });
    }
  } catch (error) {
    if (error instanceof Response) throw error;
    console.error("Overview action failed", { intent, error });
    return json({
      ok: false,
      toast: "Something went wrong. Please try again.",
      toastError: true,
    });
  }
  return json({ ok: false }, { status: 400 });
};

// useFlashToast strips ?toast= after showing it; that alone can't change
// this loader's result, so don't re-run every query for it.
export function shouldRevalidate({
  currentUrl,
  nextUrl,
  defaultShouldRevalidate,
}) {
  const strip = (url) => {
    const params = new URLSearchParams(url.search);
    ["toast", "toastId", "toastError"].forEach((k) => params.delete(k));
    return params.toString();
  };
  if (
    currentUrl.pathname === nextUrl.pathname &&
    strip(currentUrl) === strip(nextUrl)
  )
    return false;
  return defaultShouldRevalidate;
}

function blockState(status, enabled) {
  if (!enabled) return { kind: "off", label: "Turned off in Settings" };
  if (status === "installed") return { kind: "ok", label: "Active" };
  if (status === "disabled") return { kind: "warn", label: "Hidden in theme" };
  if (status === "missing") return { kind: "warn", label: "Not installed" };
  return { kind: "off", label: "Couldn't check" };
}

// One card answering "Is my store protected?" — headline, the four checks
// that make protection work, and each real problem with one way to fix it.
function StatusCard({ data, navigate, fetcher, onShowSetup, setupDone }) {
  const {
    counts,
    protectionEnabled,
    checkoutEnforcing,
    cacheTooLarge,
    attention,
    conflicts,
    theme,
    noticesEnabled,
    shop,
  } = data;

  const problems = [];
  if (!protectionEnabled)
    problems.push({
      text: "CartRules protection is turned off",
      action: "Turn on",
      run: () => navigate("/app/settings"),
    });
  if (checkoutEnforcing === false && counts.live > 0) {
    problems.push({
      text: "Checkout validation is turned off in Shopify",
      action: "Turn on",
      loading: fetcher.state !== "idle",
      run: () =>
        fetcher.submit({ intent: "enableValidation" }, { method: "post" }),
    });
  }
  if (cacheTooLarge)
    problems.push({
      text: "Your rules are too large for checkout to read",
      action: "Review rules",
      run: () => navigate("/app/rules"),
    });
  if (theme.productNotice === "missing" && noticesEnabled.product) {
    problems.push({
      text: "Product page notice isn't in your theme",
      action: "Add it",
      run: () => window.open(getThemeEditorDeepLink(shop), "_blank"),
    });
  }
  if (theme.cartGuard === "missing" && noticesEnabled.cart) {
    problems.push({
      text: "Cart quantity guard isn't in your theme",
      action: "Add it",
      run: () => window.open(getCartThemeEditorDeepLink(shop), "_blank"),
    });
  }
  for (const a of attention.slice(0, 3)) {
    problems.push({
      text: `${a.title}: ${a.issue}`,
      action: "Fix rule",
      run: () => navigate(`/app/rules/${encodeURIComponent(a.id)}`),
    });
  }
  if (conflicts.length)
    problems.push({
      text: conflicts[0].message,
      action: "Review",
      run: () => navigate("/app/rules"),
    });

  let kind;
  let headline;
  let detail;
  if (!protectionEnabled) {
    kind = "bad";
    headline = "Protection is turned off";
    detail =
      "None of your rules are enforced until you turn CartRules back on.";
  } else if (counts.live === 0) {
    kind = "off";
    headline = counts.scheduled
      ? "Waiting for a scheduled rule"
      : "Not protecting anything yet";
    detail = counts.scheduled
      ? `${counts.scheduled} scheduled rule${counts.scheduled === 1 ? "" : "s"} will start automatically.`
      : "Create or activate a rule and CartRules starts enforcing it at checkout right away.";
  } else if (checkoutEnforcing === false || cacheTooLarge) {
    kind = "bad";
    headline = "Checkout isn't enforcing your rules";
    detail =
      "Shoppers can currently check out without your rules being applied.";
  } else if (problems.length) {
    kind = "warn";
    headline = "Protected — with things to fix";
    detail = `${counts.live} active rule${counts.live === 1 ? "" : "s"} enforced at checkout.`;
  } else {
    kind = "ok";
    headline = "Your store is protected";
    detail = `${counts.live} active rule${counts.live === 1 ? " is" : "s are"} enforced at checkout${counts.paused ? ` · ${counts.paused} paused` : ""}.`;
  }

  const checks = [
    {
      key: "checkout",
      name: "Checkout validation",
      status:
        checkoutEnforcing === true
          ? { kind: "ok", label: "On" }
          : checkoutEnforcing === false
            ? counts.live > 0
              ? { kind: "bad", label: "Off" }
              : { kind: "off", label: "Off — no active rules" }
            : { kind: "off", label: "Couldn't check" },
    },
    {
      key: "product",
      name: "Product page notice",
      status: blockState(theme.productNotice, noticesEnabled.product),
    },
    {
      key: "cart",
      name: "Cart quantity guard",
      status: blockState(theme.cartGuard, noticesEnabled.cart),
    },
    {
      key: "conflicts",
      name: "Rule conflicts",
      status: conflicts.length
        ? { kind: "warn", label: `${conflicts.length} found` }
        : { kind: "ok", label: "None" },
    },
  ];

  return (
    <section className={`cr-card cr-status-card cr-status-card--${kind}`}>
      <div className="cr-status-card__grid">
        <div className="cr-status-card__hero">
          <span className={`cr-status-icon cr-status-icon--${kind}`}>
            <Icon
              source={
                kind === "ok"
                  ? ShieldCheckMarkIcon
                  : kind === "off"
                    ? ShieldCheckMarkIcon
                    : AlertTriangleIcon
              }
            />
          </span>
          <div style={{ minWidth: 0 }}>
            <Text as="h2" variant="headingLg">
              {headline}
            </Text>
            <Text as="p" tone="subdued">
              {detail}
            </Text>
            <div style={{ marginTop: 12 }}>
              <InlineStack gap="300" blockAlign="center">
                <Button variant="plain" onClick={() => navigate("/app/test")}>
                  Test a rule
                </Button>
                {setupDone ? (
                  <Button variant="plain" onClick={onShowSetup}>
                    Setup guide
                  </Button>
                ) : null}
                {theme.themeName ? (
                  <Text as="span" tone="subdued" variant="bodySm">
                    Live theme: {theme.themeName}
                  </Text>
                ) : null}
              </InlineStack>
            </div>
          </div>
        </div>
        <div className="cr-list cr-status-card__checks">
          {checks.map((c) => (
            <div key={c.key} className="cr-list-row">
              <Text as="span">{c.name}</Text>
              <StatusText kind={c.status.kind}>{c.status.label}</StatusText>
            </div>
          ))}
        </div>
      </div>
      {problems.length ? (
        <div className="cr-status-card__problems">
          <BlockStack gap="200">
            {problems.slice(0, 4).map((p) => (
              <InlineStack
                key={p.text}
                align="space-between"
                blockAlign="center"
                gap="200"
                wrap={false}
              >
                <InlineStack gap="200" blockAlign="center" wrap={false}>
                  <span
                    style={{
                      color: "var(--p-color-icon-caution)",
                      display: "inline-flex",
                    }}
                  >
                    <Icon source={AlertTriangleIcon} />
                  </span>
                  <Text as="span">{p.text}</Text>
                </InlineStack>
                <Button size="slim" onClick={p.run} loading={p.loading}>
                  {p.action}
                </Button>
              </InlineStack>
            ))}
          </BlockStack>
        </div>
      ) : null}
    </section>
  );
}

const RULE_ICONS = {
  [RULE_TYPES.MAX_QUANTITY]: InventoryIcon,
  [RULE_TYPES.MIN_QUANTITY]: InventoryIcon,
  [RULE_TYPES.QUANTITY_MULTIPLE]: InventoryIcon,
  [RULE_TYPES.NO_DISCOUNT]: DiscountIcon,
  [RULE_TYPES.CART_MIN_VALUE]: CashDollarIcon,
  [RULE_TYPES.CART_MAX_VALUE]: CashDollarIcon,
  [RULE_TYPES.MAX_CART_ITEMS]: CartIcon,
  [RULE_TYPES.PRODUCT_COMBINATION]: PackageIcon,
};

const RULES_SHOWN = 5;

// What CartRules is actually doing for the store, in plain words.
function YourRules({ rules, total, navigate }) {
  return (
    <Box
      title="Your rules"
      subtitle={
        rules.length ? "Enforced at checkout for every order." : undefined
      }
      actions={
        total ? (
          <Button variant="plain" onClick={() => navigate("/app/rules")}>
            {`View all ${total}`}
          </Button>
        ) : null
      }
    >
      {rules.length === 0 ? (
        <div className="cr-rules-empty">
          <span className="cr-rule-icon">
            <Icon source={ShieldCheckMarkIcon} />
          </span>
          <BlockStack gap="100">
            <Text as="p" fontWeight="semibold">
              {total ? "None of your rules are active" : "Add your first rule"}
            </Text>
            <Text as="p" tone="subdued">
              {total
                ? "Paused and draft rules aren't enforced. Activate one to start protecting your store."
                : "Limit quantities or block discounts on chosen products — most stores start from a template."}
            </Text>
          </BlockStack>
          <InlineStack gap="200">
            {total ? (
              <Button
                variant="primary"
                onClick={() => navigate("/app/rules?tab=paused")}
              >
                Go to rules
              </Button>
            ) : (
              <>
                <Button
                  variant="primary"
                  onClick={() => navigate("/app/templates")}
                >
                  Browse templates
                </Button>
                <Button onClick={() => navigate("/app/rules/new")}>
                  Create rule
                </Button>
              </>
            )}
          </InlineStack>
        </div>
      ) : (
        <div className="cr-list">
          {rules.slice(0, RULES_SHOWN).map((r) => (
            <div key={r.id} className="cr-list-row cr-rule-row">
              <InlineStack gap="300" blockAlign="center" wrap={false}>
                <span className="cr-rule-icon">
                  <Icon
                    source={RULE_ICONS[r.ruleType] ?? ShieldCheckMarkIcon}
                  />
                </span>
                <div style={{ minWidth: 0 }}>
                  <InlineStack gap="200" blockAlign="center">
                    <Text as="p" fontWeight="semibold">
                      {r.title}
                    </Text>
                    {r.scheduled ? (
                      <Badge tone="info" icon={ClockIcon}>
                        Scheduled
                      </Badge>
                    ) : null}
                    {r.issue ? (
                      <Badge tone="warning">Needs attention</Badge>
                    ) : null}
                  </InlineStack>
                  <Text as="p" tone="subdued" variant="bodySm">
                    {r.summary}
                    {r.customer ? ` · ${r.customer}` : ""}
                  </Text>
                </div>
              </InlineStack>
              <InlineStack gap="200" wrap={false}>
                <Button
                  size="slim"
                  onClick={() =>
                    navigate(`/app/test?ruleId=${encodeURIComponent(r.id)}`)
                  }
                >
                  Test
                </Button>
                <Button
                  size="slim"
                  variant="tertiary"
                  onClick={() =>
                    navigate(`/app/rules/${encodeURIComponent(r.id)}`)
                  }
                >
                  Edit
                </Button>
              </InlineStack>
            </div>
          ))}
          {rules.length > RULES_SHOWN ? (
            <div className="cr-list-row">
              <Button
                variant="plain"
                onClick={() => navigate("/app/rules?tab=active")}
              >
                {`+ ${rules.length - RULES_SHOWN} more active rules`}
              </Button>
            </div>
          ) : null}
        </div>
      )}
    </Box>
  );
}

const STEPS = [
  {
    key: "createdRule",
    label: "Create your first rule",
    description: "Start from a template or build your own rule in a few steps.",
  },
  {
    key: "activatedRule",
    label: "Activate a rule",
    description: "Only active rules are enforced at checkout.",
  },
  {
    key: "addedStorefrontMessages",
    label: "Show rule messages on your storefront",
    description:
      "Tell shoppers about a limit before they reach checkout. Each button opens your theme editor with the block added — click Save there.",
  },
  {
    key: "testedRule",
    label: "Test your first rule",
    description:
      "Run a cart through your rules and see exactly what a shopper would be told.",
  },
];

function StepIcon({ done, current, n }) {
  const base = {
    width: 24,
    height: 24,
    borderRadius: "50%",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    fontSize: 12,
    fontWeight: 700,
    flexShrink: 0,
  };
  if (done)
    return (
      <div
        style={{
          ...base,
          background: "var(--p-color-bg-fill-success)",
          color: "#fff",
        }}
        aria-label="Done"
      >
        ✓
      </div>
    );
  if (current)
    return (
      <div style={{ ...base, background: "var(--cr-orange)", color: "#fff" }}>
        {n}
      </div>
    );
  return (
    <div
      style={{
        ...base,
        border: "1.5px dashed var(--p-color-border)",
        color: "var(--p-color-text-secondary)",
      }}
    >
      {n}
    </div>
  );
}

function BlockInstallRow({ title, help, status, enabled, onAdd, addLabel }) {
  const state = blockState(status, enabled);
  return (
    <div className="cr-list-row" style={{ alignItems: "flex-start" }}>
      <div style={{ minWidth: 0 }}>
        <Text as="p" fontWeight="medium">
          {title}
        </Text>
        <Text as="p" tone="subdued" variant="bodySm">
          {help}
        </Text>
      </div>
      <InlineStack gap="200" blockAlign="center" wrap={false}>
        {status === "installed" ? (
          <StatusText kind="ok">Installed ✓</StatusText>
        ) : (
          <StatusText kind={state.kind}>{state.label}</StatusText>
        )}
        {status !== "installed" ? (
          <Button size="slim" onClick={onAdd}>
            {addLabel}
          </Button>
        ) : null}
      </InlineStack>
    </div>
  );
}

function Setup({ data, navigate, fetcher, onHide }) {
  const { checklist, theme, shop, noticesEnabled } = data;
  const done = STEPS.filter((s) => checklist[s.key]).length;
  const allDone = done === STEPS.length;
  const current = STEPS.find((s) => !checklist[s.key])?.key;

  const actions = (key) => {
    switch (key) {
      case "createdRule":
        return (
          <InlineStack gap="200">
            <Button
              variant="primary"
              onClick={() => navigate("/app/rules/new")}
            >
              Create rule
            </Button>
            <Button onClick={() => navigate("/app/templates")}>
              Browse templates
            </Button>
          </InlineStack>
        );
      case "activatedRule":
        return (
          <Button
            variant="primary"
            onClick={() => navigate("/app/rules?tab=paused")}
          >
            Go to rules
          </Button>
        );
      case "addedStorefrontMessages":
        return (
          <BlockStack gap="200">
            <div className="cr-list">
              <BlockInstallRow
                title="Product page notice"
                help="Warn shoppers about limits before adding a product."
                status={theme.productNotice}
                enabled={noticesEnabled.product}
                addLabel="Add to product page"
                onAdd={() =>
                  window.open(getThemeEditorDeepLink(shop), "_blank")
                }
              />
              <BlockInstallRow
                title="Cart quantity guard"
                help="Warn shoppers when their cart quantity exceeds a rule."
                status={theme.cartGuard}
                enabled={noticesEnabled.cart}
                addLabel="Add to cart"
                onAdd={() =>
                  window.open(getCartThemeEditorDeepLink(shop), "_blank")
                }
              />
            </div>
            {theme.productNotice === "unknown" ? (
              <InlineStack gap="200" blockAlign="center">
                <Text as="span" tone="subdued" variant="bodySm">
                  We couldn't read your theme to check automatically.
                </Text>
                <Button
                  variant="plain"
                  onClick={() =>
                    fetcher.submit(
                      { intent: "markStorefrontMessagesAdded" },
                      { method: "post" },
                    )
                  }
                >
                  Mark as done
                </Button>
              </InlineStack>
            ) : (
              <Text as="span" tone="subdued" variant="bodySm">
                Added it already? This updates automatically once you save the
                theme.
              </Text>
            )}
          </BlockStack>
        );
      case "testedRule":
        return (
          <Button variant="primary" onClick={() => navigate("/app/test")}>
            Test a rule
          </Button>
        );
      default:
        return null;
    }
  };

  return (
    <Box
      title="Get started with CartRules"
      subtitle="Four steps to protect your store."
      actions={
        allDone ? (
          <Button variant="plain" onClick={onHide}>
            Hide
          </Button>
        ) : (
          <Badge>{`${done} of ${STEPS.length} complete`}</Badge>
        )
      }
    >
      <BlockStack gap="400">
        <ProgressLine value={done} max={STEPS.length} />
        <div className="cr-list">
          {STEPS.map((step, i) => {
            const isDone = checklist[step.key];
            const isCurrent = step.key === current;
            return (
              <div
                key={step.key}
                className="cr-list-row"
                style={{ display: "block" }}
              >
                <InlineStack gap="300" blockAlign="start" wrap={false}>
                  <StepIcon done={isDone} current={isCurrent} n={i + 1} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <InlineStack
                      align="space-between"
                      blockAlign="center"
                      gap="200"
                    >
                      <Text
                        as="p"
                        fontWeight={isCurrent ? "semibold" : "regular"}
                        tone={isDone ? "subdued" : undefined}
                      >
                        {step.label}
                      </Text>
                      {!isDone && !isCurrent ? (
                        <Button
                          variant="plain"
                          onClick={() =>
                            navigate(
                              step.key === "testedRule"
                                ? "/app/test"
                                : step.key === "createdRule"
                                  ? "/app/rules/new"
                                  : "/app/rules",
                            )
                          }
                        >
                          Start
                        </Button>
                      ) : null}
                    </InlineStack>
                    {isCurrent ||
                    (step.key === "addedStorefrontMessages" && !isDone) ? (
                      <div style={{ marginTop: 8 }}>
                        <BlockStack gap="300">
                          <Text as="p" tone="subdued" variant="bodySm">
                            {step.description}
                          </Text>
                          {isCurrent ? actions(step.key) : null}
                        </BlockStack>
                      </div>
                    ) : null}
                  </div>
                </InlineStack>
              </div>
            );
          })}
        </div>
      </BlockStack>
    </Box>
  );
}

// Storefront activity: what the product/cart notices did for shoppers. Until
// there is any, one slim strip explains what will show up here instead of a
// wall of zeros. (Checkout blocks themselves aren't counted: Shopify doesn't
// report validation results back to apps.)
function ActivityStrip({ navigate, shop }) {
  return (
    <section className="cr-card cr-activity-strip">
      <div className="cr-activity-strip__text">
        <InlineStack gap="300" blockAlign="center" wrap={false}>
          <span className="cr-rule-icon">
            <Icon source={ChartLineIcon} />
          </span>
          <div style={{ minWidth: 0 }}>
            <Text as="p" fontWeight="semibold">
              No shopper activity yet
            </Text>
            <Text as="p" tone="subdued" variant="bodySm">
              When a product or cart notice stops a shopper going over a limit
              or using a blocked discount, it's counted here.
            </Text>
          </div>
        </InlineStack>
      </div>
      <InlineStack gap="200" wrap={false}>
        <Button onClick={() => window.open(`https://${shop}`, "_blank")}>
          View your store
        </Button>
        <Button variant="primary" onClick={() => navigate("/app/test")}>
          Run a test cart
        </Button>
      </InlineStack>
    </section>
  );
}

function RecentActivity({ events, currency, navigate }) {
  return (
    <Box
      title="Recent activity"
      actions={
        events.length ? (
          <Button variant="plain" onClick={() => navigate("/app/activity")}>
            View all activity
          </Button>
        ) : null
      }
    >
      {events.length === 0 ? (
        <Text as="p" tone="subdued">
          Rule hits from your storefront and your rule tests will show here.
        </Text>
      ) : (
        <div className="cr-list">
          {events.map((e) => (
            <div
              key={e.id}
              className="cr-list-row"
              style={{ alignItems: "flex-start" }}
            >
              <div style={{ minWidth: 0 }}>
                <Text as="p" tone="subdued" variant="bodySm">
                  {timeAgo(e.createdAt)}
                  {e.source === "test" ? " · Test" : ""}
                </Text>
                <Text as="p" fontWeight="semibold">
                  {EVENT_LABELS[e.eventType] ?? e.eventType}
                </Text>
                <Text as="p" variant="bodySm">
                  {e.ruleTitle}
                  {e.productTitle ? ` · ${e.productTitle}` : ""}
                </Text>
                <Text as="p" tone="subdued" variant="bodySm">
                  {describeEvent(e, currency)}
                </Text>
              </div>
              <Button
                variant="plain"
                onClick={() =>
                  navigate(
                    `/app/activity?ruleId=${encodeURIComponent(e.ruleId)}`,
                  )
                }
              >
                View →
              </Button>
            </div>
          ))}
        </div>
      )}
    </Box>
  );
}

export default function Overview() {
  const data = useLoaderData();
  const navigate = useNavigate();
  const fetcher = useFetcher();
  const [searchParams, setSearchParams] = useSearchParams();
  const [showSetup, setShowSetup] = useState(false);
  useFlashToast();
  useActionToast(fetcher);

  const setupDone = Object.values(data.checklist).every(Boolean);
  const range = rangeFromSearch(searchParams);
  const chartEmpty = data.series.every((p) => p.count === 0);
  const anyActivity =
    Object.values(data.kpis).some((k) => k.value) || data.recent.length > 0;

  const live = data.counts.live;
  const subtitle = !data.protectionEnabled
    ? "Protection is turned off — your rules aren't enforced."
    : live
      ? `${live} rule${live === 1 ? " is" : "s are"} protecting your store right now.`
      : data.counts.total
        ? "Activate a rule to start protecting your store."
        : "Let's set up your first rule.";

  return (
    <AppPage
      title="Welcome back 👋"
      subtitle={subtitle}
      actions={
        <>
          <Button onClick={() => navigate("/app/templates")}>Templates</Button>
          <Button variant="primary" onClick={() => navigate("/app/rules/new")}>
            + Create rule
          </Button>
        </>
      }
    >
      <StatusCard
        data={data}
        navigate={navigate}
        fetcher={fetcher}
        setupDone={setupDone}
        onShowSetup={() => setShowSetup(true)}
      />

      {!setupDone || showSetup ? (
        <Setup
          data={data}
          navigate={navigate}
          fetcher={fetcher}
          onHide={() => setShowSetup(false)}
        />
      ) : null}

      <YourRules
        rules={data.liveRules}
        total={data.counts.total}
        navigate={navigate}
      />

      {anyActivity ? (
        <>
          <div className="cr-grid cr-grid--kpi">
            <KpiCard
              label="Rule triggers"
              {...data.kpis.triggers}
              hint="Times a rule applied to a shopper's cart on your storefront."
            />
            <KpiCard
              label="Discounts blocked"
              {...data.kpis.discountsBlocked}
            />
            <KpiCard
              label="Quantity limits enforced"
              {...data.kpis.quantityViolations}
            />
            <KpiCard
              label="Carts corrected"
              {...data.kpis.checkoutsProtected}
              hint="Distinct carts where a CartRules rule stepped in on your storefront."
            />
          </div>
          <div className="cr-grid cr-grid--main-side">
            <Box
              title="Rule activity"
              actions={
                <RangePicker
                  value={range}
                  maxDays={data.historyDays}
                  onChange={(next) =>
                    setSearchParams(applyRange(searchParams, next), {
                      preventScrollReset: true,
                    })
                  }
                />
              }
            >
              <BlockStack gap="400">
                <Segmented
                  label="Activity type"
                  options={CATEGORIES}
                  value={data.category}
                  onChange={(value) => {
                    const next = new URLSearchParams(searchParams);
                    next.set("type", value);
                    setSearchParams(next, { preventScrollReset: true });
                  }}
                />
                {chartEmpty ? (
                  <EmptyBlock
                    icon={ChartLineIcon}
                    title="No activity in this period"
                  >
                    Try a longer date range.
                  </EmptyBlock>
                ) : (
                  <ActivityChart series={data.series} label="rule triggers" />
                )}
              </BlockStack>
            </Box>
            <RecentActivity
              events={data.recent}
              currency={data.currency}
              navigate={navigate}
            />
          </div>
        </>
      ) : (
        <ActivityStrip navigate={navigate} shop={data.shop} />
      )}
    </AppPage>
  );
}
