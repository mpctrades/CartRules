import { useMemo, useState } from "react";
import { json } from "@remix-run/node";
import { useFetcher, useLoaderData, useNavigate, useSearchParams } from "@remix-run/react";
import {
  ActionList,
  Banner,
  BlockStack,
  Button,
  Checkbox,
  Icon,
  IndexTable,
  InlineStack,
  Modal,
  Popover,
  Select,
  Tabs,
  Text,
  TextField,
} from "@shopify/polaris";
import { FilterIcon, MenuHorizontalIcon, PlusIcon, SearchIcon, ShieldCheckMarkIcon } from "@shopify/polaris-icons";
import { loadAppContext } from "../models/context.server";
import {
  deleteRule,
  duplicateRule,
  ensureValidationActive,
  getCheckoutEnforcement,
  getRule,
  readRulesCache,
  setRuleStatus,
  syncRulesCache,
  FUNCTION_METAFIELD_MAX_BYTES,
} from "../models/rules.server";
import { getRulesHealth } from "../models/health.server";
import { getTriggerCountsByRule } from "../models/events.server";
import { getTargetProductCounts } from "../models/targetCounts.server";
import { activeRuleRoom, lockedFeatures } from "../models/plan.server";
import { FREE_PLAN_RULE_LIMIT } from "../shopify.server";
import {
  RULE_TYPE_INFO,
  RULE_TYPE_ORDER,
  RULE_STATUS,
  TARGET_INFO,
  TARGET_TYPES,
  CUSTOMER_TYPES,
  DISPLAY_STATUS,
  DISPLAY_STATUS_INFO,
} from "../models/ruleConstants";
import { describeRule, describeTarget, getDisplayStatus } from "../models/ruleDisplay";
import { useActionToast } from "../utils/useActionToast";
import { useFlashToast } from "../utils/useFlashToast";
import { AppPage, Box, EmptyBlock, StatusBadge, formatNumber } from "../components/ui";

export const loader = async ({ request }) => {
  const ctx = await loadAppContext(request);
  const { admin, shop, rules, plan, settings } = ctx;
  const liveCount = rules.filter((r) => r.status === RULE_STATUS.ACTIVE).length;
  const [healthResult, cache, triggerCounts, productCounts, checkoutEnforcing] = await Promise.all([
    getRulesHealth(admin, shop, rules, { plan: plan.name, conflictMode: settings.conflictMode }),
    readRulesCache(admin),
    getTriggerCountsByRule(shop, plan.name),
    getTargetProductCounts(admin, rules),
    getCheckoutEnforcement(admin, liveCount),
  ]);
  return json({
    rules,
    health: healthResult.health,
    conflicts: healthResult.conflicts,
    triggerCounts,
    productCounts,
    plan: plan.name,
    freeLimit: FREE_PLAN_RULE_LIMIT,
    activeCount: liveCount,
    currency: ctx.currency,
    checkoutEnforcing,
    protectionEnabled: settings.protectionEnabled,
    conflictMode: settings.conflictMode,
    cacheTooLarge: cache.bytes > FUNCTION_METAFIELD_MAX_BYTES,
  });
};

// Admin API failures become error toasts instead of the error page;
// thrown Responses (auth redirects) pass through.
export const action = async (args) => {
  try {
    return await handleAction(args);
  } catch (error) {
    if (error instanceof Response) throw error;
    console.error("Rules action failed", error);
    return json({ ok: false, toast: "Something went wrong. Please try again.", toastError: true });
  }
};

