import { json } from "@remix-run/node";
import { AppProvider as PolarisAppProvider, Card, Page, Text, BlockStack, Link } from "@shopify/polaris";
import polarisTranslations from "@shopify/polaris/locales/en.json";
import polarisStyles from "@shopify/polaris/build/esm/styles.css?url";
import { useLoaderData } from "@remix-run/react";
import { login } from "../shopify.server";

export const links = () => [{ rel: "stylesheet", href: polarisStyles }];

// The embedded install flow never lands here — Shopify redirects straight
// through OAuth (see app/routes/_index.jsx and auth.$.jsx). This route only
// exists because @shopify/shopify-app-remix requires a route at the
// configured `authPathPrefix` + "/login" that calls `login()` (not
// `authenticate.admin()`) — without it the library refuses every request
// with "Detected call to shopify.authenticate.admin() from configured login
// path". `login()` still redirects straight into OAuth when a `shop` param
// is present.
//
// Deliberately no shop-domain input: App Store requirement 2.3.1 prohibits
// asking merchants to type their myshopify.com domain anywhere in the install
// or configuration flow, and /app redirects here whenever a request arrives
// without a session (e.g. the app URL opened outside the Shopify admin).
export const loader = async ({ request }) => {
  await login(request);
  return json({ polarisTranslations });
};

export const action = async ({ request }) => {
  await login(request);
  return json({});
};

export default function Auth() {
  const { polarisTranslations } = useLoaderData();

  return (
    <PolarisAppProvider i18n={polarisTranslations}>
      <Page narrowWidth>
        <Card>
          <BlockStack gap="200">
            <Text variant="headingMd" as="h1">
              Open CartRules from your Shopify admin
            </Text>
            <Text as="p" tone="subdued">
              CartRules runs inside the Shopify admin. Go to Apps → CartRules in your store&apos;s admin, or install
              it from the{" "}
              <Link url="https://apps.shopify.com" target="_top">
                Shopify App Store
              </Link>
              .
            </Text>
          </BlockStack>
        </Card>
      </Page>
    </PolarisAppProvider>
  );
}
