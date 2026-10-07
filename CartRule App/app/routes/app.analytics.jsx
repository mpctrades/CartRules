import { json } from "@remix-run/node";
import { Link, useLoaderData, useNavigate, useNavigation, useSearchParams } from "@remix-run/react";
import { Button, Select, Text } from "@shopify/polaris";
import { ChartVerticalIcon } from "@shopify/polaris-icons";
import { loadAppContext } from "../models/context.server";
import { getKpis, getActivitySeries, getBreakdowns, resolveRange, HISTORY_DAYS } from "../models/events.server";
import { ruleTypeLabel } from "../models/ruleDisplay";
import {
  AppPage,
  Box,
  KpiCard,
  ActivityChart,
  BarList,
  EmptyBlock,
  RangePicker,
  rangeFromSearch,
  applyRange,
} from "../components/ui";

// Analytics counts live (storefront) events only — rule tests never count.
export const loader = async ({ request }) => {
  const ctx = await loadAppContext(request, { settings: false });
  const p = new URL(request.url).searchParams;
  const requestedDays = Number(p.get("days") ?? 30) || 30;
  const range = resolveRange({ days: requestedDays, from: p.get("from"), to: p.get("to") }, ctx.plan.name);
  const ruleId = ctx.rules.some((r) => r.id === p.get("ruleId")) ? p.get("ruleId") : null;
  const ruleIds = ruleId ? [ruleId] : null;

  const [kpis, series, breakdowns] = await Promise.all([
    getKpis(ctx.shop, range, { ruleIds }),
    getActivitySeries(ctx.shop, range, { ruleIds }),
    getBreakdowns(ctx.shop, range, { ruleIds }),
  ]);
  const historyDays = HISTORY_DAYS[ctx.plan.name] ?? HISTORY_DAYS.Free;
  const requestedSpan = p.get("from")
    ? (Date.now() - Date.parse(`${p.get("from")}T00:00:00Z`)) / 86400000
    : requestedDays;

  return json({
    kpis,
    series,
    breakdowns,
    hasData: kpis.triggers.value > 0,
    rules: ctx.rules.map((r) => ({ id: r.id, title: r.title || "Untitled rule" })),
    plan: ctx.plan.name,
    historyDays,
    clamped: requestedSpan > historyDays + 0.5,
  });
};

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
          options={[{ label: "All rules", value: "" }, ...data.rules.map((r) => ({ label: r.title, value: r.id }))]}
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
        onChange={(range) => setSearchParams(applyRange(searchParams, range), { replace: true })}
      />
    </>
  );

  const { kpis, breakdowns } = data;

  return (
    <AppPage title="Analytics" subtitle="How your rules are protecting your store." actions={filters}>
      {data.clamped ? (
        <Text as="p" tone="subdued">
          Your {data.plan} plan shows the last {data.historyDays} days of activity.{" "}
          <Link className="cr-link-accent" to="/app/billing">
            Upgrade for longer history
          </Link>
        </Text>
      ) : null}

      <div style={{ opacity: navigation.state === "loading" ? 0.6 : 1 }} className="cr-stack">
        <div className="cr-grid cr-grid--kpi">
          <KpiCard label="Rule triggers" {...kpis.triggers} hint="Times a shopper hit one of your rules." />
          <KpiCard label="Discounts blocked" {...kpis.discountsBlocked} hint="Discount codes stopped on protected items." />
          <KpiCard
            label="Quantity violations"
            {...kpis.quantityViolations}
            hint="Quantities above a maximum, below a minimum, or not in the required multiple."
          />
          <KpiCard
            label="Protected checkouts"
            {...kpis.checkoutsProtected}
            hint="Distinct carts where a rule stepped in before checkout."
          />
        </div>

        {!data.hasData ? (
          <Box>
            <EmptyBlock
              icon={ChartVerticalIcon}
              title="Not enough data yet"
              action={<Button onClick={() => navigate("/app/test")}>Test a rule</Button>}
            >
              Analytics will appear after your active rules start receiving traffic. Counts come from the CartRules
              storefront blocks; rule tests aren&apos;t counted.
            </EmptyBlock>
          </Box>
        ) : (
          <>
            <Box title="Activity over time" subtitle="Rule triggers per day">
              <ActivityChart series={data.series} label="triggers" />
            </Box>
            <div className="cr-grid cr-grid--3">
              <Box title="Most triggered rules">
                <BarList
                  items={breakdowns.topRules.map((r) => ({ key: r.ruleId, label: r.title, count: r.count }))}
                />
              </Box>
              <Box title="Most affected products">
                <BarList
                  items={breakdowns.topProducts.map((p) => ({ key: p.productId, label: p.title ?? "Product", count: p.count }))}
                  empty="No product-level events in this period"
                />
              </Box>
              <Box title="Rule type breakdown">
                <BarList
                  items={breakdowns.byType.map((t) => ({ key: t.ruleType, label: ruleTypeLabel(t.ruleType), count: t.count }))}
                />
              </Box>
            </div>
          </>
        )}
      </div>
    </AppPage>
  );
}
