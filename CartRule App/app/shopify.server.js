import "@shopify/shopify-app-remix/adapters/node";
import {
  ApiVersion,
  AppDistribution,
  BillingInterval,
  shopifyApp,
} from "@shopify/shopify-app-remix/server";
import { PrismaSessionStorage } from "@shopify/shopify-app-session-storage-prisma";
import prisma from "./db.server";

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
  apiVersion: ApiVersion.July25,
  scopes: process.env.SCOPES?.split(","),
  appUrl: process.env.SHOPIFY_APP_URL || "",
  authPathPrefix: "/auth",
  sessionStorage: new PrismaSessionStorage(prisma),
  distribution: AppDistribution.AppStore,
  billing: {
    [BILLING_PLANS.GROWTH]: {
      amount: 4.99,
      currencyCode: "USD",
      interval: BillingInterval.Every30Days,
    },
    [BILLING_PLANS.PRO]: {
      amount: 9.99,
      currencyCode: "USD",
      interval: BillingInterval.Every30Days,
    },
  },
  hooks: {
    afterAuth: async ({ session }) => {
      // `shopify` is a `const` declared below, but this callback only runs
      // later (after a merchant installs/re-authorizes), by which point the
      // module has finished evaluating and `shopify` is defined — safe closure.
      shopify.registerWebhooks({ session });
    },
  },
  future: {
    unstable_newEmbeddedAuthStrategy: true,
    removeRest: true,
  },
  ...(process.env.SHOP_CUSTOM_DOMAIN
    ? { customShopDomains: [process.env.SHOP_CUSTOM_DOMAIN] }
    : {}),
});

export default shopify;
export const apiVersion = ApiVersion.July25;
export const addDocumentResponseHeaders = shopify.addDocumentResponseHeaders;
export const authenticate = shopify.authenticate;
export const unauthenticated = shopify.unauthenticated;
export const login = shopify.login;
export const registerWebhooks = shopify.registerWebhooks;
export const sessionStorage = shopify.sessionStorage;
