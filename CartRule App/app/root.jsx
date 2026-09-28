import { Links, Meta, Outlet, Scripts, ScrollRestoration, useLoaderData, useMatches } from "@remix-run/react";

// The client ID is public (it's in every admin URL), so exposing it to the
// document is fine — App Bridge reads it from the shopify-api-key meta tag.
export const loader = async () => {
  return { apiKey: process.env.SHOPIFY_API_KEY || "" };
};

export default function App() {
  const { apiKey } = useLoaderData();
  // Only the embedded admin routes (/app/*) run inside the Shopify admin
  // iframe. The bare landing page and /auth/login are top-level pages where
  // App Bridge has no admin to talk to, so don't load it there.
  const isEmbeddedRoute = useMatches().some((m) => m.id === "routes/app");

  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width,initial-scale=1" />
        {/* App Store requirement 2.2.3: latest App Bridge from the CDN, as
            the first script in <head>. app/routes/app.jsx passes
            isEmbeddedApp={false} to AppProvider so it doesn't inject a
            second (duplicate) copy of this same script into <body>. */}
        {isEmbeddedRoute ? (
          <>
            <meta name="shopify-api-key" content={apiKey} />
            <script src="https://cdn.shopify.com/shopifycloud/app-bridge.js"></script>
          </>
        ) : null}
        <link rel="icon" type="image/png" href="/favicon.png" />
        <link rel="preconnect" href="https://cdn.shopify.com/" />
        <link
          rel="stylesheet"
          href="https://cdn.shopify.com/static/fonts/inter/v4/styles.css"
        />
        <Meta />
        <Links />
      </head>
      <body>
        <Outlet />
        <ScrollRestoration />
        <Scripts />
      </body>
    </html>
  );
}
