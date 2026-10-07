// Guided rule form shared by /app/rules/new and /app/rules/:id.
// 5 steps: Rule type → Applies to → Conditions → Customer message → Review.
// Only fields relevant to the chosen rule type are shown; features above the
// shop's plan stay visible but disabled with a plan badge. The server
// re-validates everything (normalizeRuleInput + checkPlanForSave).
import { useCallback, useMemo, useState } from "react";
import { useFetcher, Link as RemixLink } from "@remix-run/react";
import {
  Badge,
  Banner,
  BlockStack,
  Button,
  ChoiceList,
  Combobox,
  Icon,
  InlineGrid,
  InlineStack,
  Listbox,
  Select,
  Tag,
  Text,
  TextField,
} from "@shopify/polaris";
import { CheckIcon, DeleteIcon, LockIcon, PlusIcon } from "@shopify/polaris-icons";
import {
  RULE_TYPES,
  RULE_TYPE_INFO,
  RULE_TYPE_ORDER,
  TARGET_TYPES,
  TARGET_INFO,
  CUSTOMER_TYPES,
  CUSTOMER_INFO,
  MARKET_TYPES,
  CONDITION_FIELDS,
  CONDITION_OPS,
  MESSAGE_VARIABLES,
  RULE_STATUS,
  planAllows,
} from "../models/ruleConstants";
import { describeRule, describeTarget, describeCustomer, formatMoney, formatDateTime } from "../models/ruleDisplay";
import { lockedFeaturesClient, FEATURE_PLANS } from "../models/planFeatures";
import { zonedToUtcIso, utcIsoToZoned } from "../utils/time";
import { renderMessage } from "../../extensions/cartrules-validation/src/engine.js";
import { Box } from "./ui";
import { COUNTRY_CODES, countryName } from "./countries";

const STEPS = ["Rule type", "Applies to", "Conditions", "Customer message", "Review"];

function PlanBadge({ plan }) {
  return (
    <Badge tone="attention" icon={LockIcon} size="small">
      {plan}
    </Badge>
  );
}

/** Rule (stored shape or template defaults) -> form state. */
export function ruleToForm(rule, timezone) {
  const start = utcIsoToZoned(rule?.schedule?.startsAt, timezone);
  const end = utcIsoToZoned(rule?.schedule?.endsAt, timezone);
  const hasSchedule = Boolean(rule?.schedule?.startsAt || rule?.schedule?.endsAt || rule?.scheduled);
  return {
    title: rule?.title ?? "",
    ruleType: rule?.ruleType ?? RULE_TYPES.MAX_QUANTITY,
    status: rule?.status ?? RULE_STATUS.ACTIVE,
    value: rule?.value != null ? String(rule.value) : "",
    target: rule?.target ?? { type: TARGET_TYPES.ALL, values: [], labels: [] },
    comboTarget: rule?.comboTarget ?? { type: TARGET_TYPES.PRODUCT, values: [], labels: [] },
    customer: rule?.customer ?? { type: CUSTOMER_TYPES.EVERYONE, tags: [] },
    market: rule?.market ?? { type: MARKET_TYPES.ALL, countries: [], marketIds: [], labels: [] },
    conditions: rule?.conditions ?? [],
    scheduleMode: hasSchedule ? "scheduled" : "forever",
    startDate: start.date,
    startTime: start.time || "00:00",
    endDate: end.date,
    endTime: end.time || "23:59",
    priority: rule?.priority ? String(rule.priority) : "0",
    message: rule?.message ?? "",
  };
}

/** Form state -> payload for normalizeRuleInput. */
function formToRule(form, timezone, status) {
  const info = RULE_TYPE_INFO[form.ruleType];
  const scheduled = form.scheduleMode === "scheduled";
  return {
    title: form.title.trim(),
    ruleType: form.ruleType,
    status: status ?? form.status,
    value: info?.valueLabel ? (info.money ? Number(form.value) : parseInt(form.value, 10)) : null,
    target: form.target,
    comboTarget: form.ruleType === RULE_TYPES.PRODUCT_COMBINATION ? form.comboTarget : null,
    customer: form.customer,
    market: form.market,
    conditions: form.conditions,
    schedule: {
      startsAt: scheduled && form.startDate ? zonedToUtcIso(form.startDate, form.startTime, timezone) : null,
      endsAt: scheduled && form.endDate ? zonedToUtcIso(form.endDate, form.endTime, timezone) : null,
    },
    priority: Number(form.priority) || 0,
    message: form.message,
  };
}

