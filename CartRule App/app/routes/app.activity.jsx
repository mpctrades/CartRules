import { useEffect, useState } from "react";
import { json } from "@remix-run/node";
import { useLoaderData, useNavigate, useNavigation, useSearchParams } from "@remix-run/react";
import { Badge, BlockStack, Button, Icon, InlineStack, Modal, Pagination, Select, Text, TextField } from "@shopify/polaris";
import { SearchIcon, ChartLineIcon } from "@shopify/polaris-icons";
import { loadAppContext } from "../models/context.server";
import { getActivityFeed, hasAnyEvent, resolveRange, HISTORY_DAYS } from "../models/events.server";
import { EVENT_LABELS, describeEvent, ruleTypeLabel } from "../models/ruleDisplay";
import { formatEventTime, SOURCE_LABELS } from "../models/eventTime";
import { AppPage, Box, EmptyBlock, RangePicker, rangeFromSearch, applyRange } from "../components/ui";

const PAGE_SIZE = 25;

// Filter labels (row titles use EVENT_LABELS so every page words events the same).
const EVENT_TYPE_OPTIONS = [
  { label: "All events", value: "" },
  { label: "Quantity blocked", value: "quantity_blocked" },
  { label: "Discount blocked", value: "discount_blocked" },
  { label: "Minimum not met", value: "minimum_not_met" },
  { label: "Quantity multiple not met", value: "multiple_not_met" },
  { label: "Minimum cart value not met", value: "minimum_cart_not_met" },
  { label: "Maximum cart value blocked", value: "maximum_cart_value_blocked" },
  { label: "Maximum cart items blocked", value: "max_items_blocked" },
  { label: "Product combination blocked", value: "combination_blocked" },
  { label: "Rule passed", value: "rule_passed" },
];

const RESULT_OPTIONS = [
  { label: "All results", value: "all" },
  { label: "Blocked", value: "blocked" },
  { label: "Passed", value: "passed" },
];

export const loader = async ({ request }) => {
  const ctx = await loadAppContext(request, { settings: false });
  const url = new URL(request.url);
  const p = url.searchParams;
  const range = resolveRange({ days: p.get("days") ?? 30, from: p.get("from"), to: p.get("to") }, ctx.plan.name);
  const eventType = EVENT_TYPE_OPTIONS.some((o) => o.value === p.get("eventType")) ? p.get("eventType") || null : null;
  const result = RESULT_OPTIONS.some((o) => o.value === p.get("result")) ? p.get("result") : "all";
  const ruleId = p.get("ruleId") || null;
  // ?source=test (from the simulator's "View in Activity") / ?source=storefront.
  const source = ["test", "storefront"].includes(p.get("source")) ? p.get("source") : null;
  const search = (p.get("q") ?? "").trim().slice(0, 100);
  const page = Math.max(1, parseInt(p.get("page") ?? "1", 10) || 1);

  const [{ events, total }, anyEvents] = await Promise.all([
    getActivityFeed(ctx.shop, {
      range,
      ruleId,
      eventType,
      result,
      search,
      source,
      limit: PAGE_SIZE,
      offset: (page - 1) * PAGE_SIZE,
    }),
    hasAnyEvent(ctx.shop),
  ]);

  return json({
    events: events.map((e) => ({ ...e, createdAt: e.createdAt.toISOString() })),
    total,
    page,
    pageCount: Math.max(1, Math.ceil(total / PAGE_SIZE)),
    anyEvents,
    rules: ctx.rules.map((r) => ({ id: r.id, title: r.title || "Untitled rule" })),
    timezone: ctx.timezone,
    currency: ctx.currency,
    historyDays: HISTORY_DAYS[ctx.plan.name] ?? HISTORY_DAYS.Free,
    plan: ctx.plan.name,
  });
};

function EventDetails({ event, timezone, currency, onClose }) {
  const navigate = useNavigate();
  if (!event) return null;
  const rows = [
    ["When", formatEventTime(event.createdAt, timezone)],
    ["Event", EVENT_LABELS[event.eventType] ?? "Rule triggered"],
    ["Rule", event.ruleTitle],
    ["Rule type", ruleTypeLabel(event.ruleType)],
    ["Product", event.productTitle],
    ["Customer attempted", event.attempted],
    ["Allowed", event.allowed],
    ["Where", event.source === "test" ? "Rule test (simulator)" : event.detail],
    ["Message", event.source === "test" ? event.detail : null],
  ].filter(([, v]) => v != null && v !== "");
  return (
    <Modal
      open
      onClose={onClose}
      title={EVENT_LABELS[event.eventType] ?? "Rule triggered"}
      primaryAction={{
        content: "View rule",
        onAction: () => navigate(`/app/rules/${encodeURIComponent(event.ruleId)}`),
      }}
      secondaryActions={[
        { content: "Test rule", onAction: () => navigate(`/app/test?ruleId=${encodeURIComponent(event.ruleId)}`) },
      ]}
    >
      <Modal.Section>
        <BlockStack gap="300">
          <InlineStack gap="200">
            <Badge tone={event.source === "test" ? "info" : undefined}>{SOURCE_LABELS[event.source] ?? event.source}</Badge>
          </InlineStack>
          <div className="cr-list">
            {rows.map(([k, v]) => (
              <div key={k} className="cr-list-row">
                <span className="cr-muted">{k}</span>
                <span style={{ textAlign: "right" }}>{String(v)}</span>
              </div>
            ))}
          </div>
          {describeEvent(event, currency) ? (
            <Text as="p" tone="subdued">
              {describeEvent(event, currency)}
            </Text>
          ) : null}
        </BlockStack>
      </Modal.Section>
    </Modal>
  );
}

