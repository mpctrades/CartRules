import { json } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import { recordEvents, hashCartKey, EVENT_TYPE_BY_RULE_TYPE } from "../models/events.server";
import { readRulesCacheForShop } from "../models/storefront.server";

// Storefront activity endpoint. The theme blocks (extensions/cartrules-notice)
// POST here through the app proxy (/apps/cartrules/events) when a shopper
// hits a rule — e.g. the cart guard lowered a quantity, or a discount code
// is on an item a rule protects. Shopify signs every proxied request;
// authenticate.public.appProxy rejects anything unsigned.
//
// Only rule ids, product ids/titles and quantities are accepted — never
// customer data. Rule titles come from our own cache, not the request.

const WINDOW_MS = 60 * 1000;
const MAX_PER_WINDOW = 30; // per shop + cart, generous for real shoppers
const buckets = new Map();

function allow(key) {
  const now = Date.now();
  const b = buckets.get(key);
  if (!b || now - b.start > WINDOW_MS) {
    buckets.set(key, { start: now, count: 1 });
    if (buckets.size > 5000) {
      for (const [k, v] of buckets) if (now - v.start > WINDOW_MS) buckets.delete(k);
    }
    return true;
  }
  b.count += 1;
  return b.count <= MAX_PER_WINDOW;
}

export const action = async ({ request }) => {
  let shop;
  try {
    ({ session: { shop } = {} } = await authenticate.public.appProxy(request));
  } catch (error) {
    if (error instanceof Response) return new Response(null, { status: 401 });
    throw error;
  }
  shop = shop ?? new URL(request.url).searchParams.get("shop");
  if (!shop) return new Response(null, { status: 401 });

  let body;
  try {
    body = await request.json();
  } catch (_e) {
    return json({ ok: false }, { status: 400 });
  }
  const cartKey = hashCartKey(shop, body?.cartToken);
  if (!allow(`${shop}:${cartKey ?? request.headers.get("x-forwarded-for") ?? "anon"}`)) {
    return json({ ok: false }, { status: 429 });
  }

  const events = Array.isArray(body?.events) ? body.events.slice(0, 10) : [];
  if (events.length === 0) return json({ ok: true, recorded: 0 });

  // Only rules that are actually live for this shop can be reported.
  const cache = await readRulesCacheForShop(shop);
  const titles = new Map((cache?.titles ?? []).map((r) => [r.id, r.title]));
  const liveIds = new Set((cache?.rules ?? []).map((r) => r.id));
  const valid = events
    .filter((e) => liveIds.has(e?.ruleId) && EVENT_TYPE_BY_RULE_TYPE[e?.ruleType])
    .map((e) => ({
      ruleId: e.ruleId,
      ruleTitle: titles.get(e.ruleId) ?? "Rule",
      ruleType: e.ruleType,
      eventType: EVENT_TYPE_BY_RULE_TYPE[e.ruleType],
      source: "storefront",
      productId: typeof e.productId === "string" || typeof e.productId === "number" ? `gid://shopify/Product/${String(e.productId).split("/").pop()}` : null,
      productTitle: typeof e.productTitle === "string" ? e.productTitle : null,
      attempted: e.attempted,
      allowed: e.allowed,
      cartKey,
      detail: e.where === "product" ? "Product page" : "Cart page",
    }));
  const recorded = await recordEvents(shop, valid);
  return json({ ok: true, recorded });
};

export const loader = () => new Response(null, { status: 405 });