function suggestTitle(form) {
  const info = RULE_TYPE_INFO[form.ruleType];
  const target = form.target.type === TARGET_TYPES.ALL ? "All products" : (form.target.labels?.[0] ?? form.target.values?.[0] ?? "");
  const value = info?.valueLabel && form.value ? ` ${info.money ? form.value : form.value}` : "";
  return `${target ? `${target} – ` : ""}${info?.short ?? ""}${value}`.trim();
}

// ---------------------------------------------------------------------------

/** Multi-value input with suggestions (tags, vendors, types, countries). */
function TokenField({ label, values, onChange, suggestions = [], placeholder, disabled, format = (v) => v, helpText }) {
  const [input, setInput] = useState("");
  const lowerValues = values.map((v) => String(v).toLowerCase());
  const matches = suggestions
    .filter((s) => !lowerValues.includes(String(s).toLowerCase()))
    .filter((s) => !input || format(s).toLowerCase().includes(input.toLowerCase()) || String(s).toLowerCase().includes(input.toLowerCase()))
    .slice(0, 12);
  const add = (raw) => {
    const v = String(raw ?? "").trim();
    if (!v || lowerValues.includes(v.toLowerCase())) {
      setInput("");
      return;
    }
    onChange([...values, v]);
    setInput("");
  };
  const exact = suggestions.some((s) => String(s).toLowerCase() === input.trim().toLowerCase());
  return (
    <BlockStack gap="200">
      <Combobox
        activator={
          <Combobox.TextField
            label={label}
            value={input}
            onChange={setInput}
            placeholder={placeholder}
            autoComplete="off"
            disabled={disabled}
            helpText={helpText}
          />
        }
      >
        {matches.length > 0 || (input.trim() && !exact) ? (
          <Listbox onSelect={add}>
            {input.trim() && !exact ? (
              <Listbox.Option value={input.trim()}>{`Add “${input.trim()}”`}</Listbox.Option>
            ) : null}
            {matches.map((s) => (
              <Listbox.Option key={s} value={s}>
                {format(s)}
              </Listbox.Option>
            ))}
          </Listbox>
        ) : null}
      </Combobox>
      {values.length ? (
        <InlineStack gap="150" wrap>
          {values.map((v) => (
            <Tag key={v} onRemove={disabled ? undefined : () => onChange(values.filter((x) => x !== v))}>
              {format(v)}
            </Tag>
          ))}
        </InlineStack>
      ) : null}
    </BlockStack>
  );
}

/** Target editor: type + the matching picker/input. */
function TargetEditor({ label, value, onChange, options, plan, allowAll = true }) {
  const typeOptions = Object.entries(TARGET_INFO)
    .filter(([type]) => allowAll || type !== TARGET_TYPES.ALL)
    .map(([type, info]) => ({
      value: type,
      label: planAllows(plan, info.plan) ? info.label : `${info.label} (${info.plan} plan)`,
      disabled: !planAllows(plan, info.plan) && value.type !== type,
    }));

  const pickerType = {
    [TARGET_TYPES.PRODUCT]: "product",
    [TARGET_TYPES.VARIANT]: "variant",
    [TARGET_TYPES.COLLECTION]: "collection",
  }[value.type];

  const pick = async () => {
    if (typeof window === "undefined" || !window.shopify?.resourcePicker) return;
    const selection = await window.shopify.resourcePicker({
      type: pickerType,
      action: "select",
      multiple: true,
      selectionIds: value.values.map((id) => ({ id })),
    });
    if (!selection) return;
    onChange({
      ...value,
      values: selection.map((s) => s.id),
      labels: selection.map((s) => s.displayName ?? (s.product?.title ? `${s.product.title} – ${s.title}` : s.title) ?? s.id),
    });
  };

  const suggestions =
    value.type === TARGET_TYPES.TAG
      ? options.tags
      : value.type === TARGET_TYPES.VENDOR
        ? options.vendors
        : value.type === TARGET_TYPES.PRODUCT_TYPE
          ? options.types
          : [];

  return (
    <BlockStack gap="300">
      <Select
        label={label}
        options={typeOptions}
        value={value.type}
        onChange={(type) => onChange({ type, values: [], labels: [] })}
      />
      {pickerType ? (
        <BlockStack gap="200">
          <InlineStack gap="200" blockAlign="center">
            <Button onClick={pick}>
              {value.values.length ? `Change ${TARGET_INFO[value.type].noun.toLowerCase()}` : `Choose ${TARGET_INFO[value.type].noun.toLowerCase()}`}
            </Button>
            {value.values.length ? (
              <Text tone="subdued" as="span">
                {value.values.length} selected
              </Text>
            ) : null}
          </InlineStack>
          {value.values.length ? (
            <InlineStack gap="150" wrap>
              {value.values.map((id, i) => (
                <Tag
                  key={id}
                  onRemove={() =>
                    onChange({
                      ...value,
                      values: value.values.filter((_, j) => j !== i),
                      labels: (value.labels ?? []).filter((_, j) => j !== i),
                    })
                  }
                >
                  {value.labels?.[i] ?? id.split("/").pop()}
                </Tag>
              ))}
            </InlineStack>
          ) : null}
        </BlockStack>
      ) : null}
      {suggestions && value.type !== TARGET_TYPES.ALL && !pickerType ? (
        <TokenField
          label={TARGET_INFO[value.type].noun}
          values={value.values}
          suggestions={suggestions}
          placeholder={value.type === TARGET_TYPES.TAG ? "e.g. limited-edition" : "Start typing…"}
          onChange={(values) => onChange({ ...value, values, labels: values })}
        />
      ) : null}
    </BlockStack>
  );
}

