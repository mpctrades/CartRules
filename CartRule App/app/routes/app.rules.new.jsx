import { useState } from "react";
import { json } from "@remix-run/node";
import { useFetcher, useLoaderData, useNavigate, useSearchParams } from "@remix-run/react";
import {
  Page,
  Card,
  BlockStack,
  InlineStack,
  Button,
  TextField,
  Select,
  Text,
  Banner,
} from "@shopify/polaris";
import { authenticate } from "../shopify.server";
import { createRule, countActiveRules } from "../models/rules.server";
import { getSettings } from "../models/settings.server";
import { RULE_TYPES, TARGET_TYPES, RULE_STATUS } from "../models/ruleConstants";
import { FREE_PLAN_RULE_LIMIT } from "../shopify.server";
import RuleTypeCards from "../components/RuleTypeCards";
import { redirectWithToast } from "../utils/toastRedirect.server";

export const loader = async ({ request }) => {
  const { admin } = await authenticate.admin(request);
  const settings = await getSettings(admin);
  return json({ defaultMessages: settings.defaultMessages });
};

export const action = async ({ request }) => {
  const { admin } = await authenticate.admin(request);
  const formData = await request.formData();
  const intent = formData.get("intent");

  if (intent === "lookup") {
    // Step 2 live count: how many products match this tag/collection/product?
    // Product/collection come from the App Bridge ResourcePicker as GIDs;
    // tags are still free text (a tag has no "resource" to pick).
    const targetType = formData.get("targetType");
    const targetValue = formData.get("targetValue");
    const isGid = targetValue?.startsWith("gid://");

    if (targetType === TARGET_TYPES.TAG) {
      const response = await admin.graphql(
        `#graphql
        query CountByTag($query: String!) {
          products(first: 250, query: $query) { nodes { id } }
        }`,
        { variables: { query: `tag:'${targetValue}'` } },
      );
      const data = await response.json();
      return json({ count: data.data?.products?.nodes?.length ?? 0 });
    }

    if (targetType === TARGET_TYPES.COLLECTION) {
      const response = await admin.graphql(
        isGid
          ? `#graphql
            query CollectionById($id: ID!) {
              collection(id: $id) { title productsCount { count } }
            }`
          : `#graphql
            query CollectionByHandle($handle: String!) {
              collectionByHandle(handle: $handle) { title productsCount { count } }
            }`,
        { variables: isGid ? { id: targetValue } : { handle: targetValue } },
      );
      const data = await response.json();
      const node = isGid ? data.data?.collection : data.data?.collectionByHandle;
      return json({ count: node?.productsCount?.count ?? 0, title: node?.title });
    }

    if (targetType === TARGET_TYPES.PRODUCT) {
      const response = await admin.graphql(
        isGid
          ? `#graphql
            query ProductById($id: ID!) { product(id: $id) { id title } }`
          : `#graphql
            query ProductByHandle($handle: String!) { productByHandle(handle: $handle) { id title } }`,
        { variables: isGid ? { id: targetValue } : { handle: targetValue } },
      );
      const data = await response.json();
      const node = isGid ? data.data?.product : data.data?.productByHandle;
      return json({ count: node ? 1 : 0, title: node?.title });
    }

    return json({ count: 0 });
  }

  if (intent === "save") {
    const activeCount = await countActiveRules(admin);
    // Enforce Free plan cap server-side (brief section 08).
    // TODO once billing is wired: check the shop's real plan via
    // billing.check() instead of assuming Free whenever under the cap.
    const ruleType = formData.get("ruleType");
    const targetType = formData.get("targetType");
    const maxQuantity = formData.get("maxQuantity");
    const message = formData.get("message");
    const title = formData.get("title");

    // rules.server.js stores target_value as a product/collection GID. The
    // App Bridge ResourcePicker hands us a GID directly, so normally there's
    // nothing to resolve here. The handle-based fallback stays in place only
    // in case targetValue ever arrives as a plain handle (e.g. a future
    // non-picker entry point) — it's a no-op whenever the picker was used.
    let targetValue = formData.get("targetValue");
    const isGid = targetValue?.startsWith("gid://");
    if (targetType === TARGET_TYPES.PRODUCT && !isGid) {
      const resp = await admin.graphql(
        `#graphql
        query ResolveProduct($handle: String!) { productByHandle(handle: $handle) { id } }`,
        { variables: { handle: targetValue } },
      );
      const data = await resp.json();
      targetValue = data.data?.productByHandle?.id ?? targetValue;
    } else if (targetType === TARGET_TYPES.COLLECTION && !isGid) {
      const resp = await admin.graphql(
        `#graphql
        query ResolveCollection($handle: String!) { collectionByHandle(handle: $handle) { id } }`,
        { variables: { handle: targetValue } },
      );
      const data = await resp.json();
      targetValue = data.data?.collectionByHandle?.id ?? targetValue;
    }

    if (activeCount >= FREE_PLAN_RULE_LIMIT) {
      // Still allow saving as PAUSED so the merchant doesn't lose their work.
      await createRule(admin, {
        title,
        ruleType,
        targetType,
        targetValue,
        maxQuantity: maxQuantity ? Number(maxQuantity) : null,
        message,
        status: RULE_STATUS.PAUSED,
      });
      return redirectWithToast(
        "/app",
        `Free plan limit reached — "${title}" was saved as paused. Upgrade to activate it.`,
        { isError: true },
      );
    }

    await createRule(admin, {
      title,
      ruleType,
      targetType,
      targetValue,
      maxQuantity: maxQuantity ? Number(maxQuantity) : null,
      message,
      status: RULE_STATUS.ACTIVE,
    });
    return redirectWithToast("/app", `Rule "${title}" created and activated`);
  }

  return json({ ok: false }, { status: 400 });
};

