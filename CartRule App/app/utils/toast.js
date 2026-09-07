// Thin wrapper around App Bridge's toast API (window.shopify.toast — the
// same `window.shopify` global app.rules.new.jsx already uses for
// resourcePicker). This is the standard success/error notification surface
// for an embedded Shopify app: it renders as a small pill at the bottom
// center of the admin, on top of everything, without the app having to
// wrap itself in a Polaris <Frame>. No-ops outside the embedded admin
// (e.g. a plain browser preview) since window.shopify won't exist there.
export function showToast(message, { isError = false, duration = 4000 } = {}) {
  if (typeof window === "undefined") return;
  if (window.shopify?.toast?.show) {
    window.shopify.toast.show(message, { isError, duration });
  }
}
