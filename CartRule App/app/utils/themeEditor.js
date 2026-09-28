// Deep links into the theme editor with a CartRules app block pre-added, per
// https://shopify.dev/docs/apps/build/online-store/theme-app-extensions/configuration#deep-linking
// addAppBlockId is `{api_key}/{handle}`: api_key is the app's client_id from
// shopify.app.toml (the old `{extension uuid}/{handle}` form is deprecated),
// handle is the block's Liquid filename under extensions/cartrules-notice/blocks/.
// This module is also bundled client-side, so the client_id is inlined
// rather than read from process.env — keep it in sync with shopify.app.toml.
const CARTRULES_CLIENT_ID = "dc1d974d199f006dabfec9d395bae2fd";

function editorLink(shop, { template, handle, target }) {
  const params = new URLSearchParams({
    template,
    addAppBlockId: `${CARTRULES_CLIENT_ID}/${handle}`,
    target,
  });
  return `https://${shop}/admin/themes/current/editor?${params.toString()}`;
}

/** Product template, "Max quantity notice" block, inside the main product section. */
export function getThemeEditorDeepLink(shop) {
  return editorLink(shop, { template: "product", handle: "cartrules-notice", target: "mainSection" });
}

/** Cart template, "Cart quantity guard" block, in a new Apps section. */
export function getCartThemeEditorDeepLink(shop) {
  return editorLink(shop, { template: "cart", handle: "cartrules-cart-guard", target: "newAppsSection" });
}
