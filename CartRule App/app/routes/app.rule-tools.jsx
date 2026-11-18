// JSON endpoint for the rule form (app/components/RuleForm.jsx):
//  - intent "count": how many products / variants a group covers
//    ("hoodie → 6 products, 42 variants");
//  - intent "test":  the "Test this rule" box — runs the unsaved rule
//    against a cart the merchant builds (simulator.server.js testDraftRule).
import { json } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import { countGroup } from "../models/targetCounts.server";
import { testDraftRule } from "../models/simulator.server";
import { getShopIdentity } from "../models/rules.server";
import { TARGET_TYPES } from "../models/ruleConstants";

export const loader = () => json({ error: "Not found" }, { status: 404 });

export const action = async ({ request }) => {
  const { admin } = await authenticate.admin(request);
  const formData = await request.formData();
  const intent = formData.get("intent");
  let payload;
  try {
    payload = JSON.parse(formData.get("payload") ?? "{}");
  } catch (_e) {
    return json({ intent, error: "The request couldn't be read." }, { status: 400 });
  }
  try {
    if (intent === "count") {
      if (payload.target?.type !== TARGET_TYPES.MIXED) return json({ intent, products: 0, variants: 0, more: false });
      return json({ intent, key: payload.key ?? null, ...(await countGroup(admin, payload.target)) });
    }
    if (intent === "test") {
      const { currency } = await getShopIdentity(admin);
      return json({ intent, ...(await testDraftRule(admin, { ...payload, currency })) });
    }
    return json({ intent, error: "Unknown action." }, { status: 400 });
  } catch (error) {
    if (error instanceof Response) throw error;
    console.error(`rule-tools ${intent} failed`, error);
    return json({ intent, error: intent === "count" ? "Couldn't count products." : "The test couldn't run. Please try again." });
  }
};
