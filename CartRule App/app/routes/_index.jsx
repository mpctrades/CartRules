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
  // Someone opened the bare app URL directly (no shop context at all —
  // not an install/re-auth bounce). /auth/login already has a working
  // shop-domain form for this case; render nothing here instead of
  // duplicating it.
  return redirect("/auth/login");
};

export default function Index() {
  return null;
}
