import { useState } from "react";
import { json } from "@remix-run/node";
import { useFetcher, useLoaderData, useNavigate, useSearchParams, useSubmit } from "@remix-run/react";
import {
  Page,
  Card,
  Text,
  BlockStack,
  InlineStack,
  InlineGrid,
  Button,
  Select,
  Box,
  ProgressBar,
  Badge,
  Banner,
} from "@shopify/polaris";
import { ChartLineIcon, CartDiscountIcon, AlertTriangleIcon, ShieldCheckMarkIcon } from "@shopify/polaris-icons";
import { authenticate } from "../shopify.server";
import { listRules, getSetupFlags, setSetupFlag, getCheckoutEnforcement, ensureValidationActive } from "../models/rules.server";
import { getCartThemeEditorDeepLink, getThemeEditorDeepLink } from "../utils/themeEditor";
import { getKpis, getActivitySeries, getActivityFeed, hasAnyEvent } from "../models/events.server";
import { getSettings } from "../models/settings.server";
import { RULE_STATUS } from "../models/ruleConstants";
import { useFlashToast } from "../utils/useFlashToast";
import { useActionToast } from "../utils/useActionToast";
import { Eyebrow, IconChip, StepBadge, BRAND_ORANGE } from "../components/brand";
import { ORDER_ACTIVITY_ENABLED } from "../utils/features";

const NO_KPIS = {
  triggers: { value: 0, changePct: 0 },
  discountsBlocked: { value: 0, changePct: 0 },
  quantityViolations: { value: 0, changePct: 0 },
  checkoutsProtected: { value: 0, changePct: 0 },
};

const PERIODS = [
  { label: "Last 7 days", value: "7" },
  { label: "Last 30 days", value: "30" },
  { label: "Last 90 days", value: "90" },
];

const CHART_TYPE_FILTERS = [
  { label: "All activity", value: "all" },
  { label: "Quantity", value: "max_quantity" },
  { label: "Discount", value: "no_discount" },
];

// Home/dashboard: real KPIs + activity chart + setup checklist + recent
// activity, matching the "CartRules Dashboard" section of the nav spec.
// The rules table itself lives at /app/rules — see app.rules._index.jsx.
export const loader = async ({ request }) => {
  const { admin, session } = await authenticate.admin(request);
  const url = new URL(request.url);
  const days = Number(url.searchParams.get("period")) || 30;
  const chartType = url.searchParams.get("type") ?? "all";

  const [rules, kpis, series, recentActivity, hasEvents, setupFlags, settings] = await Promise.all([
    listRules(admin),
    // Activity data only exists once the orders/create webhook is live —
    // see app/utils/features.js.
    ORDER_ACTIVITY_ENABLED ? getKpis(session.shop, days) : NO_KPIS,
    ORDER_ACTIVITY_ENABLED ? getActivitySeries(session.shop, days, chartType === "all" ? null : chartType) : [],
    ORDER_ACTIVITY_ENABLED ? getActivityFeed(session.shop, { limit: 5 }) : [],
    ORDER_ACTIVITY_ENABLED ? hasAnyEvent(session.shop) : false,
    getSetupFlags(admin),
    getSettings(admin),
  ]);

  const activeCount = rules.filter((r) => r.status === RULE_STATUS.ACTIVE).length;
  // Whether Shopify is actually running CartRules at checkout — the status
  // shown below must match Shopify's checkout settings, not just our own
  // rule count (App Store requirement 2.1.4).
  const checkoutEnforcing = await getCheckoutEnforcement(admin, activeCount);
  const pausedCount = rules.filter((r) => r.status === RULE_STATUS.PAUSED).length;

  return json({
    days,
    chartType,
    totalRules: rules.length,
    activeCount,
    pausedCount,
    kpis,
    series,
    recentActivity,
    protectionEnabled: settings.protectionEnabled,
    checkoutEnforcing,
    checklist: {
      createdRule: rules.length > 0,
      activatedRule: activeCount > 0,
      addedStorefrontMessages: !!setupFlags.storefrontMessagesAdded,
      // Real order activity needs the (currently disabled) orders/create
      // webhook, so running the Rules page's "Test rule" tool counts too —
      // otherwise this step could never be completed.
      testedRule: hasEvents || !!setupFlags.ruleTested,
    },
    shop: session.shop,
  });
};

