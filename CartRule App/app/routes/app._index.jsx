import { useState } from "react";
import { json } from "@remix-run/node";
import { useLoaderData, useNavigate, useSearchParams, useSubmit } from "@remix-run/react";
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
} from "@shopify/polaris";
import { ChartLineIcon, CartDiscountIcon, AlertTriangleIcon, ShieldCheckMarkIcon } from "@shopify/polaris-icons";
import { authenticate } from "../shopify.server";
import { listRules, getSetupFlags, setSetupFlag } from "../models/rules.server";
import { getThemeEditorDeepLink } from "../utils/themeEditor";
import { getKpis, getActivitySeries, getActivityFeed, hasAnyEvent } from "../models/events.server";
import { getSettings } from "../models/settings.server";
import { RULE_STATUS } from "../models/ruleConstants";
import { useFlashToast } from "../utils/useFlashToast";
import { Eyebrow, IconChip, BRAND_ORANGE } from "../components/brand";

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
    getKpis(session.shop, days),
    getActivitySeries(session.shop, days, chartType === "all" ? null : chartType),
    getActivityFeed(session.shop, { limit: 5 }),
    hasAnyEvent(session.shop),
    getSetupFlags(admin),
    getSettings(admin),
  ]);

  const activeCount = rules.filter((r) => r.status === RULE_STATUS.ACTIVE).length;
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
    checklist: {
      createdRule: rules.length > 0,
      activatedRule: activeCount > 0,
      addedStorefrontMessages: !!setupFlags.storefrontMessagesAdded,
      testedRule: hasEvents,
    },
    shop: session.shop,
  });
};

export const action = async ({ request }) => {
  const { admin } = await authenticate.admin(request);
  const formData = await request.formData();
  if (formData.get("intent") === "markStorefrontMessagesAdded") {
    await setSetupFlag(admin, "storefrontMessagesAdded", true);
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
  { key: "createdRule", label: "Create your first rule" },
  { key: "activatedRule", label: "Activate a rule" },
  { key: "addedStorefrontMessages", label: "Add storefront messages" },
  { key: "testedRule", label: "Test your first rule" },
];

function SetupChecklist({ checklist, shop, navigate, submit }) {
  const [expanded, setExpanded] = useState(false);
  const doneCount = CHECKLIST_STEPS.filter((s) => checklist[s.key]).length;
  const allDone = doneCount === CHECKLIST_STEPS.length;

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

  const stepAction = (key) => {
    if (key === "createdRule" || key === "activatedRule") return () => navigate("/app/rules");
    if (key === "addedStorefrontMessages")
      return () => window.open(getThemeEditorDeepLink(shop), "_blank");
    return () => navigate("/app/rules");
  };

  return (
    <Card>
      <BlockStack gap="300">
        <InlineStack align="space-between">
          <Text as="h2" variant="headingMd">
            CartRules setup
          </Text>
          <Text as="span" tone="subdued">
            {doneCount} of {CHECKLIST_STEPS.length} complete
          </Text>
        </InlineStack>
        <ProgressBar progress={(doneCount / CHECKLIST_STEPS.length) * 100} size="small" tone="success" />
        <BlockStack gap="200">
          {CHECKLIST_STEPS.map((step) => {
            const done = checklist[step.key];
            return (
              <InlineStack key={step.key} align="space-between" blockAlign="center">
                <InlineStack gap="200" blockAlign="center">
                  <span
                    style={{
                      fontSize: 18,
                      lineHeight: 1,
                      color: done ? "var(--p-color-icon-success, #008060)" : "var(--p-color-text-secondary, #6b7177)",
                    }}
                  >
                    {done ? "✓" : "○"}
                  </span>
                  <Text as="span" tone={done ? undefined : "subdued"}>
                    {step.label}
                  </Text>
                </InlineStack>
                {!done ? (
                  <Button variant="plain" onClick={stepAction(step.key)}>
                    {step.key === "addedStorefrontMessages" ? "Open theme editor" : "Go"}
                  </Button>
                ) : null}
              </InlineStack>
            );
          })}
          {!checklist.addedStorefrontMessages ? (
            <Box paddingInlineStart="600">
              <Button
                variant="plain"
                onClick={() => submit({ intent: "markStorefrontMessagesAdded" }, { method: "post" })}
              >
                I've added the storefront message block
              </Button>
            </Box>
          ) : null}
        </BlockStack>
      </BlockStack>
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
  } = useLoaderData();
  const navigate = useNavigate();
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
                  Your store is protected by CartRules.
                </Text>
                <Badge tone={protectionEnabled && activeCount > 0 ? "success" : undefined}>
                  {!protectionEnabled ? "CartRules protection is off" : activeCount > 0 ? "CartRules active ✓" : "CartRules paused"}
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

        <SetupChecklist checklist={checklist} shop={shop} navigate={navigate} submit={submit} />

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
      </BlockStack>
    </Page>
  );
}
