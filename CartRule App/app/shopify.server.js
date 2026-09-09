import "@shopify/shopify-app-remix/adapters/node";
import {
  AppDistribution,
  BillingInterval,
  shopifyApp,
} from "@shopify/shopify-app-remix/server";
import { PrismaSessionStorage } from "@shopify/shopify-app-session-storage-prisma";
import prisma from "./db.server";

// The installed @shopify/shopify-api's `ApiVersion` enum tops out at "2025-07"
// (its latest npm release hasn't been bumped) — over a year stale relative to
// today, and Shopify has since sunset it. The GraphQL client accepts any
// version string without validating it against that enum, so pass the live
// version directly — kept in sync with [webhooks].api_version in
// shopify.app.toml. (Not the cause of the 403s below — see
// expiringOfflineAccessTokens — but still worth not running sunset.)
const CURRENT_API_VERSION = "2026-07";

// Plan names/prices must match the brief (section 08 — Pricing & business model).
// FREE isn't a real Shopify billing plan (Shopify billing has no $0 subscription);
// "Free" just means the merchant never goes through the billing flow at all —
// enforced in code by the 3-active-rule cap, see app/models/rules.server.js.
export const BILLING_PLANS = {
  GROWTH: "Growth",
  PRO: "Pro",
};

export const FREE_PLAN_RULE_LIMIT = 3;

const shopify = shopifyApp({
  apiKey: process.env.SHOPIFY_API_KEY,
  apiSecretKey: process.env.SHOPIFY_API_SECRET || "",
  apiVersion: CURRENT_API_VERSION,
  scopes: process.env.SCOPES?.split(","),
  appUrl: process.env.SHOPIFY_APP_URL || "",
  authPathPrefix: "/auth",
  sessionStorage: new PrismaSessionStorage(prisma),
  distribution: AppDistribution.AppStore,
  // Each plan must be a one-time plan OR a subscription plan with `lineItems`
  // — the installed @shopify/shopify-app-remix rejects a flat
  // {amount, currencyCode, interval} shape with "Invalid billing
  // configuration ... Must be either a one-time plan or a subscription plan
  // with line items" (thrown by billing.request() before it ever reaches
  // Shopify's API). This was firing on every "Upgrade" click in production —
  // the App Store review rejection (500 on the billing page) traces to this.
  billing: {
    [BILLING_PLANS.GROWTH]: {
      lineItems: [
        {
          amount: 4.99,
          currencyCode: "USD",
          interval: BillingInterval.Every30Days,
        },
      ],
    },
    [BILLING_PLANS.PRO]: {
      lineItems: [
        {
          amount: 9.99,
          currencyCode: "USD",
          interval: BillingInterval.Every30Days,
        },
      ],
    },
  },
  hooks: {
    afterAuth: async ({ session }) => {
      // `shopify` is a `const` declared below, but this callback only runs
      // later (after a merchant installs/re-authorizes), by which point the
      // module has finished evaluating and `shopify` is defined — safe closure.
      // Un-awaited before, this was a floating promise: a rejection (e.g. a
      // transient Admin API error) became an unhandled rejection, which
      // crashes the whole Node process by default — taking down the app for
      // every merchant over one install's webhook hiccup. Await + catch it.
      try {
        await shopify.registerWebhooks({ session });
      } catch (error) {
        console.error("Failed to register webhooks", { shop: session.shop, error });
      }
    },
  },
  future: {
    unstable_newEmbeddedAuthStrategy: true,
    removeRest: true,
    // Without this, token exchange issues a non-expiring offline token
    // (TokenExchangeStrategy passes `expiring: config.future.expiringOfflineAccessTokens`,
    // which was undefined) — Shopify now rejects every Admin API call made
    // with a non-expiring token outright ("[API] Non-expiring access tokens
    // are no longer accepted for the Admin API"), even though session
    // creation itself still silently succeeds. This was the real cause of
    // every admin.graphql() 403 in this app, on both dev and production.
    expiringOfflineAccessTokens: true,
  },
  ...(process.env.SHOP_CUSTOM_DOMAIN
    ? { customShopDomains: [process.env.SHOP_CUSTOM_DOMAIN] }
    : {}),
});

export default shopify;
export const apiVersion = CURRENT_API_VERSION;
export const addDocumentResponseHeaders = shopify.addDocumentResponseHeaders;
export const authenticate = shopify.authenticate;
export const unauthenticated = shopify.unauthenticated;
export const login = shopify.login;
export const registerWebhooks = shopify.registerWebhooks;
export const sessionStorage = shopify.sessionStorage;