export const action = async ({ request }) => {
  const { admin } = await authenticate.admin(request);
  const formData = await request.formData();
  if (formData.get("intent") === "enableValidation") {
    try {
      await ensureValidationActive(admin);
    } catch (error) {
      console.error("Failed to enable checkout validation", error);
      return json({ ok: false, toast: "Couldn't turn on CartRules at checkout. Please try again.", toastError: true });
    }
    return json({ ok: true, toast: "CartRules is now enforced at checkout" });
  }
  if (formData.get("intent") === "markStorefrontMessagesAdded") {
    try {
      await setSetupFlag(admin, "storefrontMessagesAdded", true);
    } catch (error) {
      console.error("Failed to save setup flag", error);
      return json({ ok: false });
    }
  }
  return json({ ok: true });
};

// useFlashToast strips ?toast=/&toastId=/&toastError= right after showing
// them (see app/utils/useFlashToast.js) via a normal searchParams update —
// which by default triggers a full loader revalidation, doubling every
// KPI/activity/rules query on top of the one the redirect itself already
// ran. That param cleanup can't change what this loader returns, so skip
// revalidating when it's the only thing that changed.
export function shouldRevalidate({ currentUrl, nextUrl, defaultShouldRevalidate }) {
  const strip = (url) => {
    const params = new URLSearchParams(url.search);
    params.delete("toast");
    params.delete("toastId");
    params.delete("toastError");
    return params.toString();
  };
  if (currentUrl.pathname === nextUrl.pathname && strip(currentUrl) === strip(nextUrl)) {
    return false;
  }
  return defaultShouldRevalidate;
}

function kpiHelpText(kpi) {
  if (kpi.value === 0 && (kpi.changePct === 0 || kpi.changePct == null)) {
    return { text: "No activity yet", tone: "subdued" };
  }
  if (kpi.changePct == null) return { text: "New this period", tone: "subdued" };
  if (kpi.changePct === 0) return { text: "No change vs previous period", tone: "subdued" };
  const positive = kpi.changePct > 0;
  return {
    text: `${positive ? "↑" : "↓"} ${Math.abs(kpi.changePct)}% vs previous period`,
    tone: positive ? "success" : "critical",
  };
}

function KpiCard({ icon, label, kpi, tone }) {
  const help = kpiHelpText(kpi);
  return (
    <Card>
      <BlockStack gap="150">
        <InlineStack gap="150" blockAlign="center">
          <IconChip icon={icon} tone={tone} />
          <Text as="span" tone="subdued">
            {label}
          </Text>
        </InlineStack>
        <Text as="p" variant="heading2xl">
          {kpi.value.toLocaleString()}
        </Text>
        <Text as="span" variant="bodySm" tone={help.tone}>
          {help.text}
        </Text>
      </BlockStack>
    </Card>
  );
}

function ActivityChart({ series }) {
  const max = Math.max(1, ...series.map((p) => p.count));
  const width = 100 / series.length;
  return (
    <div style={{ display: "flex", alignItems: "flex-end", height: 140, gap: 2 }}>
      {series.map((p) => (
        <div
          key={p.date}
          title={`${p.date}: ${p.count}`}
          style={{
            width: `${width}%`,
            height: `${Math.max(4, (p.count / max) * 100)}%`,
            background: p.count > 0
              ? `linear-gradient(180deg, ${BRAND_ORANGE}, #ffb280)`
              : "var(--p-color-bg-surface-secondary, #f1f1f1)",
            borderRadius: 2,
          }}
        />
      ))}
    </div>
  );
}

function eventIcon(ruleType) {
  return ruleType === "max_quantity"
    ? { icon: AlertTriangleIcon, tone: "caution" }
    : { icon: CartDiscountIcon, tone: "magic" };
}

