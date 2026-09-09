// Whether Shopify billing charges for this shop should be requested as test
// charges (`isTest: true`) instead of real ones.
//
// NODE_ENV=production is set correctly in this deployment, so this is not
// about per-deployment test/live toggling. It's about a Shopify App Store
// reviewer's own development store: Shopify's Billing API can reject a
// real (isTest: false) charge request against a development or Plus
// sandbox store, and that rejection would surface as a genuine billing
// failure on the exact flow reviewers test. Asking Shopify whether THIS
// shop is a partner development store avoids that, while real merchants on
// real stores still get charged for real on the same deployment.
const devStoreCache = new Map(); // shop domain -> { value, expiresAt }
const CACHE_TTL_MS = 60 * 60 * 1000; // a shop's plan essentially never flips
// mid-session; avoids an extra Admin API round trip on every billing-related
// page load.

export async function isDevelopmentStore(admin, shop) {
  const cached = devStoreCache.get(shop);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.value;
  }

  const response = await admin.graphql(`#graphql
    query ShopPlanForBilling {
      shop {
        plan {
          partnerDevelopment
        }
      }
    }
  `);
  const data = await response.json();
  const value = Boolean(data.data?.shop?.plan?.partnerDevelopment);
  devStoreCache.set(shop, { value, expiresAt: Date.now() + CACHE_TTL_MS });
  return value;
}
