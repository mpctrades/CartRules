// Group limit pieces of the rule form (CartRules Update 1):
//  - GroupEditor: which products count toward the group — tags,
//    collections and picked products, mixed freely, with a live
//    "→ 6 products, 42 variants" count;
//  - RuleTester: "Test this rule" — the merchant builds a cart and sees OK /
//    Blocked from the same engine checkout runs, before activating.
import { useEffect, useMemo, useRef, useState } from "react";
import { useFetcher } from "@remix-run/react";
import {
  Badge,
  BlockStack,
  Button,
  Checkbox,
  InlineStack,
  Select,
  Tag,
  Text,
  TextField,
} from "@shopify/polaris";
import { DeleteIcon, LockIcon, PlusIcon } from "@shopify/polaris-icons";
import { TARGET_INFO, TARGET_TYPES, parseGroupValue, planAllows } from "../models/ruleConstants";
import { TokenField } from "./TokenField";

const TOOLS = "/app/rule-tools";

/** Values of one kind ("tag" | "collection" | "product") with their labels. */
function partOf(target, kind) {
  const values = [];
  const labels = [];
  (target.values ?? []).forEach((raw, i) => {
    const p = parseGroupValue(raw);
    if (p?.kind !== kind) return;
    values.push(p.value);
    labels.push(target.labels?.[i] ?? p.value);
  });
  return { values, labels };
}

/** Replaces one kind's values in a mixed target, keeping the others. */
function withPart(target, kind, values, labels) {
  const keep = [];
  const keepLabels = [];
  (target.values ?? []).forEach((raw, i) => {
    if (parseGroupValue(raw)?.kind === kind) return;
    keep.push(raw);
    keepLabels.push(target.labels?.[i] ?? raw);
  });
  return {
    type: TARGET_TYPES.MIXED,
    values: [...keep, ...values.map((v) => `${kind}:${v}`)],
    labels: [...keepLabels, ...values.map((v, i) => labels?.[i] ?? v)],
  };
}

function Locked({ plan }) {
  return (
    <Badge tone="attention" icon={LockIcon} size="small">
      {plan}
    </Badge>
  );
}

function PickerPart({ kind, title, target, onChange, disabled }) {
  const { values, labels } = partOf(target, kind);
  const pick = async () => {
    if (typeof window === "undefined" || !window.shopify?.resourcePicker) return;
    const selection = await window.shopify.resourcePicker({
      type: kind,
      action: "select",
      multiple: true,
      selectionIds: values.map((id) => ({ id })),
    });
    if (!selection) return;
    onChange(
      withPart(
        target,
        kind,
        selection.map((s) => s.id),
        selection.map((s) => s.title ?? s.id),
      ),
    );
  };
  return (
    <BlockStack gap="200">
      <InlineStack gap="200" blockAlign="center">
        <Text as="span" variant="bodyMd" fontWeight="medium">
          {title}
        </Text>
        {disabled ? <Locked plan={TARGET_INFO[kind].plan} /> : null}
      </InlineStack>
      <InlineStack gap="200" blockAlign="center" wrap>
        <Button onClick={pick} disabled={disabled && values.length === 0}>
          {values.length ? `Change ${title.toLowerCase()}` : `Choose ${title.toLowerCase()}`}
        </Button>
        {values.map((id, i) => (
          <Tag
            key={id}
            onRemove={() =>
              onChange(
                withPart(
                  target,
                  kind,
                  values.filter((_, j) => j !== i),
                  labels.filter((_, j) => j !== i),
                ),
              )
            }
          >
            {labels[i] ?? id.split("/").pop()}
          </Tag>
        ))}
      </InlineStack>
    </BlockStack>
  );
}

