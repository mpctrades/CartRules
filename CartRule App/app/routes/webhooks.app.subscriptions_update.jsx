import { authenticate, BILLING_PLANS, FREE_PLAN_RULE_LIMIT } from "../shopify.server";
import { enforceFreePlanLimitIfUnpaid } from "../models/rules.server";

// A subscription can end outside the app (cancelled from the admin, declined
// after a plan switch, frozen for non-payment). Without this, every active
// rule would stay enforced on Free until the merchant opened Plan & billing.
// Switching Growth <-> Pro cancels the old subscription too, so the shop's
// current subscriptions are re-read rather than trusting this payload.
export const action = async ({ request }) => {
  let context;
  try {
    context = await authenticate.webhook(request);
  } catch (error) {
    // Bad signatures and other request errors stay 4xx.
    if (error instanceof Response && error.status < 500) throw error;
    // The signature was valid (it's checked first), but the shop's offline
    // token can't be refreshed — typically the "cancelled" event Shopify sends
    // at uninstall. The payload doesn't name the shop, so the session can't be
    // safely dropped here; there is nothing to enforce without a token anyway.
    console.warn("Skipping app_subscriptions/update: offline token unavailable", {
      shop: request.headers.get("X-Shopify-Shop-Domain"),
    });
    return new Response();
  }
  const { shop, topic, admin } = context;
  console.log(`Received ${topic} webhook for ${shop}`);

  // No offline session (e.g. already uninstalled) means nothing to enforce.
  if (!admin) return new Response();

  // Respond right away — Shopify retries webhooks that don't answer within
  // 5 seconds, and pausing rules can take several Admin API calls.
  enforceFreePlanLimitIfUnpaid(admin, FREE_PLAN_RULE_LIMIT, Object.values(BILLING_PLANS)).catch((error) => {
    console.error("Failed to enforce Free plan limit after subscription change", { shop, error });
  });

  return new Response();
};
