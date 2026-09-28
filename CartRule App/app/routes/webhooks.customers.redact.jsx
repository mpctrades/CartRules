import { authenticate } from "../shopify.server";
import db from "../db.server";

// GDPR mandatory webhook. Fires ~10 days after a customer redact request (or
// immediately for shops with no recent order activity from that customer).
// CartRules never persists customer-identifying fields (no customer
// id/email/phone/address). The only order-linked data it holds is the
// RuleEvent activity log (order id + product/rule info, see
// app/models/events.server.js) — erase the rows for the orders Shopify lists
// in `orders_to_redact` so nothing tied to this customer's orders remains.
export const action = async ({ request }) => {
  const { shop, topic, payload } = await authenticate.webhook(request);

  const orderIds = (payload?.orders_to_redact ?? []).map((id) => String(id));
  const { count } = orderIds.length
    ? await db.ruleEvent.deleteMany({ where: { shop, orderId: { in: orderIds } } })
    : { count: 0 };

  console.log(
    `Received ${topic} webhook for ${shop} — erased ${count} rule event(s) across ${orderIds.length} order(s)`,
  );

  return new Response();
};
