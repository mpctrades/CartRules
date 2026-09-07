import { useState } from "react";
import { json, redirect } from "@remix-run/node";
import { useFetcher, useLoaderData, useNavigate } from "@remix-run/react";
import {
  Page,
  Card,
  BlockStack,
  Button,
  TextField,
  Select,
  Text,
} from "@shopify/polaris";
import { authenticate } from "../shopify.server";
import { listRules, updateRule } from "../models/rules.server";
import { RULE_TYPES, TARGET_TYPES } from "../models/ruleConstants";
import RuleTypeCards from "../components/RuleTypeCards";

// Same 3-step shape as app.rules.new.jsx, pre-filled for editing.
export const loader = async ({ request, params }) => {
  const { admin } = await authenticate.admin(request);
  const rules = await listRules(admin);
  const gid = decodeURIComponent(params.id);
  const rule = rules.find((r) => r.id === gid);
  if (!rule) throw new Response("Rule not found", { status: 404 });
  return json({ rule });
};

export const action = async ({ request, params }) => {
  const { admin } = await authenticate.admin(request);
  const formData = await request.formData();
  const gid = decodeURIComponent(params.id);

  await updateRule(admin, gid, {
    title: formData.get("title"),
    ruleType: formData.get("ruleType"),
    targetType: formData.get("targetType"),
    targetValue: formData.get("targetValue"),
    maxQuantity: formData.get("maxQuantity") ? Number(formData.get("maxQuantity")) : null,
    message: formData.get("message"),
    status: formData.get("status"),
  });
  return redirect("/app");
};

export default function EditRule() {
  const { rule } = useLoaderData();
  const navigate = useNavigate();
  const fetcher = useFetcher();

  const [ruleType, setRuleType] = useState(rule.ruleType);
  const [targetType] = useState(rule.targetType); // target type is fixed once created in v1
  const [targetValue] = useState(rule.targetValue);
  const [maxQuantity, setMaxQuantity] = useState(String(rule.maxQuantity ?? 1));
  const [message, setMessage] = useState(rule.message);

  const save = () => {
    fetcher.submit(
      {
        title: rule.title,
        ruleType,
        targetType,
        targetValue,
        maxQuantity,
        message,
        status: rule.status,
      },
      { method: "post" },
    );
  };

  return (
    <Page title="Edit rule" backAction={{ content: "Rules", onAction: () => navigate("/app") }}>
      <BlockStack gap="400">
        <Card>
          <BlockStack gap="200">
            <Text as="h2" variant="headingMd">
              Rule type
            </Text>
            <RuleTypeCards value={ruleType} onChange={setRuleType} />
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
              Applies to
            </Text>
            <Select
              label="Target type (fixed after creation in v1 — delete and recreate to retarget)"
              disabled
              options={[
                { label: "Tag", value: TARGET_TYPES.TAG },
                { label: "Collection", value: TARGET_TYPES.COLLECTION },
                { label: "Individual product", value: TARGET_TYPES.PRODUCT },
              ]}
              value={targetType}
            />
            <TextField
              label={targetType === TARGET_TYPES.TAG ? "Tag" : "Target"}
              value={targetType === TARGET_TYPES.TAG ? targetValue : rule.title || targetValue}
              disabled
              autoComplete="off"
            />
          </BlockStack>
        </Card>

        <Card>
          <BlockStack gap="200">
            <Text as="h2" variant="headingMd">
              Message shown to the customer
            </Text>
            <TextField
              label="Message"
              value={message}
              onChange={setMessage}
              multiline={3}
              autoComplete="off"
            />
            <Button variant="primary" loading={fetcher.state !== "idle"} onClick={save}>
              Save changes
            </Button>
          </BlockStack>
        </Card>
      </BlockStack>
    </Page>
  );
}
