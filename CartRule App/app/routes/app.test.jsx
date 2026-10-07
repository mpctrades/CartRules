import { useState } from "react";
import { json } from "@remix-run/node";
import { useFetcher, useLoaderData, useNavigate, useSearchParams } from "@remix-run/react";
import {
  Banner,
  BlockStack,
  Button,
  Icon,
  InlineGrid,
  InlineStack,
  Select,
  Tag,
  Text,
  TextField,
} from "@shopify/polaris";
import { ArrowLeftIcon, CheckCircleIcon, XCircleIcon, PlusIcon } from "@shopify/polaris-icons";
import { loadAppContext } from "../models/context.server";
import { runSimulation } from "../models/simulator.server";
import { RULE_TYPE_INFO } from "../models/ruleConstants";
import { describeRule, getScheduleStatus, formatMoney } from "../models/ruleDisplay";
import { AppPage, Box, StatusBadge } from "../components/ui";
import { COUNTRY_CODES, countryName } from "../components/countries";

export const loader = async ({ request }) => {
  const ctx = await loadAppContext(request, { settings: false });
  return json({
    rules: ctx.rules.map((r) => ({
      id: r.id,
      title: r.title,
      ruleType: r.ruleType,
      status: getScheduleStatus(r),
      summary: describeRule(r, ctx.currency),
    })),
    currency: ctx.currency,
  });
};

export const action = async ({ request }) => {
  const ctx = await loadAppContext(request, { rules: false, settings: false });
  const formData = await request.formData();
  let input;
  try {
    input = JSON.parse(formData.get("input") ?? "{}");
  } catch (_e) {
    return json({ error: "The test couldn't be read. Please try again." }, { status: 400 });
  }
  try {
    const result = await runSimulation(ctx.admin, ctx.shop, { ...input, currency: ctx.currency });
    return json(result);
  } catch (error) {
    if (error instanceof Response) throw error;
    console.error("Rule simulation failed", error);
    return json({ error: "The test couldn't run. Please try again." });
  }
};

/** Product (+ variant) chooser for one simulated cart line. */
function LineInput({ label, line, onChange, onRemove }) {
  const pick = async () => {
    if (typeof window === "undefined" || !window.shopify?.resourcePicker) return;
    const selection = await window.shopify.resourcePicker({ type: "product", action: "select", multiple: false });
    const product = selection?.[0];
    if (!product) return;
    const variants = (product.variants ?? []).filter((v) => v?.id).map((v) => ({ id: v.id, title: v.title }));
    onChange({ ...line, productTitle: product.title, variants, variantId: variants[0]?.id ?? null });
  };
  return (
    <BlockStack gap="200">
      <InlineStack align="space-between" blockAlign="center">
        <Text as="h3" variant="headingSm">
          {label}
        </Text>
        {onRemove ? (
          <Button variant="plain" tone="critical" onClick={onRemove}>
            Remove
          </Button>
        ) : null}
      </InlineStack>
      <InlineGrid columns={{ xs: 1, sm: "2fr 1fr" }} gap="300">
        <BlockStack gap="200">
          <InlineStack gap="200" blockAlign="center">
            <Button onClick={pick}>{line.productTitle ? "Change product" : "Choose product"}</Button>
            {line.productTitle ? <Tag>{line.productTitle}</Tag> : null}
          </InlineStack>
          {line.variants?.length > 1 ? (
            <Select
              label="Variant"
              options={line.variants.map((v) => ({ value: v.id, label: v.title }))}
              value={line.variantId ?? ""}
              onChange={(variantId) => onChange({ ...line, variantId })}
            />
          ) : null}
        </BlockStack>
        <TextField
          label="Quantity"
          type="number"
          min={1}
          value={line.quantity}
          onChange={(quantity) => onChange({ ...line, quantity })}
          autoComplete="off"
        />
      </InlineGrid>
    </BlockStack>
  );
}

function Fact({ label, children }) {
  return (
    <div className="cr-list-row">
      <span className="cr-muted">{label}</span>
      <span style={{ fontWeight: 550, textAlign: "right" }}>{children}</span>
    </div>
  );
}