async function handleAction({ request }) {
  const ctx = await loadAppContext(request, { settings: false });
  const { admin, rules, plan } = ctx;
  const formData = await request.formData();
  const intent = formData.get("intent");
  const id = formData.get("id");

  if (intent === "enableValidation") {
    await ensureValidationActive(admin);
    await syncRulesCache(admin, { activateValidation: false });
    return json({ ok: true, toast: "CartRules is now enforced at checkout" });
  }

  const rule = id ? rules.find((r) => r.id === id) ?? (await getRule(admin, id)) : null;
  if (!rule) return json({ ok: false, toast: "This rule no longer exists.", toastError: true });
  const title = rule.title || "Rule";

  if (intent === "activate") {
    const locked = lockedFeatures(rule, plan.name);
    if (locked.length) {
      const needs = locked.some((f) => f.plan === "Pro") ? "Pro" : "Growth";
      return json({
        ok: false,
        toast: `"${title}" uses ${locked.map((f) => f.label.toLowerCase()).join(", ")} — upgrade to ${needs} to activate it.`,
        toastError: true,
      });
    }
    const activeCount = rules.filter((r) => r.status === RULE_STATUS.ACTIVE).length;
    if (activeRuleRoom(plan.name, activeCount) <= 0) {
      return json({
        ok: false,
        toast: `Free plan allows ${FREE_PLAN_RULE_LIMIT} active rules — upgrade in Plan & billing to activate "${title}".`,
        toastError: true,
      });
    }
    await setRuleStatus(admin, rule.id, RULE_STATUS.ACTIVE);
    return json({ ok: true, toast: `"${title}" activated` });
  }
  if (intent === "pause") {
    await setRuleStatus(admin, rule.id, RULE_STATUS.PAUSED);
    return json({ ok: true, toast: `"${title}" paused` });
  }
  if (intent === "delete") {
    await deleteRule(admin, rule.id);
    return json({ ok: true, toast: `"${title}" deleted` });
  }
  if (intent === "duplicate") {
    await duplicateRule(admin, rule.id);
    return json({ ok: true, toast: `"${title}" duplicated as a paused copy` });
  }
  return json({ ok: false }, { status: 400 });
}

const TABS = [
  { id: "all", label: "All" },
  { id: DISPLAY_STATUS.ACTIVE, label: "Active" },
  { id: DISPLAY_STATUS.DRAFT, label: "Draft" },
  { id: DISPLAY_STATUS.SCHEDULED, label: "Scheduled" },
  { id: DISPLAY_STATUS.PAUSED, label: "Paused" },
  { id: DISPLAY_STATUS.NEEDS_ATTENTION, label: "Needs attention" },
];

// Ended (schedule over) rules aren't live, so they sit with Paused.
const tabOf = (status) => (status === DISPLAY_STATUS.ENDED ? DISPLAY_STATUS.PAUSED : status);

function RowActions({ rule, live, onDelete }) {
  const [open, setOpen] = useState(false);
  const navigate = useNavigate();
  const fetcher = useFetcher();
  useActionToast(fetcher);
  const enc = encodeURIComponent(rule.id);
  const submit = (intent) => {
    setOpen(false);
    fetcher.submit({ intent, id: rule.id }, { method: "post" });
  };
  const isActive = rule.status === RULE_STATUS.ACTIVE;
  return (
    <Popover
      active={open}
      onClose={() => setOpen(false)}
      preferredAlignment="right"
      activator={
        <Button
          variant="tertiary"
          icon={MenuHorizontalIcon}
          accessibilityLabel={`Actions for ${rule.title}`}
          loading={fetcher.state !== "idle"}
          onClick={() => setOpen((o) => !o)}
        />
      }
    >
      <ActionList
        actionRole="menuitem"
        sections={[
          {
            items: [
              { content: "Edit", onAction: () => navigate(`/app/rules/${enc}`) },
              { content: "Duplicate", onAction: () => submit("duplicate") },
              { content: "Test rule", onAction: () => navigate(`/app/test?ruleId=${enc}`) },
              { content: "View activity", onAction: () => navigate(`/app/activity?ruleId=${enc}`) },
              isActive
                ? { content: live === DISPLAY_STATUS.SCHEDULED ? "Pause (cancel schedule)" : "Pause", onAction: () => submit("pause") }
                : { content: "Activate", onAction: () => submit("activate") },
            ],
          },
          {
            items: [
              {
                content: "Delete",
                destructive: true,
                onAction: () => {
                  setOpen(false);
                  onDelete(rule);
                },
              },
            ],
          },
        ]}
      />
    </Popover>
  );
}

