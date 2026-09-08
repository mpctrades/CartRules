import { useMemo, useState } from "react";
import { json } from "@remix-run/node";
import { useLoaderData, useNavigate, useFetcher } from "@remix-run/react";
import {
  Page,
  Card,
  IndexTable,
  Badge,
  Button,
  EmptyState,
  Banner,
  Text,
  Tabs,
  TextField,
  Select,
  Checkbox,
  Modal,
  InlineStack,
  BlockStack,
  Popover,
  ActionList,
  Icon,
} from "@shopify/polaris";
import { MenuHorizontalIcon, CheckCircleIcon, AlertTriangleIcon } from "@shopify/polaris-icons";
import { authenticate, BILLING_PLANS, FREE_PLAN_RULE_LIMIT } from "../shopify.server";
import { listRules, readRulesCache, setRuleStatus, deleteRule, duplicateRule } from "../models/rules.server";
import { getTriggerCountsByRule } from "../models/events.server";
import { RULE_TYPES, TARGET_TYPES, RULE_STATUS } from "../models/ruleConstants";
import { useActionToast } from "../utils/useActionToast";
import { Eyebrow } from "../components/brand";

// F4: "Rules list with active / paused status" — one screen to see and
// control everything, matching brief mockup Screen 1 (and the "Rules" page
// of the fuller nav spec). Split out of the dashboard so the dashboard can
// focus on KPIs/activity — see app._index.jsx.
export const loader = async ({ request }) => {
  const { admin, session, billing } = await authenticate.admin(request);
  const [rules, cache, triggerCounts, { hasActivePayment }] = await Promise.all([
    listRules(admin),
    readRulesCache(admin),
    getTriggerCountsByRule(session.shop),
    billing.check({ plans: Object.values(BILLING_PLANS), isTest: process.env.NODE_ENV !== "production" }),
  ]);
  const productCountByRuleId = new Map(cache.rules.map((r) => [r.id, r.productIds?.length ?? 0]));
  const rulesWithDetail = rules.map((r) => ({
    ...r,
    productCount: productCountByRuleId.get(r.id),
    triggerCount: triggerCounts.get(r.id) ?? 0,
  }));
  const activeCount = rules.filter((r) => r.status === RULE_STATUS.ACTIVE).length;
  return json({
    rules: rulesWithDetail,
    activeCount,
    freeLimit: FREE_PLAN_RULE_LIMIT,
    isFreePlan: !hasActivePayment,
  });
};

export const action = async ({ request }) => {
  const { admin } = await authenticate.admin(request);
  const formData = await request.formData();
  const intent = formData.get("intent");
  const id = formData.get("id");

  // title comes from the client, which already has it from the loader's
  // rules list — avoids an extra listRules() metaobjects query per action
  // just to look up a string for the toast message.
  const title = formData.get("title") || "Rule";

  if (intent === "toggle") {
    const nextStatus = formData.get("nextStatus");
    await setRuleStatus(admin, id, nextStatus);
    return json({
      ok: true,
      toast: `"${title}" ${nextStatus === RULE_STATUS.ACTIVE ? "activated" : "paused"}`,
    });
  } else if (intent === "delete") {
    await deleteRule(admin, id);
    return json({ ok: true, toast: `"${title}" deleted` });
  } else if (intent === "duplicate") {
    await duplicateRule(admin, id);
    return json({ ok: true, toast: `"${title}" duplicated as a paused copy` });
  } else if (intent === "test") {
    // Simulates the checkout Function's decision without a real order —
    // reads the exact same rules_cache the Function reads (see
    // extensions/cartrules-validation/src/index.js), so a rule that was
    // pruned there by the most-restrictive-wins fix in syncRulesCache
    // correctly reports "doesn't match" here too.
    const productId = formData.get("productId");
    const quantity = Number(formData.get("quantity")) || 0;
    const discountApplied = formData.get("discountApplied") === "true";

    const [allRules, cache] = await Promise.all([listRules(admin), readRulesCache(admin)]);
    const rule = allRules.find((r) => r.id === id);
    if (!rule) return json({ test: { error: "Rule not found." } });

    if (rule.status !== RULE_STATUS.ACTIVE) {
      return json({ test: { matched: false, reason: "This rule is paused, so it isn't enforced at checkout." } });
    }

    const cacheEntry = cache.rules.find((r) => r.id === id);
    const matches = Boolean(cacheEntry?.productIds?.includes(productId));
    if (!matches) {
      return json({
        test: {
          matched: false,
          reason:
            "This product isn't covered by this rule right now — either the target doesn't include it, or a stricter rule on the same product wins instead.",
        },
      });
    }

    if (rule.ruleType === RULE_TYPES.MAX_QUANTITY) {
      const blocked = quantity > (rule.maxQuantity ?? 0);
      return json({
        test: { matched: true, ruleType: rule.ruleType, blocked, maxAllowed: rule.maxQuantity, attempted: quantity },
      });
    }
    return json({ test: { matched: true, ruleType: rule.ruleType, blocked: discountApplied, discountApplied } });
  }
  return json({ ok: true });
};

