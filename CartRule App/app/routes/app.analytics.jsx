import { json } from "@remix-run/node";
import {
  Link,
  useLoaderData,
  useNavigate,
  useNavigation,
  useSearchParams,
} from "@remix-run/react";
import {
  Badge,
  Banner,
  Button,
  Icon,
  InlineStack,
  BlockStack,
  Select,
  Text,
} from "@shopify/polaris";
import { InfoIcon } from "@shopify/polaris-icons";
import { loadAppContext } from "../models/context.server";
import {
  getKpis,
  getActivitySeries,
  getBreakdowns,
  getRulePerformance,
  resolveRange,
  HISTORY_DAYS,
} from "../models/events.server";
import { getThemeBlockStatus } from "../models/theme.server";
import {
  getCartThemeEditorDeepLink,
  getThemeEditorDeepLink,
} from "../utils/themeEditor";
import {
  ruleTypeLabel,
  describeRule,
  getScheduleStatus,
  timeAgo,
} from "../models/ruleDisplay";
import {
  AppPage,
  Box,
  KpiCard,
  ActivityChart,
  BarList,
  RangePicker,
  rangeFromSearch,
  applyRange,
} from "../components/ui";

// Analytics counts live (storefront) events only — rule tests never count.
export const loader = async ({ request }) => {
  const ctx = await loadAppContext(request, { settings: false });
  const p = new URL(request.url).searchParams;
  const requestedDays = Number(p.get("days") ?? 30) || 30;
  const range = resolveRange(
    { days: requestedDays, from: p.get("from"), to: p.get("to") },
    ctx.plan.name,
  );
  const ruleId = ctx.rules.some((r) => r.id === p.get("ruleId"))
    ? p.get("ruleId")
    : null;
  const ruleIds = ruleId ? [ruleId] : null;

  const [kpis, series, breakdowns, performance, theme] = await Promise.all([
    getKpis(ctx.shop, range, { ruleIds }),
    getActivitySeries(ctx.shop, range, { ruleIds }),
    getBreakdowns(ctx.shop, range, { ruleIds }),
    getRulePerformance(ctx.shop, range),
    getThemeBlockStatus(ctx.admin, ctx.shop),
  ]);
  // Every live/scheduled rule (so silent rules show too), plus any other
  // rule that fired in the range; busiest first.
  const ruleRows = ctx.rules
    .map((r) => ({ r, status: getScheduleStatus(r) }))
    .filter(
      ({ r, status }) =>
        status === "active" || status === "scheduled" || performance[r.id],
    )
    .map(({ r, status }) => ({
      id: r.id,
      title: r.title || "Untitled rule",
      summary: describeRule(r, ctx.currency),
      status,
      ...(performance[r.id] ?? {
        triggers: 0,
        carts: 0,
        units: 0,
        lastAt: null,
      }),
    }))
    .filter((row) => !ruleId || row.id === ruleId)
    .sort((a, b) => b.triggers - a.triggers || a.title.localeCompare(b.title));
  const historyDays = HISTORY_DAYS[ctx.plan.name] ?? HISTORY_DAYS.Free;
  const requestedSpan = p.get("from")
    ? (Date.now() - Date.parse(`${p.get("from")}T00:00:00Z`)) / 86400000
    : requestedDays;

  return json({
    kpis,
    series,
    breakdowns,
    hasData: kpis.triggers.value > 0,
    ruleRows,
    shop: ctx.shop,
    // Counting needs at least one storefront block in the live theme.
    counting:
      theme.productNotice === "installed" || theme.cartGuard === "installed"
        ? "yes"
        : theme.productNotice === "unknown"
          ? "unknown"
          : "no",
    rules: ctx.rules.map((r) => ({
      id: r.id,
      title: r.title || "Untitled rule",
    })),
    plan: ctx.plan.name,
    historyDays,
    clamped: requestedSpan > historyDays + 0.5,
  });
};