function Result({ result, currency, ruleChosen }) {
  const navigate = useNavigate();
  if (result.error) return <Banner tone="critical">{result.error}</Banner>;
  const v = result.violations[0];
  const money = v && RULE_TYPE_INFO[v.type]?.money;
  const fmt = (n) => (money ? formatMoney(n, currency) : n);
  return (
    <Box
      title={
        <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
          <span style={{ color: result.triggered ? "var(--p-color-text-critical)" : "var(--p-color-text-success)" }}>
            <Icon source={result.triggered ? XCircleIcon : CheckCircleIcon} tone={result.triggered ? "critical" : "success"} />
          </span>
          <span>
            {result.triggered
              ? ruleChosen
                ? "Rule triggered"
                : `${result.violations.length} ${result.violations.length === 1 ? "rule" : "rules"} triggered`
              : result.matched || !ruleChosen
                ? "Rule not triggered"
                : "Rule doesn't apply to this cart"}
          </span>
        </span>
      }
      actions={
        <Button variant="plain" onClick={() => navigate("/app/activity?source=test")}>
          View in Activity
        </Button>
      }
    >
      <BlockStack gap="400">
        <div className="cr-list">
          {result.violations.map((viol, i) => (
            <div key={i} className="cr-list" style={{ marginBottom: 4 }}>
              {!ruleChosen ? <Fact label="Rule">{viol.ruleTitle}</Fact> : null}
              {viol.productTitle ? <Fact label="Product">{viol.productTitle}</Fact> : null}
              {viol.attempted != null ? (
                <Fact label={RULE_TYPE_INFO[viol.type]?.money ? "Cart amount" : "Attempted quantity"}>{fmt(viol.attempted)}</Fact>
              ) : null}
              {viol.allowed != null ? (
                <Fact label={viol.type === "min_quantity" || viol.type === "cart_min_value" ? "Minimum required" : viol.type === "quantity_multiple" ? "Must be a multiple of" : "Maximum allowed"}>
                  {fmt(viol.allowed)}
                </Fact>
              ) : null}
            </div>
          ))}
          <Fact label="Result">
            <span style={{ color: result.blocked ? "var(--p-color-text-critical)" : "var(--p-color-text-success)" }}>
              {result.blocked ? "Checkout blocked" : "Checkout allowed"}
            </span>
          </Fact>
        </div>
        {result.violations.length ? (
          <BlockStack gap="150">
            <Text as="h3" variant="headingSm">
              Customer message
            </Text>
            {[...new Set(result.violations.map((x) => x.message))].map((m) => (
              <div key={m} className="cr-message-preview">
                “{m}”
              </div>
            ))}
          </BlockStack>
        ) : null}
        {result.overriddenBy ? (
          <Banner tone="info">
            Another rule, “{result.overriddenBy.title}”, also matches this product and takes precedence under your rule
            behavior setting — so this rule&apos;s limit isn&apos;t the one applied.
          </Banner>
        ) : null}
        {result.customerConditionNote ? <Banner tone="info">{result.customerConditionNote}</Banner> : null}
        {result.otherViolations?.length ? (
          <Banner tone="warning" title="Other rules would also block this cart">
            <BlockStack gap="100">
              {result.otherViolations.map((o, i) => (
                <Text as="p" key={i}>
                  {o.ruleTitle}: {o.message}
                </Text>
              ))}
            </BlockStack>
          </Banner>
        ) : null}
        {result.notices?.length ? (
          <Banner tone="warning" title="Good to know">
            <BlockStack gap="100">
              {result.notices.map((n) => (
                <Text as="p" key={n}>
                  {n}
                </Text>
              ))}
            </BlockStack>
          </Banner>
        ) : null}
        <Text tone="subdued" as="p" variant="bodySm">
          Uses the same rule logic as checkout, on your real product data. Tests are recorded in Activity with a Test
          badge and never count toward analytics.
        </Text>
      </BlockStack>
    </Box>
  );
}

const emptyLine = () => ({ productTitle: "", variants: [], variantId: null, quantity: "1" });

