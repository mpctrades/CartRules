import { useState } from "react";
import { json } from "@remix-run/node";
import { Form, useActionData, useLoaderData } from "@remix-run/react";
import {
  AppProvider as PolarisAppProvider,
  Button,
  Card,
  FormLayout,
  Page,
  Text,
  TextField,
} from "@shopify/polaris";
import polarisTranslations from "@shopify/polaris/locales/en.json";
import polarisStyles from "@shopify/polaris/build/esm/styles.css?url";
import { LoginErrorType } from "@shopify/shopify-app-remix/server";
import { login } from "../shopify.server";

export const links = () => [{ rel: "stylesheet", href: polarisStyles }];

function loginErrorMessage(loginErrors) {
  if (loginErrors?.shop === LoginErrorType.MissingShop) {
    return { shop: "Please enter your shop domain to log in" };
  }
  if (loginErrors?.shop === LoginErrorType.InvalidShop) {
    return { shop: "Please enter a valid shop domain to log in" };
  }
  return {};
}

// The embedded install flow never lands here — Shopify redirects straight
// through OAuth (see app/routes/_index.jsx and auth.$.jsx). This route only
// exists because @shopify/shopify-app-remix requires a route at the
// configured `authPathPrefix` + "/login" that calls `login()` (not
// `authenticate.admin()`), for the rare manual/non-embedded entry point —
// without it the library refuses every request with "Detected call to
// shopify.authenticate.admin() from configured login path".
export const loader = async ({ request }) => {
  const errors = loginErrorMessage(await login(request));
  return json({ errors, polarisTranslations });
};

export const action = async ({ request }) => {
  const errors = loginErrorMessage(await login(request));
  return json({ errors });
};

export default function Auth() {
  const { errors, polarisTranslations } = useLoaderData();
  const actionData = useActionData();
  const [shop, setShop] = useState("");
  const shownErrors = actionData?.errors ?? errors;

  return (
    <PolarisAppProvider i18n={polarisTranslations}>
      <Page>
        <Card>
          <Form method="post">
            <FormLayout>
              <Text variant="headingMd" as="h2">
                Log in
              </Text>
              <TextField
                type="text"
                name="shop"
                label="Shop domain"
                helpText="example.myshopify.com"
                value={shop}
                onChange={setShop}
                autoComplete="on"
                error={shownErrors.shop}
              />
              <Button submit>Log in</Button>
            </FormLayout>
          </Form>
        </Card>
      </Page>
    </PolarisAppProvider>
  );
}