function ConditionRow({ condition, onChange, onRemove }) {
  const field = CONDITION_FIELDS[condition.field];
  return (
    <div style={{ display: "grid", gridTemplateColumns: "minmax(0,1.2fr) minmax(0,1fr) minmax(0,1.4fr) auto", gap: 8, alignItems: "end" }}>
      <Select
        label="When"
        labelHidden
        options={Object.entries(CONDITION_FIELDS).map(([k, f]) => ({ value: k, label: f.label }))}
        value={condition.field}
        onChange={(f) => onChange({ field: f, op: CONDITION_FIELDS[f].ops[0], value: "" })}
      />
      <Select
        label="Operator"
        labelHidden
        options={field.ops.map((op) => ({ value: op, label: CONDITION_OPS[op] }))}
        value={condition.op}
        onChange={(op) => onChange({ ...condition, op })}
      />
      {condition.field === "country" ? (
        <Select
          label="Country"
          labelHidden
          options={[{ value: "", label: "Choose a country" }, ...COUNTRY_CODES.map((c) => ({ value: c, label: countryName(c) }))]}
          value={condition.value}
          onChange={(v) => onChange({ ...condition, value: v })}
        />
      ) : (
        <TextField
          label="Value"
          labelHidden
          type={field.numeric ? "number" : "text"}
          value={condition.value}
          onChange={(v) => onChange({ ...condition, value: v })}
          autoComplete="off"
          placeholder={field.numeric ? "Amount" : "Value"}
        />
      )}
      <Button icon={DeleteIcon} accessibilityLabel="Remove condition" variant="tertiary" onClick={onRemove} />
    </div>
  );
}

function SummaryRow({ label, children }) {
  return (
    <div className="cr-list-row" style={{ alignItems: "flex-start" }}>
      <span className="cr-muted" style={{ minWidth: 140 }}>
        {label}
      </span>
      <div style={{ flex: 1, minWidth: 0, textAlign: "right" }}>{children}</div>
    </div>
  );
}

// ---------------------------------------------------------------------------

/**
 * props: initial (rule or template), mode ("new"|"edit"), plan, timezone,
 * currency, options ({ tags, vendors, types, markets, marketsAvailable }),
 * defaultMessages ({ [ruleType]: template }), existingStatus.
 */
