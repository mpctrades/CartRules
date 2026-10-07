// Rule lookups for requests that don't come from the embedded admin (app
// proxy, scheduler): uses the shop's stored offline session. Cached briefly
// so a busy storefront doesn't turn every reported event into Admin API calls.
import { unauthenticated } from "../shopify.server";
import { listRules } from "./rules.server";
import { isLive } from "./ruleDisplay";

const TTL_MS = 60 * 1000;
const cache = new Map(); // shop -> { at, value }

/** { rules: [{ id }], titles: [{ id, title }] } for the rules live right now, or null. */
export async function readRulesCacheForShop(shop) {
  const hit = cache.get(shop);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.value;
  let value = null;
  try {
    const { admin } = await unauthenticated.admin(shop);
    const rules = (await listRules(admin)).filter((r) => isLive(r));
    value = { rules: rules.map((r) => ({ id: r.id })), titles: rules.map((r) => ({ id: r.id, title: r.title })) };
  } catch (error) {
    console.warn("Could not load rules for storefront event", { shop, error: error?.message ?? String(error) });
  }
  cache.set(shop, { at: Date.now(), value });
  return value;
}
