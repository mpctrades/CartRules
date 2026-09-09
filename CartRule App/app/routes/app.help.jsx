import { useState } from "react";
import { json } from "@remix-run/node";
import { useLoaderData, useNavigate } from "@remix-run/react";
import {
  Page,
  Card,
  BlockStack,
  InlineStack,
  InlineGrid,
  Text,
  Button,
  TextField,
  Select,
  Icon,
  Box,
  List,
} from "@shopify/polaris";
import { ChevronDownIcon, ChevronUpIcon } from "@shopify/polaris-icons";
import { authenticate, BILLING_PLANS } from "../shopify.server";
import { getThemeEditorDeepLink } from "../utils/themeEditor";
import { Eyebrow, StepBadge } from "../components/brand";

const SUPPORT_EMAIL = "team@mpctrades.com";

// No email-sending backend exists in this app (see README) — support and
// feature-request submissions build a mailto: link instead of a fake
// "ticket submitted" confirmation, so nothing is silently lost.
export const loader = async ({ request }) => {
  const { session, billing } = await authenticate.admin(request);
  const { hasActivePayment, appSubscriptions } = await billing.check({
    plans: Object.values(BILLING_PLANS),
    isTest: process.env.NODE_ENV !== "production",
  });
  return json({
    shop: session.shop,
    currentPlan: hasActivePayment ? appSubscriptions[0]?.name : "Free",
  });
};

function AccordionItem({ question, children }) {
  const [open, setOpen] = useState(false);
  return (
    <Box paddingBlock="200" borderBlockEndWidth="025" borderColor="border">
      <Box
        as="button"
        type="button"
        onClick={() => setOpen((v) => !v)}
        width="100%"
        padding="0"
        background="bg-surface"
      >
        <InlineStack align="space-between" blockAlign="center" wrap={false}>
          <Text as="span" fontWeight="medium">
            {question}
          </Text>
          <Icon source={open ? ChevronUpIcon : ChevronDownIcon} tone="subdued" />
        </InlineStack>
      </Box>
      {open ? (
        <Box paddingBlockStart="200">
          <Text as="p" tone="subdued">
            {children}
          </Text>
        </Box>
      ) : null}
    </Box>
  );
}

const FAQ = [
  {
    q: "How does CartRules work?",
    a: "CartRules checks your configured rules when customers interact with the cart or checkout and applies the limits you've created.",
  },
  {
    q: "Can I limit only specific products?",
    a: "Yes. Rules can target selected products, collections, or product tags.",
  },
  {
    q: "Can I block discount codes for certain products?",
    a: "Yes. Create a Block Discounts rule and choose which products, collection, or tag it applies to.",
  },
  {
    q: "Can I pause a rule?",
    a: "Yes. Pausing keeps the rule's configuration but stops it from being enforced — nothing is deleted.",
  },
  {
    q: "Can customers see why something is blocked?",
    a: "Yes. Every rule has a customer-facing message that's shown when it's triggered — you can edit it any time from the rule's edit screen or from Settings' default messages.",
  },
  {
    q: "Do I need to edit my Shopify theme?",
    a: "Checkout enforcement works independently of your theme. Storefront notices (the product-page and cart-page warnings) require adding the CartRules app blocks through the Shopify theme editor — see Quick start below.",
  },
  {
    q: "Can I use CartRules in another language?",
    a: "Yes. Every rule's customer-facing message is free text, so you can write it in whichever language your customers read.",
  },
  {
    q: "What happens if two rules apply to the same product?",
    a: "CartRules applies the most restrictive matching maximum-quantity rule, so the customer only ever sees one, correct limit.",
  },
];

const TROUBLESHOOTING = [
  {
    q: "Rule isn't triggering",
    a: "Check: the rule is Active (not paused); the correct product/collection/tag is selected; a targeted tag still exists on the product; the maximum quantity or discount condition actually matches what the customer is doing in the cart.",
  },
  {
    q: "Storefront notice isn't showing",
    a: "Check: the CartRules app block has been added to your theme in the theme editor; the correct theme is published; storefront notices are enabled in Settings; the rule applies to the product currently being viewed.",
  },
  {
    q: "Discount is still applying",
    a: "Check: the Block Discounts rule is Active; the product actually matches the rule's target; the discount is a code-based discount (automatic discounts aren't distinguished from code discounts in v1 — see the app's README for this documented limitation); the rule was saved after your last change.",
  },
];

const TOPICS = [
  { label: "Setup help", value: "Setup help" },
  { label: "Rule not working", value: "Rule not working" },
  { label: "Billing", value: "Billing" },
  { label: "Feature request", value: "Feature request" },
  { label: "Bug report", value: "Bug report" },
  { label: "Other", value: "Other" },
];

function buildMailto({ subject, body }) {
  const params = new URLSearchParams({ subject, body });
  return `mailto:${SUPPORT_EMAIL}?${params.toString().replace(/\+/g, "%20")}`;
}