export default function RulesPage() {
  const {
    rules,
    health,
    conflicts,
    triggerCounts,
    productCounts,
    plan,
    freeLimit,
    activeCount,
    currency,
    checkoutEnforcing,
    protectionEnabled,
    conflictMode,
    cacheTooLarge,
  } = useLoaderData();
  useFlashToast();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const fetcher = useFetcher();
  useActionToast(fetcher);

  const tab = TABS.some((t) => t.id === searchParams.get("tab")) ? searchParams.get("tab") : "all";
  const [query, setQuery] = useState("");
  const [type, setType] = useState("all");
  const [status, setStatus] = useState("all");
  const [scope, setScope] = useState("all");
  const [moreOpen, setMoreOpen] = useState(false);
  const [customerOnly, setCustomerOnly] = useState(false);
  const [scheduledOnly, setScheduledOnly] = useState(false);
  const [toDelete, setToDelete] = useState(null);

  const withStatus = useMemo(
    () => rules.map((r) => ({ ...r, display: getDisplayStatus(r, health[r.id]), issues: health[r.id]?.issues ?? [] })),
    [rules, health],
  );
  const counts = useMemo(() => {
    const c = Object.fromEntries(TABS.map((t) => [t.id, 0]));
    c.all = withStatus.length;
    for (const r of withStatus) c[tabOf(r.display)] = (c[tabOf(r.display)] ?? 0) + 1;
    return c;
  }, [withStatus]);

  const filtered = withStatus.filter((r) => {
    if (tab !== "all" && tabOf(r.display) !== tab) return false;
    if (type !== "all" && r.ruleType !== type) return false;
    if (status !== "all" && r.display !== status) return false;
    if (scope !== "all" && (r.target?.type ?? TARGET_TYPES.ALL) !== scope) return false;
    if (customerOnly && (!r.customer || r.customer.type === CUSTOMER_TYPES.EVERYONE)) return false;
    if (scheduledOnly && !(r.schedule?.startsAt || r.schedule?.endsAt)) return false;
    if (query.trim()) {
      const q = query.trim().toLowerCase();
      const hay = `${r.title} ${describeRule(r, currency)} ${describeTarget(r.target)}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
  const filtersActive = query || type !== "all" || status !== "all" || scope !== "all" || customerOnly || scheduledOnly;
  const clearFilters = () => {
    setQuery("");
    setType("all");
    setStatus("all");
    setScope("all");
    setCustomerOnly(false);
    setScheduledOnly(false);
  };

  const createButton = (
    <Button variant="primary" icon={PlusIcon} onClick={() => navigate("/app/rules/new")}>
      Create rule
    </Button>
  );

  const scopeText = (r) => {
    const base = describeTarget(r.target);
    const n = productCounts[r.id];
    return n == null || r.target?.type === TARGET_TYPES.PRODUCT ? base : `${base} · ${formatNumber(n)} ${n === 1 ? "product" : "products"}`;
  };

  const rows = filtered.map((r, index) => (
    <IndexTable.Row id={r.id} key={r.id} position={index}>
      <IndexTable.Cell>
        <div style={{ maxWidth: 360, whiteSpace: "normal", padding: "4px 0" }}>
          <BlockStack gap="100">
            <Text as="span" fontWeight="semibold">
              {r.title || "Untitled rule"}
            </Text>
            <Text as="span" tone="subdued" variant="bodySm">
              {describeRule(r, currency)}
            </Text>
            {r.display === DISPLAY_STATUS.NEEDS_ATTENTION ? (
              <InlineStack gap="200" blockAlign="center" wrap>
                <Text as="span" tone="caution" variant="bodySm">
                  ⚠ {r.issues.map((i) => i.message).join(" · ")}
                </Text>
                <Button size="slim" onClick={() => navigate(`/app/rules/${encodeURIComponent(r.id)}`)}>
                  Fix rule
                </Button>
              </InlineStack>
            ) : null}
          </BlockStack>
        </div>
      </IndexTable.Cell>
      <IndexTable.Cell>{RULE_TYPE_INFO[r.ruleType]?.short ?? r.ruleType}</IndexTable.Cell>
      <IndexTable.Cell>
        <div style={{ maxWidth: 240, whiteSpace: "normal" }}>{scopeText(r)}</div>
      </IndexTable.Cell>
      <IndexTable.Cell>
        <Text as="span" numeric>
          {formatNumber(triggerCounts[r.id] ?? 0)}
        </Text>
      </IndexTable.Cell>
      <IndexTable.Cell>
        <StatusBadge status={r.display} />
      </IndexTable.Cell>
      <IndexTable.Cell>
        <div style={{ display: "flex", justifyContent: "flex-end" }}>
          <RowActions rule={r} live={r.display} onDelete={setToDelete} />
        </div>
      </IndexTable.Cell>
    </IndexTable.Row>
  ));

  return (
    <AppPage
      title="Rules"
      subtitle={
        <>
          Create and manage the rules protecting your store.
          <br />
          <Text as="span" tone="subdued">
            {rules.length} total {rules.length === 1 ? "rule" : "rules"} · {activeCount} active
            {plan === "Free" ? ` (Free plan: up to ${freeLimit})` : ""}
          </Text>
        </>
      }
      actions={rules.length ? createButton : null}
    >
      {checkoutEnforcing === false ? (
        <Banner
          tone="critical"
          title="CartRules is turned off at checkout"
          action={{
            content: "Turn on at checkout",
            loading: fetcher.state !== "idle",
            onAction: () => fetcher.submit({ intent: "enableValidation" }, { method: "post" }),
          }}
        >
          Shopify isn&apos;t running CartRules&apos; checkout rule (Settings → Checkout → Checkout rules), so no rule
          is enforced at checkout right now.
        </Banner>
      ) : null}
      {!protectionEnabled ? (
        <Banner tone="warning" title="CartRules protection is off" action={{ content: "Open Settings", url: "/app/settings" }}>
          All rules are paused store-wide until you turn protection back on.
        </Banner>
      ) : null}
      {cacheTooLarge ? (
        <Banner tone="critical" title="Your rules are too large for checkout">
          Shopify only lets checkout read 10 KB of rule data, so checkout enforces none of your rules right now. Target
          tags or collections instead of long product lists, or remove rules you no longer need.
        </Banner>
      ) : null}
      {conflicts.length ? (
        <Banner
          tone="warning"
          title={conflicts.length === 1 ? "Two rules overlap" : `${conflicts.length} rule overlaps`}
          action={{ content: "Change rule behavior", url: "/app/settings" }}
        >
          <BlockStack gap="100">
            {conflicts.slice(0, 5).map((c) => (
              <Text as="p" key={c.ruleIds.join("|")}>
                {c.message}
              </Text>
            ))}
            <Text as="p" tone="subdued">
              {conflictMode === "priority" ? "Highest priority wins" : "Most restrictive wins"} — change this in
              Settings → Rule behavior.
            </Text>
          </BlockStack>
        </Banner>
      ) : null}

      {rules.length === 0 ? (
        <Box>
          <EmptyBlock
            icon={ShieldCheckMarkIcon}
            title="No rules yet"
            action={
              <InlineStack gap="200" align="center">
                {createButton}
                <Button url="/app/templates">Browse templates</Button>
              </InlineStack>
            }
          >
            Create your first rule to start protecting your store.
          </EmptyBlock>
        </Box>
      ) : (
        <Box flush>
          <Tabs
            tabs={TABS.map((t) => ({
              id: t.id,
              content: `${t.label}${counts[t.id] ? ` (${counts[t.id]})` : ""}`,
              accessibilityLabel: t.label,
              panelID: `rules-${t.id}`,
            }))}
            selected={TABS.findIndex((t) => t.id === tab)}
            onSelect={(i) => {
              const next = new URLSearchParams(searchParams);
              if (TABS[i].id === "all") next.delete("tab");
              else next.set("tab", TABS[i].id);
              setSearchParams(next, { replace: true, preventScrollReset: true });
            }}
          />
          <div style={{ padding: "12px 16px", borderBottom: "1px solid var(--p-color-border-secondary)" }}>
            <div style={{ display: "grid", gap: 8, gridTemplateColumns: "repeat(auto-fit, minmax(170px, 1fr))", alignItems: "center" }}>
              <TextField
                label="Search rules"
                labelHidden
                prefix={<Icon source={SearchIcon} tone="subdued" />}
                placeholder="Search rules..."
                value={query}
                onChange={setQuery}
                clearButton
                onClearButtonClick={() => setQuery("")}
                autoComplete="off"
              />
              <Select
                label="Rule type"
                labelHidden
                value={type}
                onChange={setType}
                options={[{ label: "Rule type: All", value: "all" }, ...RULE_TYPE_ORDER.map((t) => ({ label: RULE_TYPE_INFO[t].title, value: t }))]}
              />
              <Select
                label="Status"
                labelHidden
                value={status}
                onChange={setStatus}
                options={[
                  { label: "Status: All", value: "all" },
                  ...Object.entries(DISPLAY_STATUS_INFO).map(([value, info]) => ({ label: info.label, value })),
                ]}
              />
              <Select
                label="Scope"
                labelHidden
                value={scope}
                onChange={setScope}
                options={[{ label: "Scope: All", value: "all" }, ...Object.entries(TARGET_INFO).map(([value, info]) => ({ label: info.label, value }))]}
              />
              <Popover
                active={moreOpen}
                onClose={() => setMoreOpen(false)}
                preferredAlignment="right"
                activator={
                  <Button icon={FilterIcon} disclosure onClick={() => setMoreOpen((o) => !o)}>
                    More filters
                  </Button>
                }
              >
                <div style={{ padding: 16, minWidth: 240 }}>
                  <BlockStack gap="200">
                    <Checkbox label="Has customer conditions" checked={customerOnly} onChange={setCustomerOnly} />
                    <Checkbox label="Scheduled rules only" checked={scheduledOnly} onChange={setScheduledOnly} />
                    {filtersActive ? (
                      <Button variant="plain" onClick={clearFilters}>
                        Clear all filters
                      </Button>
                    ) : null}
                  </BlockStack>
                </div>
              </Popover>
            </div>
          </div>
          {filtered.length === 0 ? (
            <EmptyBlock
              title="No rules match"
              action={filtersActive ? <Button onClick={clearFilters}>Clear filters</Button> : null}
            >
              {filtersActive ? "Try a different search or filter." : "There are no rules in this tab."}
            </EmptyBlock>
          ) : (
            <IndexTable
              resourceName={{ singular: "rule", plural: "rules" }}
              itemCount={filtered.length}
              selectable={false}
              headings={[
                { title: "Rule" },
                { title: "Type" },
                { title: "Scope" },
                { title: "Activity", alignment: "end", tooltipContent: "Shopper rule triggers in your plan's history window" },
                { title: "Status" },
                { title: "Actions", alignment: "end", hidden: false },
              ]}
            >
              {rows}
            </IndexTable>
          )}
        </Box>
      )}

      <Modal
        open={Boolean(toDelete)}
        onClose={() => setToDelete(null)}
        title={`Delete "${toDelete?.title || "this rule"}"?`}
        primaryAction={{
          content: "Delete rule",
          destructive: true,
          loading: fetcher.state !== "idle",
          onAction: () => {
            fetcher.submit({ intent: "delete", id: toDelete.id }, { method: "post" });
            setToDelete(null);
          },
        }}
        secondaryActions={[{ content: "Cancel", onAction: () => setToDelete(null) }]}
      >
        <Modal.Section>
          <Text as="p">
            Checkout stops enforcing this rule immediately. Its activity history stays in Activity. This can&apos;t be
            undone.
          </Text>
        </Modal.Section>
      </Modal>
    </AppPage>
  );
}

