import { authenticate } from "../shopify.server";
import { resyncIfCatalogChangeAffectsRules } from "../models/rules.server";

// products/create, products/update, products/delete, collections/update and
// collections/delete — keeps TAG/COLLECTION rules' product lists (in the
// rules_cache metafield the checkout Function reads) in step with the
// catalog, so what the app shows as covered is what checkout enforces
// (App Store requirement 2.1.4). See resyncIfCatalogChangeAffectsRules.
export const action = async ({ request }) => {
  const { topic, shop, payload, admin } = await authenticate.webhook(request);
  console.log(`Received ${topic} webhook for ${shop}`);

  // No offline session (e.g. already uninstalled) means nothing to sync.
  if (!admin) return new Response();

  const isCollection = topic.startsWith("COLLECTIONS");
  const gid = payload?.admin_graphql_api_id ??
    (payload?.id ? `gid://shopify/${isCollection ? "Collection" : "Product"}/${payload.id}` : null);
  const change = isCollection
    ? { collectionId: gid }
    : {
        productId: gid,
        productTags: typeof payload?.tags === "string" ? payload.tags.split(",") : [],
      };

  // Respond right away — a rebuild can take several Admin API calls and
  // Shopify retries webhooks that don't answer within 5 seconds.
  resyncIfCatalogChangeAffectsRules(admin, change).catch((error) => {
    console.error(`Rules cache resync after ${topic} failed`, { shop, error });
  });

  return new Response();
};