function ContactSupportCard({ shop, currentPlan }) {
  const [topic, setTopic] = useState(TOPICS[0].value);
  const [subject, setSubject] = useState("");
  const [message, setMessage] = useState("");

  const send = () => {
    const technicalInfo = [
      `Store: ${shop}`,
      `Plan: ${currentPlan}`,
      typeof navigator !== "undefined" ? `Browser: ${navigator.userAgent}` : null,
    ]
      .filter(Boolean)
      .join("\n");
    const body = `${message}\n\n---\nTopic: ${topic}\n${technicalInfo}`;
    window.location.href = buildMailto({ subject: subject || `CartRules — ${topic}`, body });
  };

  return (
    <Card>
      <BlockStack gap="300">
        <Text as="h2" variant="headingMd">
          Still need help?
        </Text>
        <Text as="p" tone="subdued">
          Send us a message and we'll help you with CartRules. This opens your email app with your store and plan
          already attached, so we can help faster.
        </Text>
        <Select label="Topic" options={TOPICS} value={topic} onChange={setTopic} />
        <TextField label="Subject" value={subject} onChange={setSubject} autoComplete="off" />
        <TextField label="Message" value={message} onChange={setMessage} multiline={4} autoComplete="off" />
        <InlineStack align="end">
          <Button variant="primary" onClick={send} disabled={!message.trim()}>
            Contact support
          </Button>
        </InlineStack>
      </BlockStack>
    </Card>
  );
}

function FeatureRequestCard({ shop }) {
  const [feature, setFeature] = useState("");
  const [benefit, setBenefit] = useState("");

  const send = () => {
    const body = `What feature would you like?\n${feature}\n\nHow would it help your store?\n${benefit}\n\n---\nStore: ${shop}`;
    window.location.href = buildMailto({ subject: "CartRules — Feature request", body });
  };

  return (
    <Card>
      <BlockStack gap="300">
        <Text as="h2" variant="headingMd">
          Have an idea?
        </Text>
        <Text as="p" tone="subdued">
          Help us improve CartRules — tell us what you need and we'll take it into account for a future release.
        </Text>
        <TextField label="What feature would you like?" value={feature} onChange={setFeature} multiline={2} autoComplete="off" />
        <TextField
          label="How would it help your store?"
          value={benefit}
          onChange={setBenefit}
          multiline={2}
          autoComplete="off"
        />
        <InlineStack align="end">
          <Button onClick={send} disabled={!feature.trim()}>
            Request a feature
          </Button>
        </InlineStack>
      </BlockStack>
    </Card>
  );
}

export default function Help() {
  const { shop, currentPlan } = useLoaderData();
  const navigate = useNavigate();

  return (
    <Page title="Help & support" subtitle="Everything you need to get CartRules working properly.">
      <BlockStack gap="400">
        <Eyebrow>Help &amp; support</Eyebrow>
        <Card>
          <BlockStack gap="300">
            <Text as="h2" variant="headingMd">
              Quick start
            </Text>
            <InlineGrid columns={{ xs: 1, sm: 3 }} gap="300">
              <Box borderWidth="025" borderColor="border" borderRadius="200" padding="300">
                <BlockStack gap="150">
                  <InlineStack gap="200" blockAlign="center">
                    <StepBadge n={1} />
                    <Text as="h3" variant="headingSm">
                      Create your first rule
                    </Text>
                  </InlineStack>
                  <Text as="p" tone="subdued">
                    Learn how to create and activate a CartRules rule.
                  </Text>
                  <Button onClick={() => navigate("/app/rules/new")}>Create a rule</Button>
                </BlockStack>
              </Box>
              <Box borderWidth="025" borderColor="border" borderRadius="200" padding="300">
                <BlockStack gap="150">
                  <InlineStack gap="200" blockAlign="center">
                    <StepBadge n={2} />
                    <Text as="h3" variant="headingSm">
                      Add storefront messages
                    </Text>
                  </InlineStack>
                  <Text as="p" tone="subdued">
                    Show customers rule information on product and cart pages.
                  </Text>
                  <List type="number">
                    <List.Item>
                      Click "Open theme editor" below — it opens with the CartRules product-page block already added.
                    </List.Item>
                    <List.Item>Click Save (top right) to publish it live.</List.Item>
                    <List.Item>
                      Optional: on your cart page template, click Add block → Apps → CartRules Cart quantity guard.
                    </List.Item>
                  </List>
                  <Button onClick={() => window.open(getThemeEditorDeepLink(shop), "_blank")}>
                    Open theme editor
                  </Button>
                </BlockStack>
              </Box>
              <Box borderWidth="025" borderColor="border" borderRadius="200" padding="300">
                <BlockStack gap="150">
                  <InlineStack gap="200" blockAlign="center">
                    <StepBadge n={3} />
                    <Text as="h3" variant="headingSm">
                      Test your rules
                    </Text>
                  </InlineStack>
                  <Text as="p" tone="subdued">
                    Make sure a rule works before customers use it.
                  </Text>
                  <Button onClick={() => navigate("/app/rules")}>Test a rule</Button>
                </BlockStack>
              </Box>
            </InlineGrid>
          </BlockStack>
        </Card>

        <Card>
          <BlockStack gap="200">
            <Text as="h2" variant="headingMd">
              Frequently asked questions
            </Text>
            <BlockStack gap="0">
              {FAQ.map((item) => (
                <AccordionItem key={item.q} question={item.q}>
                  {item.a}
                </AccordionItem>
              ))}
            </BlockStack>
          </BlockStack>
        </Card>

        <Card>
          <BlockStack gap="200">
            <Text as="h2" variant="headingMd">
              Troubleshooting
            </Text>
            <BlockStack gap="0">
              {TROUBLESHOOTING.map((item) => (
                <AccordionItem key={item.q} question={item.q}>
                  {item.a}
                </AccordionItem>
              ))}
            </BlockStack>
          </BlockStack>
        </Card>

        <ContactSupportCard shop={shop} currentPlan={currentPlan} />
        <FeatureRequestCard shop={shop} />
      </BlockStack>
    </Page>
  );
}