export default function NewRule() {
  const { defaultMessages } = useLoaderData();
  const navigate = useNavigate();
  const fetcher = useFetcher();
  const saveFetcher = useFetcher();
  const [searchParams] = useSearchParams();

  // /app/templates links here with ?ruleType=&maxQuantity=&message= to
  // pre-fill steps 1 and 3 — the merchant still has to pick their own
  // products/tags in step 2, a template can't know those.
  const initialRuleType =
    searchParams.get("ruleType") === RULE_TYPES.MAX_QUANTITY ? RULE_TYPES.MAX_QUANTITY : RULE_TYPES.NO_DISCOUNT;

  const [step, setStep] = useState(1);
  const [ruleType, setRuleType] = useState(initialRuleType);
  const [targetType, setTargetType] = useState(TARGET_TYPES.TAG);
  const [targetValue, setTargetValue] = useState("");
  const [targetLabel, setTargetLabel] = useState("");
  const [maxQuantity, setMaxQuantity] = useState(searchParams.get("maxQuantity") || "2");
  const [message, setMessage] = useState(searchParams.get("message") || defaultMessages[initialRuleType]);

  const runLookup = (nextTargetType, nextTargetValue) => {
    if (!nextTargetValue) return;
    fetcher.submit(
      { intent: "lookup", targetType: nextTargetType, targetValue: nextTargetValue },
      { method: "post" },
    );
  };

  // Product/collection targeting uses App Bridge's global resourcePicker
  // (injected by <AppProvider isEmbeddedApp>, see app/routes/app.jsx) instead
  // of hand-typed handles — this only exists inside the real Shopify admin
  // iframe, so it no-ops harmlessly in any other preview context.
  const pickResource = async () => {
    if (typeof window === "undefined" || !window.shopify?.resourcePicker) return;
    const selection = await window.shopify.resourcePicker({
      type: targetType, // "product" | "collection" — matches TARGET_TYPES exactly
      action: "select",
      multiple: false,
    });
    const picked = selection?.[0];
    if (!picked) return;
    setTargetValue(picked.id);
    setTargetLabel(picked.title ?? picked.handle ?? picked.id);
    runLookup(targetType, picked.id);
  };

  const save = () => {
    saveFetcher.submit(
      {
        intent: "save",
        title: targetType === TARGET_TYPES.TAG ? targetValue : targetLabel || targetValue,
        ruleType,
        targetType,
        targetValue,
        maxQuantity,
        message,
      },
      { method: "post" },
    );
  };

  return (
    <Page title="New rule" backAction={{ content: "Rules", onAction: () => navigate("/app") }}>
      <BlockStack gap="400">
        <Card>
          <BlockStack gap="200">
            <Text as="h2" variant="headingMd">
              Step 1 — What kind of rule?
            </Text>
            <RuleTypeCards
              value={ruleType}
              onChange={(next) => {
                setRuleType(next);
                setMessage(defaultMessages[next]);
              }}
            />
            {ruleType === RULE_TYPES.MAX_QUANTITY ? (
              <TextField
                label="Maximum units per order"
                type="number"
                min={1}
                value={maxQuantity}
                onChange={setMaxQuantity}
                autoComplete="off"
              />
            ) : null}
          </BlockStack>
        </Card>

        <Card>
          <BlockStack gap="200">
            <Text as="h2" variant="headingMd">
              Step 2 — Which products?
            </Text>
            <Select
              label="Select by"
              options={[
                { label: "Tag", value: TARGET_TYPES.TAG },
                { label: "Collection", value: TARGET_TYPES.COLLECTION },
                { label: "Individual product", value: TARGET_TYPES.PRODUCT },
              ]}
              value={targetType}
              onChange={(value) => {
                setTargetType(value);
                setTargetValue("");
                setTargetLabel("");
              }}
            />
            {targetType === TARGET_TYPES.TAG ? (
              <TextField
                label="Tag"
                helpText="e.g. no-promo or heavy-item"
                value={targetValue}
                onChange={(value) => {
                  setTargetValue(value);
                  setTargetLabel("");
                  runLookup(targetType, value);
                }}
                autoComplete="off"
              />
            ) : (
              <BlockStack gap="150">
                <InlineStack gap="200" blockAlign="center">
                  <Button onClick={pickResource}>
                    {targetLabel
                      ? `Change ${targetType === TARGET_TYPES.PRODUCT ? "product" : "collection"}`
                      : `Choose ${targetType === TARGET_TYPES.PRODUCT ? "a product" : "a collection"}`}
                  </Button>
                  {targetLabel ? <Text as="span">{targetLabel}</Text> : null}
                </InlineStack>
              </BlockStack>
            )}
            {fetcher.data?.count != null ? (
              <Text tone="subdued">{fetcher.data.count} product(s) found</Text>
            ) : null}
          </BlockStack>
        </Card>

        <Card>
          <BlockStack gap="200">
            <Text as="h2" variant="headingMd">
              Step 3 — Message shown to the customer
            </Text>
            <TextField
              label="Message"
              value={message}
              onChange={setMessage}
              multiline={3}
              autoComplete="off"
              helpText="Write this in whichever language your customers read — French, Japanese, anything. It's stored and shown as-is."
            />
            {saveFetcher.data?.ok === false ? (
              <Banner tone="critical">Something went wrong saving this rule.</Banner>
            ) : null}
            <InlineStack align="end">
              <Button
                variant="primary"
                loading={saveFetcher.state !== "idle"}
                disabled={!targetValue}
                onClick={save}
              >
                Save & activate
              </Button>
            </InlineStack>
          </BlockStack>
        </Card>
      </BlockStack>
    </Page>
  );
}
