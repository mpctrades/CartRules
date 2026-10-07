import { useState } from "react";
import { json } from "@remix-run/node";
import { useFetcher, useLoaderData, useNavigate, useSearchParams } from "@remix-run/react";
import { Badge, BlockStack, Button, Icon, InlineStack, Text } from "@shopify/polaris";
import { CheckCircleIcon, ChartLineIcon, ShieldCheckMarkIcon } from "@shopify/polaris-icons";
import { authenticate } from "../shopify.server";
import { loadAppContext } from "../models/context.server";
import { getCheckoutEnforcement, ensureValidationActive, getSetupFlags, setSetupFlag, readRulesCache, FUNCTION_METAFIELD_MAX_BYTES } from "../models/rules.server";
import { getRulesHealth } from "../models/health.server";
import { getThemeBlockStatus } from "../models/theme.server";
import { getKpis, getActivitySeries, getActivityFeed, hasAnyEvent, resolveRange, HISTORY_DAYS } from "../models/events.server";
import { CUSTOMER_TYPES, RULE_STATUS } from "../models/ruleConstants";
import { getScheduleStatus, EVENT_LABELS, describeEvent, timeAgo } from "../models/ruleDisplay";
import { getCartThemeEditorDeepLink, getThemeEditorDeepLink } from "../utils/themeEditor";
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
    { days: url.searchParams.get("days") ?? 30, from: url.searchParams.get("from"), to: url.searchParams.get("to") },
    plan.name,
  );

  const statuses = rules.map((r) => getScheduleStatus(r));
  const liveCount = statuses.filter((s) => s === "active").length;
  const customerRuleIds = rules.filter((r) => r.customer?.type && r.customer.type !== CUSTOMER_TYPES.EVERYONE).map((r) => r.id);

  const [health, theme, cache, checkoutEnforcing, setupFlags, kpis, series, recent, hasEvents] = await Promise.all([
    getRulesHealth(admin, shop, rules, { plan: plan.name, conflictMode: settings.conflictMode }),
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
    (r, i) => (statuses[i] === "active" || statuses[i] === "scheduled") && health.health[r.id]?.issues?.length,
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
    noticesEnabled: { product: settings.productNoticesEnabled, cart: settings.cartNoticesEnabled },
    checkoutEnforcing,
    cacheTooLarge: cache.bytes > FUNCTION_METAFIELD_MAX_BYTES,
    theme,
    conflicts: health.conflicts,
    attention: needsAttention.map((r) => ({ id: r.id, title: r.title, issue: health.health[r.id].issues[0].message })),
    kpis,
    series,
    recent: recent.events,
    currency: ctx.currency,
    checklist: {
      createdRule: rules.length > 0,
      activatedRule: rules.some((r) => r.status === RULE_STATUS.ACTIVE),
      // Detected from the live theme; the manual flag only counts when the
      // theme couldn't be read (e.g. the theme scope isn't granted yet).
      addedStorefrontMessages:
        theme.productNotice === "installed" ||
        theme.cartGuard === "installed" ||
        (theme.productNotice === "unknown" && Boolean(setupFlags.storefrontMessagesAdded)),
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
    return json({ ok: false, toast: "Something went wrong. Please try again.", toastError: true });
  }
  return json({ ok: false }, { status: 400 });
};

// useFlashToast strips ?toast= after showing it; that alone can't change
// this loader's result, so don't re-run every query for it.
export function shouldRevalidate({ currentUrl, nextUrl, defaultShouldRevalidate }) {
  const strip = (url) => {
    const params = new URLSearchParams(url.search);
    ["toast", "toastId", "toastError"].forEach((k) => params.delete(k));
    return params.toString();
  };
  if (currentUrl.pathname === nextUrl.pathname && strip(currentUrl) === strip(nextUrl)) return false;
  return defaultShouldRevalidate;
}

function blockState(status, enabled) {
  if (!enabled) return { kind: "off", label: "Turned off in Settings" };
  if (status === "installed") return { kind: "ok", label: "Active" };
  if (status === "disabled") return { kind: "warn", label: "Hidden in theme" };
  if (status === "missing") return { kind: "warn", label: "Not installed" };
  return { kind: "off", label: "Couldn't check" };
}

function ProtectionCard({ data, navigate }) {
  const { counts, protectionEnabled, checkoutEnforcing, cacheTooLarge, attention, conflicts } = data;
  const issues = attention.length + (cacheTooLarge ? 1 : 0) + (checkoutEnforcing === false && counts.live > 0 ? 1 : 0);
  let headline;
  let kind;
  if (!protectionEnabled) {
    headline = "CartRules protection is off";
    kind = "bad";
  } else if (counts.live === 0) {
    headline = counts.scheduled ? "Waiting for a scheduled rule" : "No active rules yet";
    kind = "off";
  } else if (checkoutEnforcing === false || cacheTooLarge) {
    headline = "Checkout isn't enforcing your rules";
    kind = "bad";
  } else if (issues > 0) {
    headline = "CartRules is active — needs attention";
    kind = "warn";
  } else {
    headline = "CartRules is active";
    kind = "ok";
  }
  const color = {
    ok: "var(--p-color-text-success)",
    warn: "var(--p-color-text-caution)",
    bad: "var(--p-color-text-critical)",
    off: "var(--p-color-text-secondary)",
  }[kind];

  return (
    <Box
      title="Store protection"
      actions={
        <Button variant="plain" onClick={() => navigate("/app/rules")}>
          View status
        </Button>
      }
    >
      <BlockStack gap="400">
        <InlineStack gap="200" blockAlign="center" wrap={false}>
          <span style={{ color, display: "inline-flex" }}>
            <Icon source={kind === "ok" ? CheckCircleIcon : ShieldCheckMarkIcon} />
          </span>
          <Text as="p" variant="headingMd">
            {headline}
            {kind === "ok" ? " ✓" : ""}
          </Text>
        </InlineStack>
        <InlineStack gap="600" wrap>
          <Metric value={counts.live} label={counts.live === 1 ? "active rule" : "active rules"} />
          <Metric value={counts.paused} label="paused" />
          {counts.scheduled ? <Metric value={counts.scheduled} label="scheduled" /> : null}
          <Metric value={issues + conflicts.length} label={issues + conflicts.length === 1 ? "issue" : "issues"} warn={issues + conflicts.length > 0} />
        </InlineStack>
      </BlockStack>
    </Box>
  );
}

function Metric({ value, label, warn }) {
  return (
    <div>
      <div style={{ fontSize: 22, fontWeight: 650, color: warn ? "var(--p-color-text-caution)" : undefined }}>{value}</div>
      <div className="cr-muted">{label}</div>
    </div>
  );
}

function StoreHealth({ data, navigate, fetcher }) {
  const { checkoutEnforcing, theme, noticesEnabled, conflicts, shop, attention, cacheTooLarge, protectionEnabled, counts } = data;
  const product = blockState(theme.productNotice, noticesEnabled.product);
  const cart = blockState(theme.cartGuard, noticesEnabled.cart);

  const checkoutRow =
    checkoutEnforcing === true
      ? { kind: "ok", label: "Active" }
      : checkoutEnforcing === false
        ? counts.live > 0
          ? { kind: "bad", label: "Turned off" }
          : { kind: "off", label: "Off — no active rules" }
        : { kind: "off", label: "Couldn't check" };

  const rows = [
    { key: "checkout", label: "Checkout validation", ...checkoutRow },
    { key: "product", label: "Product page notices", ...product },
    { key: "cart", label: "Cart quantity guard", ...cart },
    {
      key: "conflicts",
      label: "Rule conflicts",
      ...(conflicts.length ? { kind: "warn", label: `${conflicts.length} found` } : { kind: "ok", label: "None" }),
    },
  ];

  // Only real problems, each with one way to fix it.
  const problems = [];
  if (!protectionEnabled) problems.push({ text: "CartRules protection is turned off", action: "Turn on", run: () => navigate("/app/settings") });
  if (checkoutEnforcing === false && counts.live > 0) {
    problems.push({
      text: "Checkout validation is turned off in Shopify",
      action: "Turn on",
      loading: fetcher.state !== "idle",
      run: () => fetcher.submit({ intent: "enableValidation" }, { method: "post" }),
    });
  }
  if (cacheTooLarge) problems.push({ text: "Your rules are too large for checkout to read", action: "Review rules", run: () => navigate("/app/rules") });
  if (theme.productNotice === "missing" && noticesEnabled.product) {
    problems.push({ text: "Product page notice not installed", action: "Fix issue", run: () => window.open(getThemeEditorDeepLink(shop), "_blank") });
  }
  if (theme.cartGuard === "missing" && noticesEnabled.cart) {
    problems.push({ text: "Cart quantity guard not installed", action: "Fix issue", run: () => window.open(getCartThemeEditorDeepLink(shop), "_blank") });
  }
  for (const a of attention.slice(0, 3)) {
    problems.push({ text: `${a.title}: ${a.issue}`, action: "Fix rule", run: () => navigate(`/app/rules/${encodeURIComponent(a.id)}`) });
  }
  if (conflicts.length) problems.push({ text: conflicts[0].message, action: "Review", run: () => navigate("/app/rules") });

  return (
    <Box title="Store health" subtitle={theme.themeName ? `Live theme: ${theme.themeName}` : undefined}>
      <div className="cr-list">
        {rows.map((row) => (
          <div key={row.key} className="cr-list-row">
            <Text as="span">{row.label}</Text>
            <StatusText kind={row.kind}>
              {row.label}
              {row.kind === "ok" ? " ✓" : ""}
            </StatusText>
          </div>
        ))}
      </div>
      {problems.length ? (
        <div style={{ marginTop: 16, padding: 14, borderRadius: 12, background: "var(--p-color-bg-surface-caution)" }}>
          <BlockStack gap="200">
            <Text as="h3" variant="headingSm">
              Needs attention
            </Text>
            {problems.slice(0, 4).map((p) => (
              <InlineStack key={p.text} align="space-between" blockAlign="center" gap="200" wrap={false}>
                <Text as="span" variant="bodySm">
                  {p.text}
                </Text>
                <Button size="slim" onClick={p.run} loading={p.loading}>
                  {p.action}
                </Button>
              </InlineStack>
            ))}
          </BlockStack>
        </div>
      ) : null}
    </Box>
  );
}

const STEPS = [
  { key: "createdRule", label: "Create your first rule", description: "Start from a template or build your own rule in a few steps." },
  { key: "activatedRule", label: "Activate a rule", description: "Only active rules are enforced at checkout." },
  {
    key: "addedStorefrontMessages",
    label: "Show rule messages on your storefront",
    description: "Tell shoppers about a limit before they reach checkout. Each button opens your theme editor with the block added — click Save there.",
  },
  { key: "testedRule", label: "Test your first rule", description: "Run a cart through your rules and see exactly what a shopper would be told." },
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
  if (done) return <div style={{ ...base, background: "var(--p-color-bg-fill-success)", color: "#fff" }} aria-label="Done">✓</div>;
  if (current) return <div style={{ ...base, background: "var(--cr-orange)", color: "#fff" }}>{n}</div>;
  return <div style={{ ...base, border: "1.5px dashed var(--p-color-border)", color: "var(--p-color-text-secondary)" }}>{n}</div>;
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
        {status === "installed" ? <StatusText kind="ok">Installed ✓</StatusText> : <StatusText kind={state.kind}>{state.label}</StatusText>}
        {status !== "installed" ? (
          <Button size="slim" onClick={onAdd}>
            {addLabel}
          </Button>
        ) : null}
      </InlineStack>
    </div>
  );
}