// Which rules are doing something — and which haven't fired yet.
function RulePerformance({ rows, navigate, hasData }) {
  return (
    <Box
      flush
      title="Rule performance"
      subtitle={
        hasData
          ? "How often each rule stepped in during this period."
          : "Your rules are being watched — numbers appear as shoppers hit them."
      }
      actions={
        <Button variant="plain" onClick={() => navigate("/app/rules")}>
          Manage rules
        </Button>
      }
    >
      {rows.length === 0 ? (
        <div style={{ padding: "0 24px 20px" }}>
          <Text as="p" tone="subdued">
            No active rules yet.{" "}
            <Link className="cr-link-accent" to="/app/rules/new">
              Create a rule
            </Link>{" "}
            to start protecting your store.
          </Text>
        </div>
      ) : (
        <div className="cr-perf">
          <div className="cr-perf__row cr-perf__head">
            <span>Rule</span>
            <span className="cr-num">Triggers</span>
            <span className="cr-num">Carts corrected</span>
            <span className="cr-num">Units held back</span>
            <span>Last triggered</span>
            <span />
          </div>
          {rows.map((r) => (
            <div key={r.id} className="cr-perf__row">
              <div style={{ minWidth: 0 }}>
                <InlineStack gap="200" blockAlign="center">
                  <Text as="span" fontWeight="semibold">
                    {r.title}
                  </Text>
                  {r.status === "scheduled" ? (
                    <Badge tone="info">Scheduled</Badge>
                  ) : null}
                  {r.status !== "active" && r.status !== "scheduled" ? (
                    <Badge>Not active</Badge>
                  ) : null}
                </InlineStack>
                <Text as="p" tone="subdued" variant="bodySm">
                  {r.summary}
                </Text>
              </div>
              <span className="cr-num" data-label="Triggers">
                {r.triggers}
              </span>
              <span className="cr-num" data-label="Carts corrected">
                {r.carts}
              </span>
              <span className="cr-num" data-label="Units held back">
                {r.units || "—"}
              </span>
              <span className="cr-muted" data-label="Last triggered">
                {r.lastAt ? timeAgo(r.lastAt) : "Not yet"}
              </span>
              <span>
                {r.triggers ? (
                  <Button
                    size="slim"
                    variant="tertiary"
                    onClick={() =>
                      navigate(
                        `/app/activity?ruleId=${encodeURIComponent(r.id)}`,
                      )
                    }
                  >
                    View activity
                  </Button>
                ) : (
                  <Button
                    size="slim"
                    variant="tertiary"
                    onClick={() =>
                      navigate(`/app/test?ruleId=${encodeURIComponent(r.id)}`)
                    }
                  >
                    Test it
                  </Button>
                )}
              </span>
            </div>
          ))}
        </div>
      )}
    </Box>
  );
}

// Honest about what's counted, and why numbers might be zero.
function CountingNote({ counting, shop, wide }) {
  if (counting === "no") {
    return (
      <div style={wide ? undefined : { gridColumn: "1 / -1" }}>
        <Banner tone="warning" title="Nothing can be counted yet">
          <BlockStack gap="200">
            <p>
              Analytics counts what the CartRules product-page notice and cart
              guard do for shoppers. Neither is in your live theme, so your
              rules still work at checkout but nothing shows up here.
            </p>
            <InlineStack gap="200">
              <Button
                onClick={() =>
                  window.open(getThemeEditorDeepLink(shop), "_blank")
                }
              >
                Add product page notice
              </Button>
              <Button
                onClick={() =>
                  window.open(getCartThemeEditorDeepLink(shop), "_blank")
                }
              >
                Add cart guard
              </Button>
            </InlineStack>
          </BlockStack>
        </Banner>
      </div>
    );
  }
  return (
    <Box title={wide ? undefined : "What's counted"}>
      <InlineStack gap="300" blockAlign="start" wrap={false}>
        <span style={{ display: "inline-flex", flexShrink: 0 }}>
          <Icon source={InfoIcon} tone="subdued" />
        </span>
        <BlockStack gap="100">
          {wide ? (
            <Text as="p" fontWeight="semibold">
              What's counted
            </Text>
          ) : null}
          <Text as="p" tone="subdued" variant="bodySm">
            Every time your product-page notice or cart guard stops a shopper —
            before they reach checkout. Rules still block checkout on their own,
            but Shopify doesn&apos;t report those blocks back to apps, so they
            aren&apos;t counted. Rule tests are never counted.
          </Text>
        </BlockStack>
      </InlineStack>
    </Box>
  );
}