function relativeTime(iso) {
  const diffMs = Date.now() - new Date(iso).getTime();
  const minutes = Math.round(diffMs / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"} ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.round(hours / 24);
  return `${days} day${days === 1 ? "" : "s"} ago`;
}

const CHECKLIST_STEPS = [
  {
    key: "createdRule",
    label: "Create your first rule",
    description: "Pick a template or start from scratch: limit quantities or block discount codes on chosen products.",
  },
  {
    key: "activatedRule",
    label: "Activate a rule",
    description: "Only active rules are enforced at checkout. Turn one on from the Rules page.",
  },
  {
    key: "addedStorefrontMessages",
    label: "Show rule messages on your storefront",
    description:
      "Tell shoppers about a limit before they reach checkout. Each button opens your theme editor with the CartRules block already added; click Save there to publish it.",
  },
  {
    key: "testedRule",
    label: "Test your first rule",
    description: "Use “Test rule” on the Rules page to see exactly what a customer would be told at checkout.",
  },
];

function StepStatus({ done, current, n }) {
  if (done) {
    return (
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          width: 24,
          height: 24,
          borderRadius: "50%",
          background: "var(--p-color-bg-fill-success, #29845a)",
          color: "#fff",
          fontSize: 13,
          fontWeight: 700,
          flexShrink: 0,
        }}
        aria-label="Done"
      >
        ✓
      </div>
    );
  }
  if (current) return <StepBadge n={n} />;
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        width: 24,
        height: 24,
        borderRadius: "50%",
        border: "1.5px dashed var(--p-color-border, #8a8a8a)",
        color: "var(--p-color-text-secondary, #616161)",
        fontSize: 12,
        fontWeight: 600,
        flexShrink: 0,
      }}
    >
      {n}
    </div>
  );
}

function SetupChecklist({ checklist, shop, navigate, submit }) {
  const [expanded, setExpanded] = useState(false);
  const doneCount = CHECKLIST_STEPS.filter((s) => checklist[s.key]).length;
  const allDone = doneCount === CHECKLIST_STEPS.length;
  // The first unfinished step is the one we expand and point the merchant at.
  const currentKey = CHECKLIST_STEPS.find((s) => !checklist[s.key])?.key;

  if (allDone && !expanded) {
    return (
      <Card>
        <InlineStack align="space-between" blockAlign="center">
          <Text as="span" fontWeight="medium">
            ✓ CartRules setup complete
          </Text>
          <Button variant="plain" onClick={() => setExpanded(true)}>
            Review setup
          </Button>
        </InlineStack>
      </Card>
    );
  }

  const startAction = (key) => {
    if (key === "createdRule") return () => navigate("/app/rules/new");
    if (key === "addedStorefrontMessages") return () => window.open(getThemeEditorDeepLink(shop), "_blank");
    return () => navigate("/app/rules");
  };

  const stepActions = (key, primary) => {
    const variant = primary ? "primary" : undefined;
    switch (key) {
      case "createdRule":
        return (
          <InlineStack gap="200">
            <Button variant={variant} onClick={() => navigate("/app/rules/new")}>
              Create rule
            </Button>
            <Button onClick={() => navigate("/app/templates")}>Browse templates</Button>
          </InlineStack>
        );
      case "activatedRule":
        return (
          <InlineStack gap="200">
            <Button variant={variant} onClick={() => navigate("/app/rules")}>
              Go to rules
            </Button>
          </InlineStack>
        );
      case "addedStorefrontMessages":
        return (
          <InlineStack gap="200" blockAlign="center">
            <Button variant={variant} onClick={() => window.open(getThemeEditorDeepLink(shop), "_blank")}>
              Add product page notice
            </Button>
            <Button onClick={() => window.open(getCartThemeEditorDeepLink(shop), "_blank")}>
              Add cart quantity guard
            </Button>
            <Button
              variant="plain"
              onClick={() => submit({ intent: "markStorefrontMessagesAdded" }, { method: "post" })}
            >
              Mark as done
            </Button>
          </InlineStack>
        );
      default:
        return (
          <InlineStack gap="200">
            <Button variant={variant} onClick={() => navigate("/app/rules")}>
              Test a rule
            </Button>
          </InlineStack>
        );
    }
  };

  return (
    <Card padding="0">
      <Box padding="400">
        <BlockStack gap="300">
          <InlineStack align="space-between" blockAlign="center">
            <BlockStack gap="100">
              <Text as="h2" variant="headingMd">
                Get started with CartRules
              </Text>
              <Text as="p" tone="subdued">
                Finish these steps so your rules protect checkout and shoppers see them in your store.
              </Text>
            </BlockStack>
            <Badge tone={allDone ? "success" : undefined}>{`${doneCount} of ${CHECKLIST_STEPS.length} done`}</Badge>
          </InlineStack>
          <ProgressBar progress={(doneCount / CHECKLIST_STEPS.length) * 100} size="small" tone="success" />
        </BlockStack>
      </Box>
      {CHECKLIST_STEPS.map((step, i) => {
        const done = !!checklist[step.key];
        const current = step.key === currentKey;
        return (
          <Box
            key={step.key}
            paddingInline="400"
            paddingBlock="300"
            borderBlockStartWidth="025"
            borderColor="border"
            background={current ? "bg-surface-secondary" : undefined}
          >
            <InlineStack gap="300" wrap={false} blockAlign="start">
              <StepStatus done={done} current={current} n={i + 1} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <BlockStack gap="200">
                  <InlineStack align="space-between" blockAlign="center" gap="200">
                    <Text as="h3" fontWeight={current ? "semibold" : "regular"} tone={done ? "subdued" : undefined}>
                      {step.label}
                    </Text>
                    {!done && !current ? (
                      <Button variant="plain" onClick={startAction(step.key)}>
                        Start
                      </Button>
                    ) : null}
                  </InlineStack>
                  {current ? (
                    <>
                      <Text as="p" tone="subdued">
                        {step.description}
                      </Text>
                      {stepActions(step.key, true)}
                    </>
                  ) : null}
                </BlockStack>
              </div>
            </InlineStack>
          </Box>
        );
      })}
    </Card>
  );
}