function Setup({ data, navigate, fetcher }) {
  const { checklist, theme, shop, noticesEnabled } = data;
  const done = STEPS.filter((s) => checklist[s.key]).length;
  const allDone = done === STEPS.length;
  const [expanded, setExpanded] = useState(false);
  const current = STEPS.find((s) => !checklist[s.key])?.key;

  if (allDone && !expanded) {
    return (
      <Box>
        <InlineStack align="space-between" blockAlign="center" gap="200">
          <InlineStack gap="300" blockAlign="center" wrap={false}>
            <span style={{ color: "var(--p-color-text-success)", display: "inline-flex" }}>
              <Icon source={CheckCircleIcon} />
            </span>
            <div>
              <Text as="p" fontWeight="semibold">
                CartRules setup complete
              </Text>
              <Text as="p" tone="subdued" variant="bodySm">
                Your store is protected and ready.
              </Text>
            </div>
          </InlineStack>
          <Button variant="plain" onClick={() => setExpanded(true)}>
            Review setup →
          </Button>
        </InlineStack>
      </Box>
    );
  }

  const actions = (key) => {
    switch (key) {
      case "createdRule":
        return (
          <InlineStack gap="200">
            <Button variant="primary" onClick={() => navigate("/app/rules/new")}>
              Create rule
            </Button>
            <Button onClick={() => navigate("/app/templates")}>Browse templates</Button>
          </InlineStack>
        );
      case "activatedRule":
        return (
          <Button variant="primary" onClick={() => navigate("/app/rules?tab=paused")}>
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
                onAdd={() => window.open(getThemeEditorDeepLink(shop), "_blank")}
              />
              <BlockInstallRow
                title="Cart quantity guard"
                help="Warn shoppers when their cart quantity exceeds a rule."
                status={theme.cartGuard}
                enabled={noticesEnabled.cart}
                addLabel="Add to cart"
                onAdd={() => window.open(getCartThemeEditorDeepLink(shop), "_blank")}
              />
            </div>
            {theme.productNotice === "unknown" ? (
              <InlineStack gap="200" blockAlign="center">
                <Text as="span" tone="subdued" variant="bodySm">
                  We couldn't read your theme to check automatically.
                </Text>
                <Button variant="plain" onClick={() => fetcher.submit({ intent: "markStorefrontMessagesAdded" }, { method: "post" })}>
                  Mark as done
                </Button>
              </InlineStack>
            ) : (
              <Text as="span" tone="subdued" variant="bodySm">
                Added it already? This updates automatically once you save the theme.
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
          <Button variant="plain" onClick={() => setExpanded(false)}>
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
              <div key={step.key} className="cr-list-row" style={{ display: "block" }}>
                <InlineStack gap="300" blockAlign="start" wrap={false}>
                  <StepIcon done={isDone} current={isCurrent} n={i + 1} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <InlineStack align="space-between" blockAlign="center" gap="200">
                      <Text as="p" fontWeight={isCurrent ? "semibold" : "regular"} tone={isDone ? "subdued" : undefined}>
                        {step.label}
                      </Text>
                      {!isDone && !isCurrent ? (
                        <Button variant="plain" onClick={() => navigate(step.key === "testedRule" ? "/app/test" : step.key === "createdRule" ? "/app/rules/new" : "/app/rules")}>
                          Start
                        </Button>
                      ) : null}
                    </InlineStack>
                    {isCurrent || (step.key === "addedStorefrontMessages" && !isDone) ? (
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
            <div key={e.id} className="cr-list-row" style={{ alignItems: "flex-start" }}>
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
              <Button variant="plain" onClick={() => navigate(`/app/activity?ruleId=${encodeURIComponent(e.ruleId)}`)}>
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
  useFlashToast();
  useActionToast(fetcher);

  const setupDone = Object.values(data.checklist).every(Boolean);
  const range = rangeFromSearch(searchParams);
  const chartEmpty = data.series.every((p) => p.count === 0);

  return (
    <AppPage
      title="Welcome back 👋"
      subtitle="Here’s what’s happening with CartRules today."
      actions={
        <>
          <Button onClick={() => navigate("/app/rules")}>View rules</Button>
          <Button variant="primary" onClick={() => navigate("/app/rules/new")}>
            + Create rule
          </Button>
        </>
      }
    >
      <div className="cr-grid cr-grid--2">
        <ProtectionCard data={data} navigate={navigate} />
        <StoreHealth data={data} navigate={navigate} fetcher={fetcher} />
      </div>

      <Setup data={data} navigate={navigate} fetcher={fetcher} />

      {setupDone ? (
        <div className="cr-grid cr-grid--kpi">
          <KpiCard label="Rule triggers" {...data.kpis.triggers} />
          <KpiCard label="Discounts blocked" {...data.kpis.discountsBlocked} />
          <KpiCard label="Quantity violations" {...data.kpis.quantityViolations} />
          <KpiCard
            label="Protected checkouts"
            {...data.kpis.checkoutsProtected}
            hint="Distinct carts where a CartRules rule stepped in on your storefront."
          />
        </div>
      ) : null}

      <div className="cr-grid cr-grid--main-side">
        <Box
          title="Rule activity"
          actions={
            <RangePicker
              value={range}
              maxDays={data.historyDays}
              onChange={(next) => setSearchParams(applyRange(searchParams, next), { preventScrollReset: true })}
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
                title="No activity yet"
                action={<Button onClick={() => navigate("/app/test")}>Test a rule</Button>}
              >
                Rule activity will appear here when shoppers trigger your rules.
              </EmptyBlock>
            ) : (
              <ActivityChart series={data.series} label="rule triggers" />
            )}
          </BlockStack>
        </Box>
        <RecentActivity events={data.recent} currency={data.currency} navigate={navigate} />
      </div>
    </AppPage>
  );
}
