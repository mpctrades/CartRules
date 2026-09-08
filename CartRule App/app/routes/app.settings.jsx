import { useState } from "react";
import { json } from "@remix-run/node";
import { useFetcher, useLoaderData } from "@remix-run/react";
import { Page, Card, BlockStack, InlineStack, Text, Checkbox, TextField, Button } from "@shopify/polaris";
import { authenticate } from "../shopify.server";
import { getSettings, setSettings } from "../models/settings.server";
import { syncRulesCache } from "../models/rules.server";
import { RULE_TYPES } from "../models/ruleConstants";
import { useActionToast } from "../utils/useActionToast";
import { Eyebrow } from "../components/brand";

// Settings live in the same shop metafield pattern as everything else in
// this app (see getSetupFlags/setSetupFlag in rules.server.js) — no new
// database table. Saving here re-runs syncRulesCache so the checkout
// Function and the storefront Liquid blocks pick up the new flags
// immediately, not on the next unrelated rule edit.
export const loader = async ({ request }) => {
  const { admin } = await authenticate.admin(request);
  const settings = await getSettings(admin);
  return json({ settings });
};

export const action = async ({ request }) => {
  const { admin } = await authenticate.admin(request);
  const formData = await request.formData();

  await setSettings(admin, {
    protectionEnabled: formData.get("protectionEnabled") === "true",
    productNoticesEnabled: formData.get("productNoticesEnabled") === "true",
    cartNoticesEnabled: formData.get("cartNoticesEnabled") === "true",
    defaultMessages: {
      [RULE_TYPES.NO_DISCOUNT]: formData.get("message_no_discount") ?? "",
      [RULE_TYPES.MAX_QUANTITY]: formData.get("message_max_quantity") ?? "",
    },
  });
  await syncRulesCache(admin);

  return json({ ok: true, toast: "Settings saved" });
};

export default function Settings() {
  const { settings } = useLoaderData();
  const fetcher = useFetcher();

  const [protectionEnabled, setProtectionEnabled] = useState(settings.protectionEnabled);
  const [productNoticesEnabled, setProductNoticesEnabled] = useState(settings.productNoticesEnabled);
  const [cartNoticesEnabled, setCartNoticesEnabled] = useState(settings.cartNoticesEnabled);
  const [messageNoDiscount, setMessageNoDiscount] = useState(settings.defaultMessages[RULE_TYPES.NO_DISCOUNT]);
  const [messageMaxQuantity, setMessageMaxQuantity] = useState(settings.defaultMessages[RULE_TYPES.MAX_QUANTITY]);

  useActionToast(fetcher);

  const save = () => {
    fetcher.submit(
      {
        protectionEnabled: String(protectionEnabled),
        productNoticesEnabled: String(productNoticesEnabled),
        cartNoticesEnabled: String(cartNoticesEnabled),
        message_no_discount: messageNoDiscount,
        message_max_quantity: messageMaxQuantity,
      },
      { method: "post" },
    );
  };

  return (
    <Page title="Settings" subtitle="Control how CartRules enforces and messages, store-wide.">
      <BlockStack gap="400">
        <Eyebrow>Settings</Eyebrow>
        <Card>
          <BlockStack gap="300">
            <Text as="h2" variant="headingMd">
              App status
            </Text>
            <Checkbox
              label="CartRules protection is on"
              helpText="Turning this off stops every rule from being enforced at checkout, immediately — rules and their configuration are kept, nothing is deleted."
              checked={protectionEnabled}
              onChange={setProtectionEnabled}
            />
          </BlockStack>
        </Card>

        <Card>
          <BlockStack gap="300">
            <Text as="h2" variant="headingMd">
              Storefront notices
            </Text>
            <Text as="p" tone="subdued">
              These only apply if you've added the CartRules blocks to your theme (see Help &amp; support).
            </Text>
            <Checkbox
              label="Show notices on product pages"
              checked={productNoticesEnabled}
              onChange={setProductNoticesEnabled}
            />
            <Checkbox
              label="Show notices on the cart page"
              checked={cartNoticesEnabled}
              onChange={setCartNoticesEnabled}
            />
          </BlockStack>
        </Card>

        <Card>
          <BlockStack gap="300">
            <Text as="h2" variant="headingMd">
              Default customer messages
            </Text>
            <Text as="p" tone="subdued">
              Used to pre-fill new rules — editing here doesn't change messages on rules you've already created.
            </Text>
            <TextField
              label="Maximum quantity message"
              value={messageMaxQuantity}
              onChange={setMessageMaxQuantity}
              multiline={2}
              autoComplete="off"
            />
            <TextField
              label="Block discounts message"
              value={messageNoDiscount}
              onChange={setMessageNoDiscount}
              multiline={2}
              autoComplete="off"
            />
          </BlockStack>
        </Card>

        <Card>
          <BlockStack gap="200">
            <Text as="h2" variant="headingMd">
              Rule behavior
            </Text>
            <Text as="p" tone="subdued">
              When more than one active maximum-quantity rule matches the same product, CartRules always applies the
              most restrictive limit — the customer only ever sees one, correct cap.
            </Text>
          </BlockStack>
        </Card>

        <InlineStack align="end">
          <Button variant="primary" loading={fetcher.state !== "idle"} onClick={save}>
            Save changes
          </Button>
        </InlineStack>
      </BlockStack>
    </Page>
  );
}
