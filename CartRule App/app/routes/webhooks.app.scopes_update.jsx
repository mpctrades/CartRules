import { authenticate } from "../shopify.server";
import db from "../db.server";

export const action = async ({ request }) => {
  const { payload, session, topic, shop } = await authenticate.webhook(request);
  console.log(`Received ${topic} webhook for ${shop}`);

  const current = payload.current;
  // updateMany: the session can be gone by now (uninstall, dropped expired
  // token), and a missing row must not turn the webhook into a 500.
  if (session && Array.isArray(current)) {
    await db.session.updateMany({
      where: { id: session.id },
      data: { scope: current.map(String).join(",") },
    });
  }
  return new Response();
};
