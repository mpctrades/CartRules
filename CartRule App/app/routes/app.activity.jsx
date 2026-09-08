import { useMemo, useState } from "react";
import { json } from "@remix-run/node";
import { useLoaderData, useNavigate, useSearchParams } from "@remix-run/react";
import { Page, Card, BlockStack, InlineStack, Text, Select, Box, EmptyState, TextField, Button } from "@shopify/polaris";
import { AlertTriangleIcon, CartDiscountIcon } from "@shopify/polaris-icons";
import { authenticate } from "../shopify.server";
import { getActivityFeed } from "../models/events.server";
import { listRules } from "../models/rules.server";
import { Eyebrow, IconChip } from "../components/brand";

function eventIcon(ruleType) {
  return ruleType === "max_quantity"
    ? { icon: AlertTriangleIcon, tone: "caution" }
    : { icon: CartDiscountIcon, tone: "magic" };
}

const PERIODS = [
  { label: "Last 7 days", value: "7" },
  { label: "Last 30 days", value: "30" },
  { label: "Last 90 days", value: "90" },
  { label: "All time", value: "all" },
];

const RULE_TYPE_FILTERS = [
  { label: "All activity", value: "all" },
  { label: "Quantity rules", value: "max_quantity" },
  { label: "Discount rules", value: "no_discount" },
];

// Full activity history — every rule that has actually fired, most recent
// first. See app/models/events.server.js for what's recorded and why.
export const loader = async ({ request }) => {
  const { admin, session } = await authenticate.admin(request);
  const url = new URL(request.url);
  const period = url.searchParams.get("period") ?? "30";
  const ruleType = url.searchParams.get("type") ?? "all";
  const ruleId = url.searchParams.get("rule");

  const since = period === "all" ? null : new Date(Date.now() - Number(period) * 24 * 60 * 60 * 1000);
  const events = await getActivityFeed(session.shop, {
    limit: 100,
    ruleType: ruleType === "all" ? null : ruleType,
    ruleId,
    since,
  });

  const rules = await listRules(admin);
  let ruleTitle = null;
  if (ruleId) {
    ruleTitle = rules.find((r) => r.id === ruleId)?.title ?? null;
  }

  return json({ events, period, ruleType, ruleId, ruleTitle, hasRules: rules.length > 0 });
};

function formatDateTime(iso) {
  return new Date(iso).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export default function Activity() {
  const { events, period, ruleType, ruleId, ruleTitle, hasRules } = useLoaderData();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const [query, setQuery] = useState("");

  const setParam = (key, value) => {
    searchParams.set(key, value);
    setSearchParams(searchParams);
  };

  const clearRuleFilter = () => {
    searchParams.delete("rule");
    setSearchParams(searchParams);
  };

  const filteredEvents = useMemo(() => {
    if (!query.trim()) return events;
    const q = query.trim().toLowerCase();
    return events.filter(
      (e) =>
        e.ruleTitle.toLowerCase().includes(q) ||
        (e.productTitle ?? "").toLowerCase().includes(q) ||
        (e.detail ?? "").toLowerCase().includes(q),
    );
  }, [events, query]);

  return (
    <Page title="Activity" subtitle="See every rule CartRules has enforced.">
      <BlockStack gap="400">
        <Eyebrow>Activity</Eyebrow>
        {ruleId ? (
          <InlineStack gap="200" blockAlign="center">
            <Text as="span" tone="subdued">
              Filtered to rule: <Text as="span" fontWeight="bold">{ruleTitle ?? ruleId}</Text>
            </Text>
            <Button variant="plain" onClick={clearRuleFilter}>
              Clear
            </Button>
          </InlineStack>
        ) : null}

        <Card>
          <BlockStack gap="400">
            <InlineStack gap="300" wrap={false}>
              <div style={{ flex: 1 }}>
                <TextField
                  label="Search activity"
                  labelHidden
                  placeholder="Search activity..."
                  value={query}
                  onChange={setQuery}
                  autoComplete="off"
                  clearButton
                  onClearButtonClick={() => setQuery("")}
                />
              </div>
              <div style={{ minWidth: 180 }}>
                <Select label="Date range" options={PERIODS} value={period} onChange={(v) => setParam("period", v)} />
              </div>
              <div style={{ minWidth: 180 }}>
                <Select
                  label="Event type"
                  options={RULE_TYPE_FILTERS}
                  value={ruleType}
                  onChange={(v) => setParam("type", v)}
                />
              </div>
            </InlineStack>

            {events.length === 0 ? (
              <EmptyState
                heading="No activity yet"
                action={
                  hasRules
                    ? { content: "Test a rule", onAction: () => navigate("/app/rules") }
                    : { content: "Create a rule", onAction: () => navigate("/app/rules/new") }
                }
                image="https://cdn.shopify.com/s/files/1/0757/9955/files/empty-state.svg"
              >
                <p>
                  {hasRules
                    ? "Test a rule to confirm it's configured correctly — real orders will show up here automatically."
                    : "Activity will appear here after shoppers interact with your rules."}
                </p>
              </EmptyState>
            ) : filteredEvents.length === 0 ? (
              <EmptyState heading="No activity matches your search" image="">
                <p>Try a different search term or filter.</p>
              </EmptyState>
            ) : (
              <BlockStack gap="0">
                {filteredEvents.map((event) => {
                  const { icon, tone } = eventIcon(event.ruleType);
                  return (
                    <Box key={event.id} paddingBlock="300" borderBlockEndWidth="025" borderColor="border">
                      <InlineStack align="space-between" blockAlign="start" wrap={false}>
                        <InlineStack gap="200" blockAlign="start" wrap={false}>
                          <IconChip icon={icon} tone={tone} />
                          <BlockStack gap="050">
                            <Text as="span" tone="subdued" variant="bodySm">
                              {formatDateTime(event.createdAt)} ·{" "}
                              {event.ruleType === "max_quantity" ? "Quantity blocked" : "Discount blocked"}
                            </Text>
                            <Text as="span" fontWeight="bold">
                              {event.ruleTitle}
                            </Text>
                            <Text as="span" tone="subdued">
                              {event.productTitle ? `${event.productTitle} · ` : ""}
                              {event.detail}
                            </Text>
                          </BlockStack>
                        </InlineStack>
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