export default function RuleForm({ initial, mode, plan, timezone, currency, options, defaultMessages, existingStatus }) {
  const fetcher = useFetcher();
  const [form, setForm] = useState(() => ruleToForm(initial, timezone));
  const [step, setStep] = useState(mode === "edit" ? 5 : 1);
  const [titleTouched, setTitleTouched] = useState(mode === "edit" || Boolean(initial?.title));
  const set = useCallback((patch) => setForm((f) => ({ ...f, ...patch })), []);

  const info = RULE_TYPE_INFO[form.ruleType];
  const rulePreview = useMemo(() => formToRule(form, timezone), [form, timezone]);
  const locks = lockedFeaturesClient(rulePreview, plan);
  const title = titleTouched ? form.title : suggestTitle(form);

  // Per-step validation (the server checks again).
  const valueError =
    info?.valueLabel && form.value !== ""
      ? info.money
        ? !(Number(form.value) > 0)
          ? "Enter an amount greater than 0."
          : null
        : !(Number.isInteger(Number(form.value)) && Number(form.value) >= 1)
          ? "Enter a whole number of 1 or more."
          : null
      : null;
  const stepErrors = {
    2:
      form.target.type !== TARGET_TYPES.ALL && form.target.values.length === 0
        ? "Choose what this rule applies to."
        : form.ruleType === RULE_TYPES.PRODUCT_COMBINATION && form.comboTarget.values.length === 0
          ? "Choose the products that can't be bought together with the first group."
          : null,
    3:
      info?.valueLabel && (form.value === "" || valueError)
        ? valueError ?? `Enter the ${info.valueLabel.toLowerCase()}.`
        : (form.customer.type === CUSTOMER_TYPES.TAGS || form.customer.type === CUSTOMER_TYPES.EXCLUDE_TAGS) &&
            form.customer.tags.length === 0
          ? "Add at least one customer tag."
          : form.market.type === MARKET_TYPES.COUNTRIES && form.market.countries.length === 0
            ? "Choose at least one country."
            : form.market.type === MARKET_TYPES.MARKETS && form.market.marketIds.length === 0
              ? "Choose at least one market."
              : form.scheduleMode === "scheduled" && !form.startDate && !form.endDate
                ? "Set a start or end date, or choose Run forever."
                : form.scheduleMode === "scheduled" &&
                    form.startDate &&
                    form.endDate &&
                    zonedToUtcIso(form.endDate, form.endTime, timezone) <= zonedToUtcIso(form.startDate, form.startTime, timezone)
                  ? "The end must be after the start."
                  : null,
  };
  const firstError = [2, 3].find((s) => stepErrors[s]);
  const canSave = !firstError && title.trim() && locks.length === 0;

  const submit = (status) => {
    fetcher.submit(
      { rule: JSON.stringify({ ...formToRule({ ...form, title }, timezone, status), templateId: initial?.templateId ?? null }) },
      { method: "post" },
    );
  };

  const startsInFuture = rulePreview.schedule.startsAt && Date.parse(rulePreview.schedule.startsAt) > Date.now();
  const activateLabel = startsInFuture ? "Save & schedule" : "Save & activate";
  const saving = fetcher.state !== "idle";
  const serverError = fetcher.data?.ok === false ? fetcher.data.error : null;

  const sampleProduct =
    form.target.type !== TARGET_TYPES.ALL && form.target.labels?.[0] ? form.target.labels[0] : "your product";
  const defaultMessage = defaultMessages?.[form.ruleType] ?? "";
  const preview = renderMessage(form.message || defaultMessage, {
    type: form.ruleType,
    product: sampleProduct,
    limit: info?.money ? formatMoney(form.value || 0, currency) : form.value || (info?.valueLabel ? "N" : ""),
    quantity: info?.money ? formatMoney(Number(form.value || 0) * 1.5, currency) : form.value ? Number(form.value) + 1 : "",
    collection: form.target.labels?.join(", ") || undefined,
    discount_code: "SAVE20",
  });

  const messageLocked = !planAllows(plan, FEATURE_PLANS.message);
  const scheduleLocked = !planAllows(plan, FEATURE_PLANS.schedule);
  const customerLocked = !planAllows(plan, FEATURE_PLANS.customer);
  const marketLocked = !planAllows(plan, FEATURE_PLANS.market);
  const conditionsLocked = !planAllows(plan, FEATURE_PLANS.conditions);
  const priorityLocked = !planAllows(plan, FEATURE_PLANS.priority);

  const goTo = (n) => setStep(Math.max(1, Math.min(5, n)));

  // ---- Steps ---------------------------------------------------------------

  const stepType = (
    <Box title="What should this rule do?" subtitle="Pick one. You can change it later.">
      <div className="cr-option-grid">
        {RULE_TYPE_ORDER.map((type) => {
          const t = RULE_TYPE_INFO[type];
          const locked = !planAllows(plan, t.plan);
          const selected = form.ruleType === type;
          return (
            <button
              key={type}
              type="button"
              className="cr-option"
              aria-pressed={selected}
              disabled={locked && !selected}
              onClick={() => {
                const patch = { ruleType: type };
                if (RULE_TYPE_INFO[type].money !== info?.money || !RULE_TYPE_INFO[type].valueLabel) patch.value = "";
                set(patch);
              }}
            >
              <BlockStack gap="100">
                <InlineStack align="space-between" blockAlign="center" wrap={false} gap="200">
                  <Text as="h3" variant="headingSm">
                    {t.title}
                  </Text>
                  {selected ? (
                    <span style={{ color: "var(--cr-orange-strong)" }}>
                      <Icon source={CheckIcon} />
                    </span>
                  ) : locked ? (
                    <PlanBadge plan={t.plan} />
                  ) : null}
                </InlineStack>
                <Text as="p" tone="subdued">
                  {t.description}
                </Text>
              </BlockStack>
            </button>
          );
        })}
      </div>
      {RULE_TYPE_ORDER.some((t) => !planAllows(plan, RULE_TYPE_INFO[t].plan)) ? (
        <div style={{ marginTop: 12 }}>
          <Text tone="subdued" as="p">
            Locked rule types are included in Growth and Pro.{" "}
            <RemixLink to="/app/billing" className="cr-link-accent">
              Compare plans
            </RemixLink>
          </Text>
        </div>
      ) : null}
      {form.ruleType === RULE_TYPES.NO_DISCOUNT ? (
        <div style={{ marginTop: 12 }}>
          <Banner tone="info">
            Checkout can't tell discount codes from automatic discounts, so any discount on these products blocks
            checkout. Exclude them from your automatic discounts.
          </Banner>
        </div>
      ) : null}
    </Box>
  );

  const stepTarget = (
    <Box
      title={form.ruleType === RULE_TYPES.PRODUCT_COMBINATION ? "Which products can't be bought together?" : "Which products does it apply to?"}
      subtitle={
        [RULE_TYPES.CART_MIN_VALUE, RULE_TYPES.CART_MAX_VALUE].includes(form.ruleType)
          ? "All products checks the whole cart total. Otherwise only these products count toward the amount."
          : form.ruleType === RULE_TYPES.MAX_CART_ITEMS
            ? "Only items from these products count toward the limit."
            : "Tags, collections, vendors and types are checked live at checkout — new matching products are covered automatically."
      }
    >
      <BlockStack gap="500">
        <TargetEditor
          label={form.ruleType === RULE_TYPES.PRODUCT_COMBINATION ? "First group" : "Applies to"}
          value={form.target}
          onChange={(target) => set({ target })}
          options={options}
          plan={plan}
          allowAll={form.ruleType !== RULE_TYPES.PRODUCT_COMBINATION}
        />
        {form.ruleType === RULE_TYPES.PRODUCT_COMBINATION ? (
          <TargetEditor
            label="Can't be bought together with"
            value={form.comboTarget}
            onChange={(comboTarget) => set({ comboTarget })}
            options={options}
            plan={plan}
            allowAll={false}
          />
        ) : null}
      </BlockStack>
    </Box>
  );

  const customerOptions = Object.entries(CUSTOMER_INFO).map(([value, label]) => ({
    value,
    label: value !== CUSTOMER_TYPES.EVERYONE && customerLocked ? `${label} (Pro plan)` : label,
    disabled: value !== CUSTOMER_TYPES.EVERYONE && customerLocked && form.customer.type !== value,
  }));

  const stepConditions = (
    <BlockStack gap="400">
      {info?.valueLabel ? (
        <Box title={info.title}>
          <div style={{ maxWidth: 280 }}>
            <TextField
              label={info.valueLabel}
              type="number"
              min={info.money ? 0 : 1}
              step={info.money ? 0.01 : 1}
              value={form.value}
              onChange={(value) => set({ value })}
              suffix={info.money ? currency : form.ruleType === RULE_TYPES.MAX_CART_ITEMS ? "items" : "units"}
              error={valueError ?? undefined}
              autoComplete="off"
              helpText={
                form.ruleType === RULE_TYPES.QUANTITY_MULTIPLE
                  ? `Customers can buy ${[1, 2, 3].map((n) => (Number(form.value) || 6) * n).join(", ")}…`
                  : form.ruleType === RULE_TYPES.MAX_QUANTITY
                    ? "Counted per product across all its variants in the cart."
                    : undefined
              }
            />
          </div>
        </Box>
      ) : null}

      <Box
        title="Customers"
        subtitle="Who this rule applies to."
        actions={customerLocked ? <PlanBadge plan="Pro" /> : null}
      >
        <BlockStack gap="300">
          <Select
            label="Applies to"
            options={customerOptions}
            value={form.customer.type}
            onChange={(type) => set({ customer: { type, tags: form.customer.tags } })}
          />
          {form.customer.type === CUSTOMER_TYPES.TAGS || form.customer.type === CUSTOMER_TYPES.EXCLUDE_TAGS ? (
            <TokenField
              label={form.customer.type === CUSTOMER_TYPES.TAGS ? "Customer tags" : "Except customers tagged"}
              values={form.customer.tags}
              onChange={(tags) => set({ customer: { ...form.customer, tags } })}
              placeholder="e.g. VIP, Wholesale"
            />
          ) : null}
        </BlockStack>
      </Box>

      <Box title="Markets" subtitle="Where this rule applies." actions={marketLocked ? <PlanBadge plan="Pro" /> : null}>
        <BlockStack gap="300">
          <Select
            label="Countries"
            options={[
              { value: MARKET_TYPES.ALL, label: "All countries" },
              {
                value: MARKET_TYPES.COUNTRIES,
                label: marketLocked ? "Specific countries (Pro plan)" : "Specific countries",
                disabled: marketLocked && form.market.type !== MARKET_TYPES.COUNTRIES,
              },
              ...(options.marketsAvailable
                ? [
                    {
                      value: MARKET_TYPES.MARKETS,
                      label: marketLocked ? "Specific Shopify Markets (Pro plan)" : "Specific Shopify Markets",
                      disabled: marketLocked && form.market.type !== MARKET_TYPES.MARKETS,
                    },
                  ]
                : []),
            ]}
            value={form.market.type}
            onChange={(type) => set({ market: { type, countries: [], marketIds: [], labels: [] } })}
          />
          {form.market.type === MARKET_TYPES.COUNTRIES ? (
            <TokenField
              label="Countries"
              values={form.market.countries}
              suggestions={COUNTRY_CODES}
              format={countryName}
              onChange={(countries) => set({ market: { ...form.market, countries: countries.map((c) => c.toUpperCase()) } })}
              placeholder="Search countries"
            />
          ) : null}
          {form.market.type === MARKET_TYPES.MARKETS ? (
            options.markets.length ? (
              <ChoiceList
                title="Markets"
                allowMultiple
                choices={options.markets.map((m) => ({ value: m.id, label: m.name }))}
                selected={form.market.marketIds}
                onChange={(marketIds) =>
                  set({
                    market: {
                      ...form.market,
                      marketIds,
                      labels: marketIds.map((id) => options.markets.find((m) => m.id === id)?.name ?? id),
                    },
                  })
                }
              />
            ) : (
              <Text tone="subdued">No markets found in your store.</Text>
            )
          ) : null}
          {form.market.type === MARKET_TYPES.MARKETS ? (
            <Text tone="subdued" as="p" variant="bodySm">
              Saved as the countries in each market. Re-save the rule if you change a market&apos;s countries.
            </Text>
          ) : null}
        </BlockStack>
      </Box>

      <Box
        title="Extra conditions"
        subtitle="Optional. All conditions must match for the rule to apply."
        actions={conditionsLocked ? <PlanBadge plan="Pro" /> : null}
      >
        <BlockStack gap="300">
          {form.conditions.map((c, i) => (
            <ConditionRow
              key={i}
              condition={c}
              onChange={(next) => set({ conditions: form.conditions.map((x, j) => (j === i ? next : x)) })}
              onRemove={() => set({ conditions: form.conditions.filter((_, j) => j !== i) })}
            />
          ))}
          <div>
            <Button
              icon={PlusIcon}
              disabled={conditionsLocked}
              onClick={() => set({ conditions: [...form.conditions, { field: "product_tag", op: "is", value: "" }] })}
            >
              Add condition
            </Button>
          </div>
          {form.conditions.length ? (
            <Text tone="subdued" as="p" variant="bodySm">
              Rows with an empty value are ignored.
            </Text>
          ) : null}
        </BlockStack>
      </Box>

      <Box title="Schedule" actions={scheduleLocked ? <PlanBadge plan="Growth" /> : null}>
        <BlockStack gap="300">
          <ChoiceList
            title="When does this rule run?"
            titleHidden
            choices={[
              { value: "forever", label: "Run forever" },
              { value: "scheduled", label: "Only between these dates", disabled: scheduleLocked && form.scheduleMode !== "scheduled" },
            ]}
            selected={[form.scheduleMode]}
            onChange={([scheduleMode]) => set({ scheduleMode })}
          />
          {form.scheduleMode === "scheduled" ? (
            <BlockStack gap="200">
              <InlineGrid columns={{ xs: 1, sm: 2 }} gap="300">
                <TextField label="Start date" type="date" value={form.startDate} onChange={(startDate) => set({ startDate })} autoComplete="off" />
                <TextField label="Start time" type="time" value={form.startTime} onChange={(startTime) => set({ startTime })} autoComplete="off" />
                <TextField label="End date" type="date" value={form.endDate} onChange={(endDate) => set({ endDate })} autoComplete="off" />
                <TextField label="End time" type="time" value={form.endTime} onChange={(endTime) => set({ endTime })} autoComplete="off" />
              </InlineGrid>
              <Text tone="subdued" as="p" variant="bodySm">
                Times are in your store&apos;s timezone{timezone ? ` (${timezone})` : ""}. The rule switches on and off
                automatically. Leave a date empty for no start or no end.
              </Text>
            </BlockStack>
          ) : null}
        </BlockStack>
      </Box>

      {[RULE_TYPES.MAX_QUANTITY, RULE_TYPES.MIN_QUANTITY, RULE_TYPES.QUANTITY_MULTIPLE].includes(form.ruleType) ? (
        <Box
          title="Priority"
          subtitle="Used when Settings → Rule behavior is “Highest priority wins” and two rules match the same product."
          actions={priorityLocked ? <PlanBadge plan="Pro" /> : null}
        >
          <div style={{ maxWidth: 200 }}>
            <TextField
              label="Priority (0–100)"
              type="number"
              min={0}
              max={100}
              value={form.priority}
              onChange={(priority) => set({ priority })}
              disabled={priorityLocked && !Number(form.priority)}
              autoComplete="off"
            />
          </div>
        </Box>
      ) : null}
    </BlockStack>
  );

  const stepMessage = (
    <Box
      title="Customer message"
      subtitle="Shown on the product page, in the cart and at checkout when this rule applies."
      actions={messageLocked ? <PlanBadge plan="Growth" /> : null}
    >
      <BlockStack gap="400">
        <TextField
          label="Message"
          value={form.message}
          onChange={(message) => set({ message })}
          multiline={3}
          maxLength={500}
          autoComplete="off"
          placeholder={defaultMessage}
          disabled={messageLocked && !form.message}
          helpText={
            messageLocked
              ? "Free plan uses the default message (in your store's language). Custom messages are included in Growth."
              : "Leave empty to use the default message. Write it in your customers' language — it's shown as-is."
          }
        />
        <InlineStack gap="150" wrap>
          {MESSAGE_VARIABLES.map((v) => (
            <Button
              key={v}
              size="slim"
              disabled={messageLocked}
              onClick={() => set({ message: `${form.message}${form.message && !form.message.endsWith(" ") ? " " : ""}${v}` })}
            >
              {v}
            </Button>
          ))}
        </InlineStack>
        <BlockStack gap="150">
          <Text as="h3" variant="headingSm">
            Preview
          </Text>
          <div className="cr-message-preview">{preview || "—"}</div>
          <Text tone="subdued" as="p" variant="bodySm">
            Example values — the real product name, limit and quantities are filled in for each shopper.
          </Text>
        </BlockStack>
      </BlockStack>
    </Box>
  );

  const scheduleText =
    form.scheduleMode === "scheduled"
      ? [
          rulePreview.schedule.startsAt ? `From ${formatDateTime(rulePreview.schedule.startsAt, timezone)}` : "Starts now",
          rulePreview.schedule.endsAt ? `until ${formatDateTime(rulePreview.schedule.endsAt, timezone)}` : "no end date",
        ].join(" ")
      : "Runs until you pause it";

  const stepReview = (
    <Box title="Review">
      <BlockStack gap="400">
        <TextField
          label="Rule name"
          value={title}
          onChange={(value) => {
            setTitleTouched(true);
            set({ title: value });
          }}
          autoComplete="off"
          helpText="Only you see this name."
        />
        <div className="cr-list">
          <SummaryRow label="Rule">
            <Text as="span" fontWeight="medium">
              {describeRule(rulePreview, currency)}
            </Text>
          </SummaryRow>
          <SummaryRow label="Applies to">{describeTarget(form.target)}</SummaryRow>
          {form.ruleType === RULE_TYPES.PRODUCT_COMBINATION ? (
            <SummaryRow label="Not together with">{describeTarget(form.comboTarget)}</SummaryRow>
          ) : null}
          <SummaryRow label="Customers">{describeCustomer(form.customer)}</SummaryRow>
          <SummaryRow label="Markets">
            {form.market.type === MARKET_TYPES.ALL
              ? "All countries"
              : form.market.type === MARKET_TYPES.COUNTRIES
                ? form.market.countries.map(countryName).join(", ")
                : form.market.labels.join(", ")}
          </SummaryRow>
          {form.conditions.filter((c) => c.value !== "").length ? (
            <SummaryRow label="Conditions">
              {form.conditions
                .filter((c) => c.value !== "")
                .map((c) => `${CONDITION_FIELDS[c.field].label} ${CONDITION_OPS[c.op]} ${c.field === "country" ? countryName(c.value) : c.value}`)
                .join(" AND ")}
            </SummaryRow>
          ) : null}
          <SummaryRow label="Schedule">{scheduleText}</SummaryRow>
          {Number(form.priority) ? <SummaryRow label="Priority">{form.priority}</SummaryRow> : null}
          <SummaryRow label="Message">“{preview}”</SummaryRow>
        </div>
        {locks.length ? (
          <Banner tone="warning" title={`Your ${plan} plan doesn't include everything this rule uses`}>
            <BlockStack gap="200">
              <Text as="p">{locks.map((l) => `${l.label} (${l.plan})`).join(", ")}</Text>
              <InlineStack>
                <Button url="/app/billing">See plans</Button>
              </InlineStack>
            </BlockStack>
          </Banner>
        ) : null}
        {firstError ? (
          <Banner tone="warning" title="A few details are missing">
            <BlockStack gap="200">
              <Text as="p">{stepErrors[firstError]}</Text>
              <InlineStack>
                <Button onClick={() => goTo(firstError)}>Go to {STEPS[firstError - 1]}</Button>
              </InlineStack>
            </BlockStack>
          </Banner>
        ) : null}
      </BlockStack>
    </Box>
  );

  const current = [stepType, stepTarget, stepConditions, stepMessage, stepReview][step - 1];
  const stepBlocked = stepErrors[step];

  const saveButtons =
    mode === "edit" ? (
      <InlineStack gap="200" align="end">
        {existingStatus !== RULE_STATUS.ACTIVE ? (
          <Button disabled={!canSave} loading={saving} onClick={() => submit(existingStatus)}>
            Save changes
          </Button>
        ) : null}
        <Button
          variant="primary"
          disabled={!canSave}
          loading={saving}
          onClick={() => submit(RULE_STATUS.ACTIVE)}
        >
          {existingStatus === RULE_STATUS.ACTIVE ? "Save changes" : activateLabel}
        </Button>
      </InlineStack>
    ) : (
      <InlineStack gap="200" align="end">
        <Button disabled={!canSave} loading={saving} onClick={() => submit(RULE_STATUS.DRAFT)}>
          Save as draft
        </Button>
        <Button variant="primary" disabled={!canSave} loading={saving} onClick={() => submit(RULE_STATUS.ACTIVE)}>
          {activateLabel}
        </Button>
      </InlineStack>
    );

  return (
    <BlockStack gap="400">
      <nav className="cr-steps" aria-label="Rule steps">
        {STEPS.map((label, i) => {
          const n = i + 1;
          const done = n < step && !stepErrors[n];
          return (
            <button
              key={label}
              type="button"
              className={`cr-step${done ? " cr-step--done" : ""}`}
              aria-current={n === step ? "step" : undefined}
              onClick={() => goTo(n)}
            >
              <span className="cr-step-num">{done ? "✓" : n}</span>
              {label}
            </button>
          );
        })}
      </nav>

      {serverError ? (
        <Banner tone="critical" title="This rule wasn't saved">
          <BlockStack gap="200">
            <Text as="p">{serverError}</Text>
            {fetcher.data?.upgrade ? (
              <InlineStack>
                <Button url="/app/billing">See plans</Button>
              </InlineStack>
            ) : null}
          </BlockStack>
        </Banner>
      ) : null}

      {current}

      <InlineStack align="space-between" blockAlign="center" gap="200">
        <div>{step > 1 ? <Button onClick={() => goTo(step - 1)}>Back</Button> : null}</div>
        {step < 5 ? (
          <InlineStack gap="200" blockAlign="center">
            {stepBlocked ? (
              <Text tone="subdued" as="span" variant="bodySm">
                {stepBlocked}
              </Text>
            ) : null}
            {mode === "edit" ? saveButtons : null}
            <Button variant={mode === "edit" ? "secondary" : "primary"} disabled={Boolean(stepBlocked)} onClick={() => goTo(step + 1)}>
              Next
            </Button>
          </InlineStack>
        ) : (
          saveButtons
        )}
      </InlineStack>
    </BlockStack>
  );
}
