import { redirect } from "@remix-run/node";

// Shopify opens this URL (with a `shop` query param) both when a merchant
// installs the app and on some re-auth flows. Bounce straight into the
// embedded app / OAuth as appropriate.
export const loader = async ({ request }) => {
  const url = new URL(request.url);
  if (url.searchParams.get("shop")) {
    // Forward every param (host, embedded, id_token, …), not just `shop` —
    // the embedded-auth bounce on /app needs `host`/`embedded` to know it's
    // running inside the admin iframe; dropping them sends it down the
    // non-embedded /auth/login path instead.
    return redirect(`/app?${url.searchParams.toString()}`);
  }
  // Someone opened the bare app URL directly (no shop context at all — not
  // an install/re-auth bounce; typically a reviewer or a curious visitor
  // pasting the App URL into a browser). Render an informational page with
  // no input field here rather than bouncing to /auth/login's manual
  // shop-domain form — App Store requirement 2.3.1 prohibits requesting
  // manual myshopify.com entry anywhere in the install/config flow, and a
  // reviewer landing straight on that form from the bare App URL reads as
  // exactly that, even though real installs never take this path (they
  // always arrive with ?shop=...). /auth/login itself still exists (the
  // library requires a route there) for the rare legitimate manual case.
  return null;
};

export default function Index() {
  return (
    <div
      style={{
        fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
        maxWidth: 440,
        margin: "96px auto",
        padding: "0 24px",
        textAlign: "center",
        color: "#202223",
      }}
    >
      <h1 style={{ fontSize: 20, marginBottom: 8 }}>CartRules</h1>
      <p style={{ color: "#6b7177", lineHeight: 1.5 }}>
        CartRules is a Shopify app. Install it from the{" "}
        <a href="https://apps.shopify.com" style={{ color: "#2c6ecb" }}>
          Shopify App Store
        </a>
        , or open it from the Apps section of your Shopify admin.
      </p>
    </div>
  );
}