export default function Activity() {
  const data = useLoaderData();
  const navigate = useNavigate();
  const navigation = useNavigation();
  const [searchParams, setSearchParams] = useSearchParams();
  const [query, setQuery] = useState(searchParams.get("q") ?? "");
  const [selected, setSelected] = useState(null);

  const update = (changes) => {
    const next = new URLSearchParams(searchParams);
    for (const [k, v] of Object.entries(changes)) {
      if (v == null || v === "" || v === "all") next.delete(k);
      else next.set(k, v);
    }
    if (!("page" in changes)) next.delete("page");
    setSearchParams(next, { replace: true });
  };

  // Debounced search into the URL.
  useEffect(() => {
    if ((searchParams.get("q") ?? "") === query) return undefined;
    const t = setTimeout(() => update({ q: query.trim() }), 400);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query]);

  const filtersActive = ["q", "ruleId", "eventType", "result", "from", "source"].some((k) => searchParams.get(k));
  const loading = navigation.state === "loading";

  return (
    <AppPage title="Activity" subtitle="See every rule CartRules has enforced.">
      {!data.anyEvents ? (
        <Box>
          <EmptyBlock
            icon={ChartLineIcon}
            title="No activity yet"
            action={
              <Button variant="primary" onClick={() => navigate("/app/test")}>
                Test a rule
              </Button>
            }
          >
            Test one of your active rules to see how CartRules records events. Shopper activity appears here once your
            storefront blocks are installed and a shopper hits a rule.
          </EmptyBlock>
        </Box>
      ) : (
        <>
          <Box>
            <div className="cr-grid" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", alignItems: "end" }}>
              <div style={{ gridColumn: "span 2", minWidth: 0 }}>
                <TextField
                  label="Search"
                  labelHidden
                  placeholder="Search activity..."
                  prefix={<Icon source={SearchIcon} />}
                  value={query}
                  onChange={setQuery}
                  clearButton
                  onClearButtonClick={() => setQuery("")}
                  autoComplete="off"
                />
              </div>
              <Select
                label="Rule"
                labelHidden
                options={[{ label: "All rules", value: "" }, ...data.rules.map((r) => ({ label: r.title, value: r.id }))]}
                value={searchParams.get("ruleId") ?? ""}
                onChange={(v) => update({ ruleId: v })}
              />
              <Select
                label="Event type"
                labelHidden
                options={EVENT_TYPE_OPTIONS}
                value={searchParams.get("eventType") ?? ""}
                onChange={(v) => update({ eventType: v })}
              />
              <Select
                label="Result"
                labelHidden
                options={RESULT_OPTIONS}
                value={searchParams.get("result") ?? "all"}
                onChange={(v) => update({ result: v })}
              />
              <div>
                <RangePicker
                  value={rangeFromSearch(searchParams)}
                  maxDays={data.historyDays}
                  onChange={(range) => {
                    const next = applyRange(searchParams, range);
                    next.delete("page");
                    setSearchParams(next, { replace: true });
                  }}
                />
              </div>
            </div>
          </Box>

          <Box flush>
            {data.events.length === 0 ? (
              <EmptyBlock
                title="No matching activity"
                action={
                  filtersActive ? (
                    <Button
                      onClick={() => {
                        setQuery("");
                        setSearchParams(new URLSearchParams(), { replace: true });
                      }}
                    >
                      Clear filters
                    </Button>
                  ) : null
                }
              >
                Nothing was recorded for these filters in the selected period.
              </EmptyBlock>
            ) : (
              <div className="cr-list" style={{ padding: "16px 24px", opacity: loading ? 0.6 : 1 }}>
                {data.events.map((e) => (
                  <div key={e.id} className="cr-list-row" style={{ alignItems: "flex-start" }}>
                    <div style={{ minWidth: 0, flex: 1 }}>
                      <div className="cr-muted">{formatEventTime(e.createdAt, data.timezone)}</div>
                      <InlineStack gap="200" blockAlign="center">
                        <Text as="span" variant="headingSm">
                          {EVENT_LABELS[e.eventType] ?? "Rule triggered"}
                        </Text>
                        {e.source === "test" ? <Badge tone="info">Test</Badge> : <Badge>Storefront</Badge>}
                      </InlineStack>
                      <div style={{ marginTop: 2 }}>{e.ruleTitle}</div>
                      {describeEvent(e, data.currency) ? (
                        <div className="cr-muted">{describeEvent(e, data.currency)}</div>
                      ) : null}
                      {e.productTitle ? <div className="cr-muted">Product: {e.productTitle}</div> : null}
                    </div>
                    <Button variant="plain" onClick={() => setSelected(e)}>
                      View details →
                    </Button>
                  </div>
                ))}
              </div>
            )}
            {data.pageCount > 1 ? (
              <div style={{ display: "flex", justifyContent: "center", padding: "0 24px 20px" }}>
                <Pagination
                  hasPrevious={data.page > 1}
                  hasNext={data.page < data.pageCount}
                  onPrevious={() => update({ page: String(data.page - 1) })}
                  onNext={() => update({ page: String(data.page + 1) })}
                  label={`Page ${data.page} of ${data.pageCount} · ${data.total} events`}
                />
              </div>
            ) : null}
          </Box>
        </>
      )}

      <Text as="p" variant="bodySm" tone="subdued">
        Activity comes from the CartRules storefront blocks (product page notice and cart guard) and from rule tests.
        Checkouts in a store where those blocks aren't installed are still protected, but aren't recorded here.{" "}
        {data.plan} plan keeps {data.historyDays} days of activity.
      </Text>

      <EventDetails event={selected} timezone={data.timezone} currency={data.currency} onClose={() => setSelected(null)} />
    </AppPage>
  );
}