// No fabricated "Draft"/"Scheduled" tabs — those aren't real rule states
// yet (v1 only has Active/Paused, see RULE_STATUS). Showing them with a
// hardcoded 0 would just be decoration, not real data.
const TABS = [
  { id: "all", label: "All" },
  { id: "active", label: "Active" },
  { id: "paused", label: "Paused" },
];

const TYPE_FILTERS = [
  { label: "All types", value: "all" },
  { label: "Block discount", value: RULE_TYPES.NO_DISCOUNT },
  { label: "Max quantity", value: RULE_TYPES.MAX_QUANTITY },
];

function describeTarget(rule) {
  // productCount comes from the synced cache, so it's only known for
  // ACTIVE rules (a paused rule is dropped from the cache — see
  // syncRulesCache) and only meaningful for tag/collection targets.
  const count = rule.status === RULE_STATUS.ACTIVE ? rule.productCount : undefined;
  if (rule.targetType === TARGET_TYPES.PRODUCT) return `Product: ${rule.title || rule.targetValue}`;
  const label =
    rule.targetType === TARGET_TYPES.COLLECTION
      ? `Collection: ${rule.title || rule.targetValue}`
      : `Tag: ${rule.targetValue}`;
  return count != null ? `${label} · ${count} product(s)` : label;
}

function targetNoun(rule) {
  if (rule.targetType === TARGET_TYPES.PRODUCT) return rule.title || "this product";
  if (rule.targetType === TARGET_TYPES.COLLECTION) return `the ${rule.title || rule.targetValue} collection`;
  return `${rule.targetValue}-tagged products`;
}

function describeType(rule) {
  return rule.ruleType === RULE_TYPES.NO_DISCOUNT ? "Block discount" : "Max quantity";
}

function describeSummary(rule) {
  if (rule.ruleType === RULE_TYPES.NO_DISCOUNT) return `Block discount codes on ${targetNoun(rule)}`;
  return `Limit ${rule.maxQuantity ?? "?"} per order on ${targetNoun(rule)}`;
}

function RuleActionsMenu({ rule, onEdit, onDuplicate, onViewActivity, onTest, onToggle, onDelete, busy }) {
  const [open, setOpen] = useState(false);
  return (
    <Popover
      active={open}
      onClose={() => setOpen(false)}
      activator={
        <Button
          icon={MenuHorizontalIcon}
          accessibilityLabel={`Actions for ${rule.title}`}
          variant="tertiary"
          loading={busy}
          onClick={() => setOpen((v) => !v)}
        />
      }
    >
      <ActionList
        items={[
          { content: "Edit", onAction: () => { setOpen(false); onEdit(); } },
          { content: "Duplicate", onAction: () => { setOpen(false); onDuplicate(); } },
          { content: "View activity", onAction: () => { setOpen(false); onViewActivity(); } },
          { content: "Test rule", onAction: () => { setOpen(false); onTest(); } },
          {
            content: rule.status === RULE_STATUS.ACTIVE ? "Pause" : "Activate",
            onAction: () => { setOpen(false); onToggle(); },
          },
          { content: "Delete", destructive: true, onAction: () => { setOpen(false); onDelete(); } },
        ]}
      />
    </Popover>
  );
}

