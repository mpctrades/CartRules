import { Link, Outlet, useLoaderData, useRouteError } from "@remix-run/react";
import { boundary } from "@shopify/shopify-app-remix/server";
import { AppProvider } from "@shopify/shopify-app-remix/react";
import { NavMenu } from "@shopify/app-bridge-react";
import polarisStyles from "@shopify/polaris/build/esm/styles.css?url";
import cartrulesStyles from "../styles/cartrules.css?url";
import { authenticate } from "../shopify.server";

export const links = () => [
  { rel: "stylesheet", href: polarisStyles },
  { rel: "stylesheet", href: cartrulesStyles },
];

export const loader = async ({ request }) => {
  await authenticate.admin(request);
  return { apiKey: process.env.SHOPIFY_API_KEY || "" };
};

export default function App() {
  const { apiKey } = useLoaderData();

  return (
    // isEmbeddedApp={false} only stops AppProvider from injecting its own
    // App Bridge <script> — app/root.jsx already loads it (with the API key)
    // as the first script in <head>. The app is still fully embedded.
    <AppProvider isEmbeddedApp={false} apiKey={apiKey}>
      {/* App Bridge's nav menu has no separators — Plan & billing and Help &
          support are kept last so they read as the secondary group. */}
      <NavMenu>
        <Link to="/app" rel="home">
          Overview
        </Link>
        <Link to="/app/rules">Rules</Link>
        <Link to="/app/templates">Templates</Link>
        <Link to="/app/activity">Activity</Link>
        <Link to="/app/analytics">Analytics</Link>
        <Link to="/app/settings">Settings</Link>
        <Link to="/app/billing">Plan & billing</Link>
        <Link to="/app/help">Help & support</Link>
      </NavMenu>
      <Outlet />
    </AppProvider>
  );
}

export function ErrorBoundary() {
  return boundary.error(useRouteError());
}

export const headers = (headersArgs) => {
  return boundary.headers(headersArgs);
};
