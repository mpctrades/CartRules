// Deep link to the theme editor with the CartRules product-page app block
// pre-selected, per https://shopify.dev/docs/apps/build/online-store/theme-app-extensions/configuration#deep-linking
// UUID/handle must match extensions/cartrules-notice/shopify.extension.toml (uid)
// and blocks/cartrules-notice.liquid (filename).
const CARTRULES_NOTICE_BLOCK_ID = "f1b4df7a-5246-f6f9-f6a1-dc37782c57e1fca6df09/cartrules-notice";

export function getThemeEditorDeepLink(shop) {
  const params = new URLSearchParams({
    template: "product",
    addAppBlockId: CARTRULES_NOTICE_BLOCK_ID,
    target: "mainSection",
  });
  return `https://${shop}/admin/themes/current/editor?${params.toString()}`;
}