// Each row owns its own fetcher instead of the table sharing one — a
// shared fetcher aborts its previous in-flight request whenever a second
// row submits before the first settles (React Router aborts by fetcher
// key), which would silently drop the first row's toast and leave its
// busy state stuck. A per-row fetcher also makes `busy` a plain derived
// value (fetcher.state !== "idle") instead of separately-tracked state
// that only got cleared on the success path.
function RuleRow({ rule, index, navigate, onOpenTest }) {
  const fetcher = useFetcher();
  const busy = fetcher.state !== "idle";
  useActionToast(fetcher);

  const submitAction = (intent, extra = {}) => {
    fetcher.submit({ intent, id: rule.id, title: rule.title || describeType(rule), ...extra }, { method: "post" });
  };

  return (
    <IndexTable.Row
      id={rule.id}
      position={index}
      onClick={() => navigate(`/app/rules/${encodeURIComponent(rule.id)}`)}
    >
      <IndexTable.Cell>
        <BlockStack gap="050">
          <Text fontWeight="bold" as="span">
            {rule.title || describeType(rule)}
          </Text>
          <Text as="span" tone="subdued" variant="bodySm">
            {describeSummary(rule)}
          </Text>
        </BlockStack>
      </IndexTable.Cell>
      <IndexTable.Cell>{describeType(rule)}</IndexTable.Cell>
      <IndexTable.Cell>{describeTarget(rule)}</IndexTable.Cell>
      <IndexTable.Cell>{rule.triggerCount}</IndexTable.Cell>
      <IndexTable.Cell>
        <Badge tone={rule.status === RULE_STATUS.ACTIVE ? "success" : undefined}>
          {rule.status === RULE_STATUS.ACTIVE ? "Active" : "Paused"}
        </Badge>
      </IndexTable.Cell>
      <IndexTable.Cell>
        <div onClick={(e) => e.stopPropagation()}>
          <RuleActionsMenu
            rule={rule}
            busy={busy}
            onEdit={() => navigate(`/app/rules/${encodeURIComponent(rule.id)}`)}
            onDuplicate={() => submitAction("duplicate")}
            onViewActivity={() => navigate(`/app/activity?rule=${encodeURIComponent(rule.id)}`)}
            onTest={() => onOpenTest(rule)}
            onToggle={() =>
              submitAction("toggle", {
                nextStatus: rule.status === RULE_STATUS.ACTIVE ? RULE_STATUS.PAUSED : RULE_STATUS.ACTIVE,
              })
            }
            onDelete={() => submitAction("delete")}
          />
        </div>
      </IndexTable.Cell>
    </IndexTable.Row>
  );
}

