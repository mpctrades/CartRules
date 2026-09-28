import { authenticate } from "../shopify.server";

// GDPR mandatory webhook. Shopify calls this when a customer asks a merchant
// what data an app holds about them. CartRules stores no customer personal
// data: rules are shop-level configuration stored as Shopify
// metaobjects/metafields, and the RuleEvent activity log only holds order
// ids + product/rule info (no name, email, address or customer id). The
// merchant already has those orders in their own admin, so there is nothing
// customer-identifying to return; acknowledging the webhook is correct.
export const action = async ({ request }) => {
  const { shop, topic, payload } = await authenticate.webhook(request);

  console.log(
    `Received ${topic} webhook for ${shop} — no customer data is stored by this app, nothing to provide for customer ${payload?.customer?.id}`,
  );

  return new Response();
};
