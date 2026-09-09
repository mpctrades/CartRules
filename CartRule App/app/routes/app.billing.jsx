import { json } from "@remix-run/node";
import { useActionData, useLoaderData, useSubmit } from "@remix-run/react";
import { Page, Card, BlockStack, InlineGrid, InlineStack, Text, Button, Badge, List, Banner } from "@shopify/polaris";
import { authenticate, BILLING_PLANS, FREE_PLAN_RULE_LIMIT } from "../shopify.server";
import { countActiveRules } from "../models/rules.server";
import { getMonthlyEventCount } from "../models/events.server";
import { isDevelopmentStore } from "../models/shop.server";
import { Eyebrow, BrandPill, BRAND_ORANGE } from "../components/brand";

export const loader = async ({ request }) => {
  const { admin, session, billing } = await authenticate.admin(request);
  const isTest = await isDevelopmentStore(admin, session.shop);
  // `check` doesn't throw when unsubscribed — it just reports isTest/appSubscriptions.
  const { hasActivePayment, appSubscriptions } = await billing.check({
    plans: Object.values(BILLING_PLANS),
    isTest,
  });
  const currentPlan = hasActivePayment ? appSubscriptions[0]?.name : "Free";
  const currentSubscriptionId = hasActivePayment ? appSubscriptions[0]?.id : null;
  const [activeRules, monthlyEvents] = await Promise.all([
    countActiveRules(admin),
    getMonthlyEventCount(session.shop),
  ]);
  return json({
    currentPlan,
    currentSubscriptionId,
    activeRules,
    freeLimit: FREE_PLAN_RULE_LIMIT,
    isFreePlan: !hasActivePayment,
    monthlyEvents,
  });
};

export const action = async ({ request }) => {
  const { admin, session, billing } = await authenticate.admin(request);
  const formData = await request.formData();
  const plan = formData.get("plan");
  const isTest = await isDevelopmentStore(admin, session.shop);

  // Downgrading to Free means cancelling the active subscription outright —
  // Shopify billing has no $0 plan, so there's nothing to "request" here.
  if (plan === "Free") {
    const subscriptionId = formData.get("subscriptionId");
    if (subscriptionId) {
      await billing.cancel({ subscriptionId, isTest, prorate: true });
    }
    return json({ ok: true });
  }

  try {
    // billing.request() never returns on success — it always throws: either
    // the out-of-iframe redirect to Shopify's charge confirmation screen, or
    // (for token-exchange requests) a 401 Response that App Bridge
    // intercepts to do that redirect itself. A thrown Response here is
    // expected control flow; only a genuine failure (e.g. Shopify rejecting
    // the charge) reaches the catch block below as a real Error.
    return await billing.request({
      plan,
      isTest,
      // Shopify redirects the merchant to approve the charge, then back here.
      returnUrl: `${process.env.SHOPIFY_APP_URL}/app/billing`,
    });
  } catch (error) {
    if (error instanceof Response) throw error;
    console.error("Billing request failed", { shop: session.shop, plan, isTest, error });
    return json(
      {
        ok: false,
        billingError:
          "We couldn't start that upgrade. Please try again in a moment — if it keeps happening, contact support.",
      },
      { status: 200 },
    );
  }
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
  const { currentPlan, currentSubscriptionId, activeRules, freeLimit, isFreePlan, monthlyEvents } =
    useLoaderData();
  const actionData = useActionData();
  const submit = useSubmit();

  const usagePct = isFreePlan ? Math.min(100, (activeRules / freeLimit) * 100) : 100;

  return (
    <Page title="Plan & billing">
      <BlockStack gap="400">
        <Eyebrow>Plans &amp; billing</Eyebrow>
        {actionData?.billingError ? <Banner tone="critical">{actionData.billingError}</Banner> : null}
        <Card>
          <BlockStack gap="400">
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
            {isFreePlan ? (
              <div
                style={{
                  height: 6,
                  borderRadius: 3,
                  background: "var(--p-color-bg-surface-secondary)",
                  overflow: "hidden",
                }}
              >
                <div
                  style={{
                    height: "100%",
                    width: `${usagePct}%`,
                    borderRadius: 3,
                    background: `linear-gradient(90deg, ${BRAND_ORANGE}, #ffb280)`,
                  }}
                />
              </div>
            ) : null}
          </BlockStack>
        </Card>

        <InlineGrid columns={{ xs: 1, md: 3 }} gap="400">
          {PLAN_COPY.map((plan) => {
            const featured = plan.key === "Growth";
            return (
              <div
                key={plan.key}
                style={
                  featured
                    ? {
                        border: `2px solid ${BRAND_ORANGE}`,
                        borderRadius: "var(--p-border-radius-300)",
                        boxShadow: "0 4px 14px rgba(255, 90, 31, 0.18)",
                      }
                    : undefined
                }
              >
                <Card>
                  <BlockStack gap="200">
                    <InlineStack align="space-between" blockAlign="center">
                      <Text as="h2" variant="headingMd">
                        {plan.key}
                      </Text>
                      <InlineStack gap="100">
                        {featured ? <BrandPill>Most popular</BrandPill> : null}
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
                    {plan.key === "Free" && !isFreePlan ? (
                      <Button
                        onClick={() =>
                          submit(
                            { plan: "Free", subscriptionId: currentSubscriptionId ?? "" },
                            { method: "post" },
                          )
                        }
                      >
                        Downgrade to Free
                      </Button>
                    ) : null}
                  </BlockStack>
                </Card>
              </div>
            );
          })}
        </InlineGrid>
      </BlockStack>
    </Page>
  );
}
