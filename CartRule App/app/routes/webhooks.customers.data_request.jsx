import { authenticate } from "../shopify.server";

// GDPR mandatory webhook. Shopify calls this when a customer asks a merchant
// what data an app holds about them. We hold none: CartRules never stores
// customer names/emails/orders anywhere — rules are shop-level configuration
// (product/collection/tag targeting + a merchant-written message), stored as
// Shopify metaobjects/metafields, not customer records. So there is nothing
// to gather or return here; acknowledging the webhook is the correct response.
export const action = async ({ request }) => {
  const { shop, topic, payload } = await authenticate.webhook(request);

  console.log(
    `Received ${topic} webhook for ${shop} — no customer data is stored by this app, nothing to provide for customer ${payload?.customer?.id}`,
  );

  return new Response();
};