/** Step 2 for a Group limit rule. `value` is a mixed target. */
export function GroupEditor({ value, onChange, options, plan }) {
  const tagLocked = !planAllows(plan, TARGET_INFO.tag.plan);
  const collectionLocked = !planAllows(plan, TARGET_INFO.collection.plan);
  const tags = partOf(value, "tag").values;

  // Live product / variant count, debounced while the merchant edits.
  const counter = useFetcher();
  const key = (value.values ?? []).join("|");
  useEffect(() => {
    if (!key) return undefined;
    const timer = setTimeout(() => {
      counter.submit(
        { intent: "count", payload: JSON.stringify({ key, target: { type: TARGET_TYPES.MIXED, values: value.values } }) },
        { method: "post", action: TOOLS },
      );
    }, 400);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  const count = counter.data?.intent === "count" && counter.data.key === key ? counter.data : null;

  return (
    <BlockStack gap="400">
      <BlockStack gap="200">
        <InlineStack gap="200" blockAlign="center">
          <Text as="span" variant="bodyMd" fontWeight="medium">
            Product tags
          </Text>
          {tagLocked ? <Locked plan={TARGET_INFO.tag.plan} /> : null}
        </InlineStack>
        <TokenField
          label="Product tags"
          values={tags}
          suggestions={options.tags ?? []}
          placeholder="e.g. hoodie"
          disabled={tagLocked && tags.length === 0}
          onChange={(next) => onChange(withPart(value, "tag", next, next))}
          helpText="Every product with one of these tags counts — new ones too, automatically."
        />
      </BlockStack>
      <PickerPart kind="collection" title="Collections" target={value} onChange={onChange} disabled={collectionLocked} />
      <PickerPart kind="product" title="Products" target={value} onChange={onChange} />

      <div className="cr-group-count" aria-live="polite">
        {!key ? (
          <Text tone="subdued" as="p">
            Nothing selected yet.
          </Text>
        ) : count && !count.error ? (
          <Text as="p">
            <Text as="span" fontWeight="semibold">
              → {count.products} {count.products === 1 ? "product" : "products"}
              {count.more ? "" : `, ${count.variants} ${count.variants === 1 ? "variant" : "variants"}`}
            </Text>{" "}
            <Text as="span" tone="subdued">
              count toward this group{count.more ? " (variants not counted above 250 products)" : ""}.
            </Text>
          </Text>
        ) : (
          <Text tone="subdued" as="p">
            {count?.error ?? "Counting products…"}
          </Text>
        )}
      </div>
      <Text tone="subdued" as="p" variant="bodySm">
        Every size, color and variant of these products adds up to one total. A product matched twice (say, tagged and in a
        selected collection) still counts once. Products not selected never count.
      </Text>
    </BlockStack>
  );
}

// ---------------------------------------------------------------------------

let lineSeq = 0;

/** "Test this rule": build a cart, see what checkout would do with the rule as it is in the form. */
export function RuleTester({ rule, exemptTags }) {
  const [lines, setLines] = useState([]);
  const [asExempt, setAsExempt] = useState(false);
  const fetcher = useFetcher();

  const addProducts = async () => {
    if (typeof window === "undefined" || !window.shopify?.resourcePicker) return;
    const selection = await window.shopify.resourcePicker({ type: "product", action: "select", multiple: true });
    if (!selection?.length) return;
    setLines((current) => [
      ...current,
      ...selection.map((p) => {
        const variants = (p.variants ?? []).filter((v) => v?.id).map((v) => ({ id: v.id, title: v.title }));
        return { key: ++lineSeq, title: p.title, variants, variantId: variants[0]?.id ?? null, quantity: "1" };
      }),
    ]);
  };
  const update = (key, patch) => setLines((current) => current.map((l) => (l.key === key ? { ...l, ...patch } : l)));

  const items = useMemo(
    () =>
      lines
        .filter((l) => l.variantId && Number(l.quantity) > 0)
        .map((l) => ({ variantId: l.variantId, quantity: Math.floor(Number(l.quantity)) })),
    [lines],
  );
  const request = JSON.stringify({ rule, items, customerTags: asExempt ? exemptTags.slice(0, 1) : [] });
  const lastSent = useRef(null);
  useEffect(() => {
    if (items.length === 0) return undefined;
    const timer = setTimeout(() => {
      lastSent.current = request;
      fetcher.submit({ intent: "test", payload: request }, { method: "post", action: TOOLS });
    }, 400);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [request]);

  const result = items.length && fetcher.data?.intent === "test" ? fetcher.data : null;
  const stale = fetcher.state !== "idle" || lastSent.current !== request;
  const v = result?.violations?.[0];

  return (
    <BlockStack gap="300">
      {lines.length === 0 ? (
        <Text tone="subdued" as="p">
          Add products the way a shopper would — for example 2 of one hoodie and 1 of another — and see straight away
          whether checkout lets the order through.
        </Text>
      ) : (
        <div className="cr-list">
          {lines.map((l) => (
            <div key={l.key} className="cr-tester-row">
              <div style={{ flex: 1, minWidth: 0 }}>
                <Text as="p" fontWeight="medium" truncate>
                  {l.title}
                </Text>
                {l.variants.length > 1 ? (
                  <Select
                    label="Variant"
                    labelHidden
                    options={l.variants.map((x) => ({ value: x.id, label: x.title }))}
                    value={l.variantId ?? ""}
                    onChange={(variantId) => update(l.key, { variantId })}
                  />
                ) : null}
              </div>
              <div style={{ width: 96 }}>
                <TextField
                  label="Quantity"
                  labelHidden
                  type="number"
                  min={1}
                  prefix="×"
                  value={l.quantity}
                  onChange={(quantity) => update(l.key, { quantity })}
                  autoComplete="off"
                />
              </div>
              <Button
                icon={DeleteIcon}
                variant="tertiary"
                accessibilityLabel={`Remove ${l.title}`}
                onClick={() => setLines((current) => current.filter((x) => x.key !== l.key))}
              />
            </div>
          ))}
        </div>
      )}

      {result ? (
        result.error ? (
          <div className="cr-test-result cr-test-result--muted">{result.error}</div>
        ) : result.blocked ? (
          <div className={`cr-test-result cr-test-result--blocked${stale ? " cr-test-result--stale" : ""}`} role="status">
            <strong>
              Blocked
              {v?.attempted != null && v?.allowed != null ? ` — ${v.attempted} ${v.attempted === 1 ? "unit" : "units"} in cart, max ${v.allowed}.` : "."}
            </strong>{" "}
            Customer sees: “{result.messages.join(" ")}”
          </div>
        ) : (
          <div className={`cr-test-result cr-test-result--ok${stale ? " cr-test-result--stale" : ""}`} role="status">
            <strong>OK</strong>
            {result.applies
              ? result.total != null
                ? ` — ${result.total} ${result.total === 1 ? "unit" : "units"} in the group, max ${result.max}. Checkout goes through.`
                : " — checkout goes through."
              : asExempt
                ? " — this customer is exempt, checkout goes through."
                : " — none of these products are covered by this rule."}
          </div>
        )
      ) : null}

      <InlineStack align="space-between" blockAlign="center" gap="200">
        <Button icon={PlusIcon} onClick={addProducts}>
          Add product
        </Button>
        {exemptTags.length ? (
          <Checkbox
            label={`Shopper is tagged “${exemptTags[0]}”`}
            checked={asExempt}
            onChange={setAsExempt}
          />
        ) : null}
      </InlineStack>
      <Text tone="subdued" as="p" variant="bodySm">
        Uses the same check as checkout. Only this rule is tested, as it is in the form now — nothing is saved or
        recorded.
      </Text>
    </BlockStack>
  );
}
