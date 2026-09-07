import { json } from "@remix-run/node";
import { useLoaderData, useSubmit } from "@remix-run/react";
import { Page, Card, BlockStack, InlineGrid, InlineStack, Text, Button, Badge, List } from "@shopify/polaris";
import { authenticate, BILLING_PLANS, FREE_PLAN_RULE_LIMIT } from "../shopify.server";
import { countActiveRules } from "../models/rules.server";
import { getMonthlyEventCount } from "../models/events.server";

export const loader = async ({ request }) => {
  const { admin, session, billing } = await authenticate.admin(request);
  // `check` doesn't throw when unsubscribed — it just reports isTest/appSubscriptions.
  const { hasActivePayment, appSubscriptions } = await billing.check({
    plans: Object.values(BILLING_PLANS),
    isTest: process.env.NODE_ENV !== "production",
  });
  const currentPlan = hasActivePayment ? appSubscriptions[0]?.name : "Free";
  const [activeRules, monthlyEvents] = await Promise.all([
    countActiveRules(admin),
    getMonthlyEventCount(session.shop),
  ]);
  return json({
    currentPlan,
    activeRules,
    freeLimit: FREE_PLAN_RULE_LIMIT,
    isFreePlan: !hasActivePayment,
    monthlyEvents,
  });
};

export const action = async ({ request }) => {
  const { billing } = await authenticate.admin(request);
  const formData = await request.formData();
  const plan = formData.get("plan");

  return billing.request({
    plan,
    isTest: process.env.NODE_ENV !== "production",
    // Shopify redirects the merchant to approve the charge, then back here.
    returnUrl: `${process.env.SHOPIFY_APP_URL}/app/billing`,
  });
};

// Plan names/prices duplicated as literals (not imported from shopify.server)
// on purpose: this array is also used by the client-rendered component below,
// and shopify.server is a server-only module — importing it for a value the
// client bundle also needs breaks Remix's client/server code splitting (see
// the "Server-only module referenced by client" build error this fixed).
// Keep these in sync with BILLING_PLANS / FREE_PLAN_RULE_LIMIT in shopify.server.js.
const PLAN_COPY = [
  {
    key: "Free",
    price: "0 USD",
    features: ["3 active rules", "Both rule types", "Default messages"],
  },
  {
    key: "Growth",
    price: "4.99 USD/mo",
    features: ["Unlimited rules", "Custom messages (any language)", "Tag & collection targeting", "Email support"],
  },
  {
    key: "Pro",
    price: "9.99 USD/mo",
    features: ["Everything in Growth", "Product-page notices", "Priority support"],
  },
];

export default function Billing() {
  const { currentPlan, activeRules, freeLimit, isFreePlan, monthlyEvents } = useLoaderData();
  const submit = useSubmit();

  return (
    <Page title="Plan & billing">
      <BlockStack gap="400">
        <Card>
          <InlineGrid columns={{ xs: 1, sm: 3 }} gap="400">
            <BlockStack gap="050">
              <Text as="span" tone="subdued">
                Current plan
              </Text>
              <Text as="p" variant="headingLg">
                {currentPlan}
              </Text>
            </BlockStack>
            <BlockStack gap="050">
              <Text as="span" tone="subdued">
                Active rules
              </Text>
              <Text as="p" variant="headingLg">
                {activeRules} / {isFreePlan ? freeLimit : "Unlimited"}
              </Text>
            </BlockStack>
            <BlockStack gap="050">
              <Text as="span" tone="subdued">
                Usage this month
              </Text>
              <Text as="p" variant="headingLg">
                {monthlyEvents} rule event{monthlyEvents === 1 ? "" : "s"}
              </Text>
            </BlockStack>
          </InlineGrid>
        </Card>

        <InlineGrid columns={{ xs: 1, md: 3 }} gap="400">
          {PLAN_COPY.map((plan) => (
            <Card key={plan.key}>
              <BlockStack gap="200">
                <InlineStack align="space-between" blockAlign="center">
                  <Text as="h2" variant="headingMd">
                    {plan.key}
                  </Text>
                  <InlineStack gap="100">
                    {plan.key === "Growth" ? <Badge tone="info">Recommended</Badge> : null}
                    {currentPlan === plan.key ? <Badge tone="success">Current plan</Badge> : null}
                  </InlineStack>
                </InlineStack>
                <Text as="p" variant="headingLg">
                  {plan.price}
                </Text>
                <List>
                  {plan.features.map((f) => (
                    <List.Item key={f}>{f}</List.Item>
                  ))}
                </List>
                {plan.key !== "Free" && currentPlan !== plan.key ? (
                  <Button
                    variant="primary"
                    onClick={() => submit({ plan: plan.key }, { method: "post" })}
                  >
                    Upgrade to {plan.key}
                  </Button>
                ) : null}
              </BlockStack>
            </Card>
          ))}
        </InlineGrid>
      </BlockStack>
    </Page>
  );
}