export default function RulesList() {
  const { rules, activeCount, freeLimit, isFreePlan } = useLoaderData();
  const navigate = useNavigate();
  const [tab, setTab] = useState(0);
  const [query, setQuery] = useState("");
  const [typeFilter, setTypeFilter] = useState("all");

  const testFetcher = useFetcher();
  const [testRule, setTestRule] = useState(null);
  const [testProduct, setTestProduct] = useState(null);
  const [testQuantity, setTestQuantity] = useState("1");
  const [testDiscountApplied, setTestDiscountApplied] = useState(false);
  const [hasRunTest, setHasRunTest] = useState(false);

  const openTest = (rule) => {
    setTestRule(rule);
    setTestProduct(
      rule.targetType === TARGET_TYPES.PRODUCT ? { id: rule.targetValue, title: rule.title || rule.targetValue } : null,
    );
    setTestQuantity(String((rule.maxQuantity ?? 1) + 1));
    setTestDiscountApplied(false);
    setHasRunTest(false);
  };

  const closeTest = () => setTestRule(null);

  const pickTestProduct = async () => {
    if (typeof window === "undefined" || !window.shopify?.resourcePicker) return;
    const selection = await window.shopify.resourcePicker({ type: "product", action: "select", multiple: false });
    const picked = selection?.[0];
    if (!picked) return;
    setTestProduct({ id: picked.id, title: picked.title ?? picked.handle ?? picked.id });
  };

  const runTest = () => {
    setHasRunTest(true);
    testFetcher.submit(
      {
        intent: "test",
        id: testRule.id,
        productId: testProduct?.id ?? "",
        quantity: testQuantity,
        discountApplied: String(testDiscountApplied),
      },
      { method: "post" },
    );
  };

  const tabCounts = useMemo(
    () => ({
      all: rules.length,
      active: rules.filter((r) => r.status === RULE_STATUS.ACTIVE).length,
      paused: rules.filter((r) => r.status === RULE_STATUS.PAUSED).length,
    }),
    [rules],
  );

  const filteredRules = useMemo(() => {
    let list = rules.filter((r) => {
      if (TABS[tab].id === "active") return r.status === RULE_STATUS.ACTIVE;
      if (TABS[tab].id === "paused") return r.status === RULE_STATUS.PAUSED;
      return true;
    });
    if (typeFilter !== "all") list = list.filter((r) => r.ruleType === typeFilter);
    if (query.trim()) {
      const q = query.trim().toLowerCase();
      list = list.filter(
        (r) =>
          (r.title ?? "").toLowerCase().includes(q) ||
          (r.targetValue ?? "").toLowerCase().includes(q) ||
          describeSummary(r).toLowerCase().includes(q),
      );
    }
    return list;
  }, [rules, tab, typeFilter, query]);

  return (
    <Page
      title="Rules"
      subtitle="Create and manage the rules protecting your store."
      primaryAction={{ content: "Create rule", onAction: () => navigate("/app/rules/new") }}
    >
      <BlockStack gap="400">
        <Eyebrow>Rules</Eyebrow>
        <Text as="p" tone="subdued">
          {rules.length} total rule{rules.length === 1 ? "" : "s"} · {activeCount} active
        </Text>

        {isFreePlan && activeCount >= freeLimit ? (
          <Banner tone="warning" title="You've reached the Free plan's active rule limit">
            <p>
              The Free plan allows {freeLimit} active rules. Pause a rule or{" "}
              <a href="/app/billing">upgrade to Growth or Pro</a> for unlimited rules.
            </p>
          </Banner>
        ) : null}

        <Card padding="0">
          <Tabs
            tabs={TABS.map((t) => ({ ...t, id: t.id, content: `${t.label} (${tabCounts[t.id]})` }))}
            selected={tab}
            onSelect={setTab}
          />
          <div style={{ padding: "0.75rem 1rem" }}>
            <InlineStack gap="300" wrap={false}>
              <div style={{ flex: 1 }}>
                <TextField
                  label="Search rules"
                  labelHidden
                  placeholder="Search rules..."
                  value={query}
                  onChange={setQuery}
                  autoComplete="off"
                  clearButton
                  onClearButtonClick={() => setQuery("")}
                />
              </div>
              <div style={{ minWidth: 180 }}>
                <Select label="Type" labelHidden options={TYPE_FILTERS} value={typeFilter} onChange={setTypeFilter} />
              </div>
            </InlineStack>
          </div>

          {rules.length === 0 ? (
            <EmptyState
              heading="No rules yet"
              action={{ content: "Create your first rule", onAction: () => navigate("/app/rules/new") }}
              image="https://cdn.shopify.com/s/files/1/0757/9955/files/empty-state.svg"
            >
              <p>Create your first CartRule to start controlling your cart.</p>
            </EmptyState>
          ) : filteredRules.length === 0 ? (
            <EmptyState heading="No rules match" image="">
              <p>Try a different tab, type, or search term.</p>
            </EmptyState>
          ) : (
            <IndexTable
              resourceName={{ singular: "rule", plural: "rules" }}
              itemCount={filteredRules.length}
              headings={[
                { title: "Rule" },
                { title: "Type" },
                { title: "Scope" },
                { title: "Activity" },
                { title: "Status" },
                { title: "" },
              ]}
              selectable={false}
            >
              {filteredRules.map((rule, index) => (
                <RuleRow key={rule.id} rule={rule} index={index} navigate={navigate} onOpenTest={openTest} />
              ))}
            </IndexTable>
          )}
        </Card>
      </BlockStack>

      {testRule ? (
        <Modal
          open
          onClose={closeTest}
          title={`Test ${testRule.title || (testRule.ruleType === RULE_TYPES.MAX_QUANTITY ? "Maximum quantity" : "Block discounts")}`}
          primaryAction={{
            content: "Run test",
            onAction: runTest,
            loading: testFetcher.state !== "idle",
            disabled: !testProduct,
          }}
          secondaryActions={[{ content: "Close", onAction: closeTest }]}
        >
          <Modal.Section>
            <BlockStack gap="300">
              <InlineStack gap="200" blockAlign="center">
                <Button onClick={pickTestProduct}>{testProduct ? "Change product" : "Choose a product"}</Button>
                {testProduct ? <Text as="span">{testProduct.title}</Text> : null}
              </InlineStack>
              {testRule.ruleType === RULE_TYPES.MAX_QUANTITY ? (
                <TextField
                  label="Quantity"
                  type="number"
                  min={0}
                  value={testQuantity}
                  onChange={setTestQuantity}
                  autoComplete="off"
                  helpText={`This rule allows a maximum of ${testRule.maxQuantity ?? "?"} per order.`}
                />
              ) : (
                <Checkbox
                  label="A discount code is applied to this item"
                  checked={testDiscountApplied}
                  onChange={setTestDiscountApplied}
                />
              )}

              {hasRunTest && testFetcher.data?.test ? (
                <Banner
                  tone={
                    testFetcher.data.test.error
                      ? "critical"
                      : !testFetcher.data.test.matched
                        ? "warning"
                        : testFetcher.data.test.blocked
                          ? "success"
                          : "info"
                  }
                >
                  {testFetcher.data.test.error ? (
                    <Text as="p">{testFetcher.data.test.error}</Text>
                  ) : !testFetcher.data.test.matched ? (
                    <InlineStack gap="150" blockAlign="center">
                      <Icon source={AlertTriangleIcon} />
                      <Text as="p">{testFetcher.data.test.reason}</Text>
                    </InlineStack>
                  ) : (
                    <BlockStack gap="150">
                      <InlineStack gap="150" blockAlign="center">
                        <Icon source={CheckCircleIcon} />
                        <Text as="p" fontWeight="bold">
                          Rule matched — {testFetcher.data.test.blocked ? "would be blocked" : "would be allowed"}
                        </Text>
                      </InlineStack>
                      {testFetcher.data.test.ruleType === RULE_TYPES.MAX_QUANTITY ? (
                        <Text as="p">
                          Maximum allowed: {testFetcher.data.test.maxAllowed} · Attempted: {testFetcher.data.test.attempted}
                        </Text>
                      ) : (
                        <Text as="p">
                          Discount code applied: {testFetcher.data.test.discountApplied ? "Yes" : "No"}
                        </Text>
                      )}
                    </BlockStack>
                  )}
                </Banner>
              ) : null}
            </BlockStack>
          </Modal.Section>
        </Modal>
      ) : null}
    </Page>
  );
}
