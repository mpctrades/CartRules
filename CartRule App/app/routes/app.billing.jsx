import { json } from "@remix-run/node";
import { useActionData, useLoaderData, useNavigation, useSubmit } from "@remix-run/react";
import { BlockStack, InlineStack, Text, Button, Badge, Banner, Icon } from "@shopify/polaris";
import { CheckIcon } from "@shopify/polaris-icons";
import { BILLING_PLANS, FREE_PLAN_RULE_LIMIT } from "../shopify.server";
import { loadAppContext } from "../models/context.server";
import { enforcePlanLimits } from "../models/plan.server";
import { listRules } from "../models/rules.server";
import { getMonthlyEventCount } from "../models/events.server";
import { RULE_STATUS, PLAN_RANK } from "../models/ruleConstants";
import { AppPage, Box, ProgressLine, formatNumber } from "../components/ui";

export const loader = async ({ request }) => {
  const { admin, shop, plan, rules: loaded } = await loadAppContext(request, { settings: false });
  // A subscription can also change or end outside this page (cancelled,
  // declined, frozen) — bring the shop's rules within the current plan.
  let pausedCount = 0;
  try {
    pausedCount = await enforcePlanLimits(admin, plan.name);
  } catch (error) {
    console.error("Failed to enforce plan limits", { shop, error });
  }
  // Re-read after enforcement so the summary is accurate.
  const rules = pausedCount ? await listRules(admin) : loaded;
  const monthlyEvents = await getMonthlyEventCount(shop);
  return json({
    currentPlan: plan.name,
    currentSubscriptionId: plan.subscriptionId,
    activeRules: rules.filter((r) => r.status === RULE_STATUS.ACTIVE).length,
    freeLimit: FREE_PLAN_RULE_LIMIT,
    monthlyEvents,
    pausedCount,
  });
};

export const action = async ({ request }) => {
  const { admin, session, billing, plan: current } = await loadAppContext(request, { rules: false, settings: false });
  const formData = await request.formData();
  const plan = formData.get("plan");
  const isTest = current.isTest;

  // Downgrading to Free means cancelling the active subscription outright —
  // Shopify billing has no $0 plan, so there's nothing to "request" here.
  if (plan === "Free") {
    const subscriptionId = formData.get("subscriptionId");
    if (subscriptionId) {
      try {
        await billing.cancel({ subscriptionId, isTest, prorate: true });
      } catch (error) {
        if (error instanceof Response) throw error;
        console.error("Billing cancel failed", { shop: session.shop, subscriptionId, error });
        return json({
          ok: false,
          billingError:
            "We couldn't switch you to the Free plan. Please try again in a moment — if it keeps happening, contact support.",
        });
      }
    }
    // Pause rules the Free plan can't run (paid features, or beyond the
    // active-rule cap) so the downgrade doesn't keep them enforced.
    let pausedCount = 0;
    try {
      pausedCount = await enforcePlanLimits(admin, "Free");
    } catch (error) {
      console.error("Failed to enforce Free plan limits", { shop: session.shop, error });
    }
    return json({ ok: true, downgraded: true, pausedCount });
  }

  if (!Object.values(BILLING_PLANS).includes(plan)) {
    return json({ ok: false, billingError: "That plan isn't available." }, { status: 400 });
  }

  try {
    // billing.request() never returns on success — it always throws: either
    // the out-of-iframe redirect to Shopify's charge confirmation screen, or
    // (for token-exchange requests) a 401 Response that App Bridge
    // intercepts to do that redirect itself. A thrown Response is expected
    // control flow; only a genuine failure reaches the catch block.
    //
    // returnUrl must stay inside the embedded admin context
    // (admin.shopify.com/store/<shop>/apps/<api-key>/...), NOT the bare app
    // domain — a bare app URL was an App Store review rejection: after
    // approving the charge the app had no shop/host context and fell back to
    // the login page.
    const cleanShopName = session.shop.replace(".myshopify.com", "");
    return await billing.request({
      plan,
      isTest,
      returnUrl: `https://admin.shopify.com/store/${cleanShopName}/apps/${process.env.SHOPIFY_API_KEY}/app/billing`,
    });
  } catch (error) {
    if (error instanceof Response) throw error;
    console.error("Billing request failed", { shop: session.shop, plan, isTest, error });
    return json({
      ok: false,
      billingError: "We couldn't start that upgrade. Please try again in a moment — if it keeps happening, contact support.",
    });
  }
};

// Plan names/prices are literals (not imported from shopify.server, which is
// server-only and can't be bundled for the client). Keep them in sync with
// BILLING_PLANS / FREE_PLAN_RULE_LIMIT in shopify.server.js, and the feature
// lists in sync with the gating in app/models/plan.server.js (lockedFeatures)
// and events.server.js (HISTORY_DAYS). Never list a feature the code doesn't
// actually deliver on that plan (App Store requirement 1.1.4). Storefront
// notices are on every plan, so they aren't listed as a paid feature.
const PLAN_COPY = [
  {
    key: "Free",
    price: "$0",
    period: "",
    tagline: "For trying CartRules on a few products.",
    features: [
      "3 active rules",
      "Quantity rules (maximum & minimum)",
      "Discount rules (block discount codes)",
      "Basic targeting: all products, products, variants",
      "7-day activity history",
    ],
  },
  {
    key: "Growth",
    price: "$4.99",
    period: "/month",
    tagline: "Everything most stores need.",
    features: [
      "Unlimited rules",
      "All standard rule types: cart value, multiples, max cart items, combinations",
      "Collection, tag, vendor & product type targeting",
      "Custom messages",
      "Scheduling",
      "90-day analytics",
      "Email support",
    ],
  },
  {
    key: "Pro",
    price: "$9.99",
    period: "/month",
    tagline: "For wholesale and advanced setups.",
    features: [
      "Everything in Growth",
      "Customer-level limits (logged-in, guests, tags, B2B)",
      "Advanced conditions & market targeting",
      "Rule priority",
      "Advanced analytics: 365-day history",
      "Priority support",
    ],
  },
];

