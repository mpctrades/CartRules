import { authenticate } from "../shopify.server";
import db from "../db.server";

// GDPR mandatory webhook. Fires 48 hours after a shop uninstalls the app —
// the app must erase any shop data it still holds outside of the shop's own
// store. CartRules' actual business data (rules) lives in the shop's own
// metaobjects/metafields, which Shopify erases as part of the shop's data
// lifecycle — not something this app needs to (or can) act on. The only
// thing we hold ourselves is the OAuth session row, already deleted by the
// app/uninstalled handler; this is just a defensive second pass in case that
// ever failed or the merchant reinstalled and uninstalled again quickly.
export const action = async ({ request }) => {
  const { shop, topic } = await authenticate.webhook(request);

  console.log(`Received ${topic} webhook for ${shop} — clearing any remaining session rows`);

  await db.session.deleteMany({ where: { shop } });

  return new Response();
};