export default function TestRulePage() {
  const { rules, currency } = useLoaderData();
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const fetcher = useFetcher();
  const preselected = rules.some((r) => r.id === searchParams.get("ruleId")) ? searchParams.get("ruleId") : "";
  const [ruleId, setRuleId] = useState(preselected || (rules[0]?.id ?? ""));
  const [lines, setLines] = useState([emptyLine()]);
  const [customerType, setCustomerType] = useState("guest");
  const [customerTags, setCustomerTags] = useState("");
  const [country, setCountry] = useState("");
  const [discountCode, setDiscountCode] = useState("");

  const selected = rules.find((r) => r.id === ruleId);
  const canRun = lines.every((l) => l.variantId && Number(l.quantity) >= 1);

  const run = () => {
    fetcher.submit(
      {
        input: JSON.stringify({
          ruleId: ruleId || null,
          items: lines.map((l) => ({ variantId: l.variantId, quantity: Number(l.quantity) })),
          customerType,
          customerTags: customerTags.split(",").map((t) => t.trim()).filter(Boolean),
          country: country || null,
          discountCode: discountCode.trim() || null,
        }),
      },
      { method: "post" },
    );
  };

  return (
    <AppPage
      title="Test a rule"
      subtitle="Build a cart from your real products and see exactly what checkout would do."
      back={
        <Button variant="tertiary" icon={ArrowLeftIcon} onClick={() => navigate("/app/rules")}>
          Rules
        </Button>
      }
    >
      {rules.length === 0 ? (
        <Banner tone="info" title="No rules to test yet" action={{ content: "Create rule", url: "/app/rules/new" }}>
          Create a rule first, then come back to try it.
        </Banner>
      ) : null}
      <div className="cr-grid cr-grid--main-side" style={{ alignItems: "start" }}>
        <Box title="Test cart">
          <BlockStack gap="500">
            <BlockStack gap="200">
              <Select
                label="Rule"
                options={[
                  ...rules.map((r) => ({ value: r.id, label: r.title || "Untitled rule" })),
                  { value: "", label: "All active rules (what checkout runs now)" },
                ]}
                value={ruleId}
                onChange={setRuleId}
              />
              {selected ? (
                <InlineStack gap="200" blockAlign="center" wrap>
                  <StatusBadge status={selected.status} />
                  <Text tone="subdued" as="span">
                    {selected.summary}
                  </Text>
                </InlineStack>
              ) : null}
            </BlockStack>

            {lines.map((line, i) => (
              <LineInput
                key={i}
                label={i === 0 ? "Product" : "Second product"}
                line={line}
                onChange={(next) => setLines(lines.map((l, j) => (j === i ? next : l)))}
                onRemove={i > 0 ? () => setLines(lines.filter((_, j) => j !== i)) : null}
              />
            ))}
            {lines.length < 2 ? (
              <div>
                <Button icon={PlusIcon} variant="plain" onClick={() => setLines([...lines, emptyLine()])}>
                  Add a second product (for combination and cart rules)
                </Button>
              </div>
            ) : null}

            <InlineGrid columns={{ xs: 1, sm: 2 }} gap="300">
              <Select
                label="Customer"
                options={[
                  { value: "guest", label: "Guest" },
                  { value: "logged_in", label: "Logged-in customer" },
                  { value: "b2b", label: "B2B customer" },
                ]}
                value={customerType}
                onChange={setCustomerType}
              />
              <TextField
                label="Customer tags"
                value={customerTags}
                onChange={setCustomerTags}
                placeholder="e.g. VIP, Wholesale"
                helpText="Comma-separated"
                disabled={customerType === "guest"}
                autoComplete="off"
              />
              <Select
                label="Country"
                options={[{ value: "", label: "Any country" }, ...COUNTRY_CODES.map((c) => ({ value: c, label: countryName(c) }))]}
                value={country}
                onChange={setCountry}
              />
              <TextField
                label="Discount code"
                value={discountCode}
                onChange={setDiscountCode}
                placeholder="None"
                helpText="Leave empty for no discount"
                autoComplete="off"
              />
            </InlineGrid>

            <InlineStack align="end">
              <Button variant="primary" disabled={!canRun} loading={fetcher.state !== "idle"} onClick={run}>
                Run test
              </Button>
            </InlineStack>
          </BlockStack>
        </Box>
        <div>
          {fetcher.data ? (
            <Result result={fetcher.data} currency={currency} ruleChosen={Boolean(ruleId)} />
          ) : (
            <Box title="Result">
              <Text tone="subdued" as="p">
                Choose a product and quantity, then run the test. Nothing is ordered and checkout isn&apos;t affected.
              </Text>
            </Box>
          )}
        </div>
      </div>
    </AppPage>
  );
}
