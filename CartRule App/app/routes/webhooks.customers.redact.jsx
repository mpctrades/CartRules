import { authenticate } from "../shopify.server";

// GDPR mandatory webhook. Fires ~10 days after a customer redact request (or
// immediately for shops with no recent order activity from that customer).
// Same reasoning as customers/data_request: CartRules never persists any
// customer-identifying data (no customer id/email/phone/order id is ever
// written anywhere by this app), so there is nothing to erase. Acknowledge
// and log for an audit trail in case this is ever questioned during App
// Store review.
export const action = async ({ request }) => {
  const { shop, topic, payload } = await authenticate.webhook(request);

  console.log(
    `Received ${topic} webhook for ${shop} — no customer data is stored by this app, nothing to redact for customer ${payload?.customer?.id}`,
  );

  return new Response();
};
