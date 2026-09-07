import { authenticate } from "../shopify.server";
import { recordOrderEvents } from "../models/events.server";

// Feeds the dashboard's KPI cards, activity chart, and activity log — see
// app/models/events.server.js for exactly what's read from the order
// (never anything customer-identifying) and the documented limitations of
// what these counters can and can't observe.
export const action = async ({ request }) => {
  const { shop, topic, payload, admin } = await authenticate.webhook(request);

  console.log(`Received ${topic} webhook for ${shop}`);

  if (admin) {
    try {
      await recordOrderEvents(shop, admin, payload);
    } catch (err) {
      // Analytics must never take down order processing or retry-storm the
      // webhook — log and move on.
      console.error("Failed to record CartRules order events:", err);
    }
  }

  return new Response();
};