function Feature({ children }) {
  return (
    <InlineStack gap="200" wrap={false} blockAlign="start">
      <span style={{ flexShrink: 0, color: "var(--p-color-icon-secondary)" }}>
        <Icon source={CheckIcon} tone="subdued" />
      </span>
      <Text as="span">{children}</Text>
    </InlineStack>
  );
}

function SummaryStat({ label, value, children }) {
  return (
    <div className="cr-card">
      <div className="cr-kpi-label">{label}</div>
      <div className="cr-kpi-value" style={{ fontSize: 26 }}>
        {value}
      </div>
      {children}
    </div>
  );
}

export default function Billing() {
  const { currentPlan, currentSubscriptionId, activeRules, freeLimit, monthlyEvents, pausedCount } = useLoaderData();
  const actionData = useActionData();
  const submit = useSubmit();
  const navigation = useNavigation();
  const pendingPlan = navigation.state !== "idle" ? navigation.formData?.get("plan") : null;
  const isFree = currentPlan === "Free";
  const paused = actionData?.pausedCount ?? pausedCount;

  return (
    <AppPage title="Plan & billing" subtitle="Simple monthly pricing. Change or cancel any time — billed through Shopify.">
      {actionData?.billingError ? <Banner tone="critical">{actionData.billingError}</Banner> : null}
      {actionData?.downgraded ? (
        <Banner tone="info" title="You're now on the Free plan">
          {paused
            ? `${paused} rule${paused === 1 ? " was" : "s were"} paused because the Free plan doesn't include ${
                paused === 1 ? "it" : "them"
              } (paid features, or more than ${freeLimit} active rules). Your most recently updated rules stay active.`
            : "All your active rules fit the Free plan."}
        </Banner>
      ) : paused ? (
        <Banner tone="warning" title={`${paused} rule${paused === 1 ? " was" : "s were"} paused`}>
          Your {currentPlan} plan doesn&apos;t include some features those rules used. Upgrade to turn them back on, or
          edit them on the Rules page.
        </Banner>
      ) : null}

      <div className="cr-grid cr-grid--3">
        <SummaryStat label="Current plan" value={currentPlan} />
        <SummaryStat label="Active rules" value={`${activeRules} / ${isFree ? freeLimit : "Unlimited"}`}>
          {isFree ? <ProgressLine value={Math.min(activeRules, freeLimit)} max={freeLimit} /> : null}
        </SummaryStat>
        <SummaryStat label="Monthly rule events" value={formatNumber(monthlyEvents)}>
          <span className="cr-muted">Storefront rule hits this month. Not billed — every plan is a flat price.</span>
        </SummaryStat>
      </div>

      <div className="cr-grid cr-grid--3">
        {PLAN_COPY.map((plan) => {
          const featured = plan.key === "Growth";
          const isCurrent = currentPlan === plan.key;
          const upgrade = PLAN_RANK[plan.key] > PLAN_RANK[currentPlan];
          return (
            <section key={plan.key} className={`cr-card cr-pricing-card${featured ? " cr-card--accent" : ""}`}>
              <BlockStack gap="100">
                <InlineStack align="space-between" blockAlign="center" gap="200">
                  <Text as="h2" variant="headingMd">
                    {plan.key}
                  </Text>
                  <InlineStack gap="100">
                    {featured ? <span className="cr-ribbon">MOST POPULAR</span> : null}
                    {isCurrent ? <Badge tone="success">Current plan</Badge> : null}
                  </InlineStack>
                </InlineStack>
                <div>
                  <span className="cr-price">{plan.price}</span>
                  <span className="cr-muted">{plan.period}</span>
                </div>
                <span className="cr-muted">{plan.tagline}</span>
              </BlockStack>
              <BlockStack gap="200">
                {plan.features.map((f) => (
                  <Feature key={f}>{f}</Feature>
                ))}
              </BlockStack>
              <div style={{ marginTop: "auto" }}>
                {isCurrent ? (
                  <Button fullWidth disabled>
                    Your current plan
                  </Button>
                ) : plan.key === "Free" ? (
                  <Button
                    fullWidth
                    loading={pendingPlan === "Free"}
                    onClick={() =>
                      submit({ plan: "Free", subscriptionId: currentSubscriptionId ?? "" }, { method: "post" })
                    }
                  >
                    Downgrade to Free
                  </Button>
                ) : (
                  <Button
                    fullWidth
                    variant={featured || upgrade ? "primary" : "secondary"}
                    loading={pendingPlan === plan.key}
                    onClick={() => submit({ plan: plan.key }, { method: "post" })}
                  >
                    {upgrade ? "Upgrade" : "Switch"} to {plan.key}
                  </Button>
                )}
              </div>
            </section>
          );
        })}
      </div>

      <Box>
        <Text as="p" tone="subdued">
          Prices in USD, billed every 30 days through your Shopify invoice. Downgrading pauses rules that use features
          your new plan doesn&apos;t include — they&apos;re kept, not deleted, and you can turn them back on after
          upgrading.
        </Text>
      </Box>
    </AppPage>
  );
}