export default function Dashboard() {
  const {
    days,
    chartType,
    totalRules,
    activeCount,
    pausedCount,
    kpis,
    series,
    recentActivity,
    checklist,
    shop,
    protectionEnabled,
    checkoutEnforcing,
  } = useLoaderData();
  const navigate = useNavigate();
  const validationFetcher = useFetcher();
  useActionToast(validationFetcher);
  const notEnforced = checkoutEnforcing === false && activeCount > 0;
  const isProtecting = protectionEnabled && activeCount > 0 && !notEnforced;
  const submit = useSubmit();
  const [searchParams, setSearchParams] = useSearchParams();
  useFlashToast();

  const setParam = (key, value) => {
    searchParams.set(key, value);
    setSearchParams(searchParams);
  };

  const noChartData = series.every((p) => p.count === 0);

  return (
    <Page
      title="Welcome back 👋"
      primaryAction={{ content: "Create rule", onAction: () => navigate("/app/rules/new") }}
      secondaryActions={[{ content: "View rules", onAction: () => navigate("/app/rules") }]}
    >
      <BlockStack gap="400">
        <Eyebrow>Dashboard</Eyebrow>
        <div
          style={{
            padding: "var(--p-space-400)",
            borderRadius: "var(--p-border-radius-300)",
            background: "linear-gradient(135deg, #fff4ec 0%, #ffe4d1 100%)",
          }}
        >
          <InlineStack gap="300" blockAlign="center">
            <div
              style={{
                borderRadius: 12,
                overflow: "hidden",
                flexShrink: 0,
                boxShadow: "0 4px 10px rgba(255, 90, 31, 0.25)",
              }}
            >
              <img src="/logo.png" alt="CartRules" width={56} height={56} style={{ objectFit: "contain", display: "block" }} />
            </div>
            <BlockStack gap="100">
              <InlineStack gap="200" blockAlign="center">
                <Text as="p" variant="headingMd">
                  {isProtecting ? "Your store is protected by CartRules." : "Your store isn't protected by CartRules yet."}
                </Text>
                <Badge tone={isProtecting ? "success" : notEnforced ? "critical" : undefined}>
                  {!protectionEnabled
                    ? "CartRules protection is off"
                    : notEnforced
                      ? "Off at checkout"
                      : activeCount > 0
                        ? "CartRules active ✓"
                        : "CartRules paused"}
                </Badge>
              </InlineStack>
            </BlockStack>
          </InlineStack>
          <Text as="p" tone="subdued">
            {totalRules === 0
              ? "Create your first rule to get started."
              : `${activeCount} active rule${activeCount === 1 ? "" : "s"} · ${pausedCount} paused`}
          </Text>
        </div>

        {notEnforced ? (
          <Banner
            tone="critical"
            title="Your active rules aren't being enforced at checkout"
            action={{
              content: "Turn on at checkout",
              loading: validationFetcher.state !== "idle",
              onAction: () => validationFetcher.submit({ intent: "enableValidation" }, { method: "post" }),
            }}
          >
            <p>
              The CartRules checkout rule is off in Shopify (Settings → Checkout → Checkout rules), so customers can
              check out without these limits applying.
            </p>
          </Banner>
        ) : null}

        {ORDER_ACTIVITY_ENABLED ? (
          <>
            <InlineGrid columns={{ xs: 1, sm: 2, md: 4 }} gap="400">
              <KpiCard icon={ChartLineIcon} label="Rule triggers" kpi={kpis.triggers} tone="info" />
              <KpiCard icon={CartDiscountIcon} label="Discounts blocked" kpi={kpis.discountsBlocked} tone="magic" />
              <KpiCard icon={AlertTriangleIcon} label="Quantity violations" kpi={kpis.quantityViolations} tone="caution" />
              <KpiCard icon={ShieldCheckMarkIcon} label="Protected checkouts" kpi={kpis.checkoutsProtected} tone="success" />
            </InlineGrid>

            <Card>
              <BlockStack gap="300">
                <InlineStack align="space-between" blockAlign="center">
                  <Text as="h2" variant="headingMd">
                    Rule activity
                  </Text>
                  <InlineStack gap="200">
                    <div style={{ minWidth: 130 }}>
                      <Select
                        label="Type"
                        labelHidden
                        options={CHART_TYPE_FILTERS}
                        value={chartType}
                        onChange={(v) => setParam("type", v)}
                      />
                    </div>
                    <div style={{ minWidth: 150 }}>
                      <Select
                        label="Period"
                        labelHidden
                        options={PERIODS}
                        value={String(days)}
                        onChange={(v) => setParam("period", v)}
                      />
                    </div>
                  </InlineStack>
                </InlineStack>
                {noChartData ? (
                  <BlockStack gap="200">
                    <Text as="p" fontWeight="medium">
                      No activity yet
                    </Text>
                    <Text as="p" tone="subdued">
                      Once customers interact with an active rule, you'll see rule activity here.
                    </Text>
                    <InlineStack>
                      <Button onClick={() => navigate("/app/rules/new")}>Create a rule</Button>
                    </InlineStack>
                  </BlockStack>
                ) : (
                  <ActivityChart series={series} />
                )}
              </BlockStack>
            </Card>
          </>
        ) : null}

        <SetupChecklist checklist={checklist} shop={shop} navigate={navigate} submit={submit} />

        {ORDER_ACTIVITY_ENABLED ? (
          <Card>
            <BlockStack gap="300">
              <InlineStack align="space-between" blockAlign="center">
                <Text as="h2" variant="headingMd">
                  Recent activity
                </Text>
                <Button variant="plain" onClick={() => navigate("/app/activity")}>
                  View all
                </Button>
              </InlineStack>
              {recentActivity.length === 0 ? (
                <Text as="p" tone="subdued">
                  No rule activity yet. Activity will appear here after shoppers interact with your rules.
                </Text>
              ) : (
                <BlockStack gap="300">
                  {recentActivity.map((event) => {
                    const { icon, tone } = eventIcon(event.ruleType);
                    return (
                      <Box key={event.id} paddingBlockEnd="200" borderBlockEndWidth="025" borderColor="border">
                        <InlineStack gap="200" wrap={false}>
                          <IconChip icon={icon} tone={tone} size={28} />
                          <BlockStack gap="050">
                            <Text as="span" tone="subdued" variant="bodySm">
                              {relativeTime(event.createdAt)}
                            </Text>
                            <Text as="span" fontWeight="bold">
                              {event.ruleTitle}
                            </Text>
                            <Text as="span" tone="subdued">
                              {event.ruleType === "max_quantity" ? "Quantity violation" : "Discount blocked"}
                              {event.productTitle ? ` · ${event.productTitle}` : ""} · {event.detail}
                            </Text>
                          </BlockStack>
                        </InlineStack>
                      </Box>
                    );
                  })}
                </BlockStack>
              )}
            </BlockStack>
          </Card>
        ) : null}
      </BlockStack>
    </Page>
  );
}
