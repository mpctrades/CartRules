// One call for what nearly every admin page loader needs: the authenticated
// admin, the shop's plan, rules, settings, timezone and currency.
import { authenticate } from "../shopify.server";
import { getPlan } from "./plan.server";
import { listRules, getShopIdentity } from "./rules.server";
import { getSettings } from "./settings.server";

export async function loadAppContext(request, { rules = true, settings = true } = {}) {
  const { admin, session, billing } = await authenticate.admin(request);
  const [plan, ruleList, settingsValue, identity] = await Promise.all([
    getPlan(admin, billing, session.shop),
    rules ? listRules(admin) : Promise.resolve(null),
    settings ? getSettings(admin) : Promise.resolve(null),
    getShopIdentity(admin),
  ]);
  return {
    admin,
    session,
    billing,
    shop: session.shop,
    plan,
    rules: ruleList,
    settings: settingsValue,
    timezone: identity.timezone,
    currency: identity.currency,
  };
}
