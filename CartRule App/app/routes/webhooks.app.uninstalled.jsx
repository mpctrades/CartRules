import { authenticate } from "../shopify.server";
import db from "../db.server";

// No rule data to clean up here on our side — rules live in the merchant's
// own shop (metaobjects/metafields) and Shopify deletes app-owned metafields
// automatically on uninstall. We only need to drop the stored session.
export const action = async ({ request }) => {
  const { shop, session, topic } = await authenticate.webhook(request);

  console.log(`Received ${topic} webhook for ${shop}`);

  if (session) {
    await db.session.deleteMany({ where: { shop } });
  }

  return new Response();
};