export default function Analytics() {
  const data = useLoaderData();
  const navigate = useNavigate();
  const navigation = useNavigation();
  const [searchParams, setSearchParams] = useSearchParams();

  const filters = (
    <>
      <div style={{ minWidth: 200 }}>
        <Select
          label="Rule"
          labelHidden
          options={[
            { label: "All rules", value: "" },
            ...data.rules.map((r) => ({ label: r.title, value: r.id })),
          ]}
          value={searchParams.get("ruleId") ?? ""}
          onChange={(v) => {
            const next = new URLSearchParams(searchParams);
            if (v) next.set("ruleId", v);
            else next.delete("ruleId");
            setSearchParams(next, { replace: true });
          }}
        />
      </div>
      <RangePicker
        value={rangeFromSearch(searchParams)}
        maxDays={data.historyDays}
        onChange={(range) =>
          setSearchParams(applyRange(searchParams, range), { replace: true })
        }
      />
    </>
  );

  const { kpis, breakdowns } = data;

  return (
    <AppPage
      title="Analytics"
      subtitle="How your rules are protecting your store."
      actions={filters}
    >
      {data.clamped ? (
        <Text as="p" tone="subdued">
          Your {data.plan} plan shows the last {data.historyDays} days of
          activity.{" "}
          <Link className="cr-link-accent" to="/app/billing">
            Upgrade for longer history
          </Link>
        </Text>
      ) : null}

      <div
        style={{ opacity: navigation.state === "loading" ? 0.6 : 1 }}
        className="cr-stack"
      >
        <div className="cr-grid cr-grid--kpi">
          <KpiCard
            label="Carts corrected"
            {...kpis.checkoutsProtected}
            hint="Distinct carts where a rule stepped in before checkout."
          />
          <KpiCard
            label="Units held back"
            {...kpis.unitsHeldBack}
            hint="Extra units shoppers tried to buy above a maximum quantity — stock and shipping you kept."
          />
          <KpiCard
            label="Discounts stopped"
            {...kpis.discountsBlocked}
            hint="Discounts stopped on protected products."
          />
          <KpiCard
            label="Rule triggers"
            {...kpis.triggers}
            hint="Every time a shopper hit one of your rules."
          />
        </div>

        <RulePerformance
          rows={data.ruleRows}
          navigate={navigate}
          hasData={data.hasData}
        />

        {data.hasData ? (
          <>
            <Box title="Activity over time" subtitle="Rule triggers per day">
              <ActivityChart series={data.series} label="triggers" />
            </Box>
            <div className="cr-grid cr-grid--3">
              <Box title="Most affected products">
                <BarList
                  items={breakdowns.topProducts.map((p) => ({
                    key: p.productId,
                    label: p.title ?? "Product",
                    count: p.count,
                  }))}
                  empty="No product-level events in this period"
                />
              </Box>
              <Box title="Rule type breakdown">
                <BarList
                  items={breakdowns.byType.map((t) => ({
                    key: t.ruleType,
                    label: ruleTypeLabel(t.ruleType),
                    count: t.count,
                  }))}
                />
              </Box>
              <CountingNote counting={data.counting} shop={data.shop} />
            </div>
          </>
        ) : (
          <CountingNote counting={data.counting} shop={data.shop} wide />
        )}
      </div>
    </AppPage>
  );
}
