import { authenticate } from "../shopify.server";
import db from "../db.server";

// GDPR mandatory webhook. Fires 48 hours after a shop uninstalls the app —
// the app must erase any shop data it still holds outside of the shop's own
// store. CartRules' actual business data (rules) lives in the shop's own
// metaobjects/metafields, which Shopify erases as part of the shop's data
// lifecycle — not something this app needs to (or can) act on. The only
// things we hold ourselves are the OAuth session rows (already deleted by the
// app/uninstalled handler — this is a defensive second pass) and the
// RuleEvent activity history (app/models/events.server.js), which must be
// erased here too.
export const action = async ({ request }) => {
  const { shop, topic } = await authenticate.webhook(request);

  console.log(`Received ${topic} webhook for ${shop} — erasing sessions and rule activity history`);

  await db.$transaction([
    db.ruleEvent.deleteMany({ where: { shop } }),
    db.session.deleteMany({ where: { shop } }),
  ]);

  return new Response();
};
