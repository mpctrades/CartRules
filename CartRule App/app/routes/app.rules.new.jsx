import { json } from "@remix-run/node";
import { useLoaderData, useNavigate } from "@remix-run/react";
import { Button } from "@shopify/polaris";
import { ArrowLeftIcon } from "@shopify/polaris-icons";
import { loadAppContext } from "../models/context.server";
import { loadRuleFormOptions, saveRuleFromForm, formDefaults } from "../models/ruleForm.server";
import { getTemplate } from "../models/templates";
import RuleForm from "../components/RuleForm";
import { AppPage } from "../components/ui";

export const loader = async ({ request }) => {
  const ctx = await loadAppContext(request, { rules: false });
  const url = new URL(request.url);
  const template = getTemplate(url.searchParams.get("template"));
  const options = await loadRuleFormOptions(ctx.admin);
  return json({
    plan: ctx.plan.name,
    timezone: ctx.timezone,
    currency: ctx.currency,
    options,
    defaultMessages: formDefaults(ctx.settings),
    // Templates only pre-fill the form — nothing is saved or activated until
    // the merchant chooses Save.
    initial: template ? { ...template.rule, templateId: template.id } : null,
    templateTitle: template?.title ?? null,
  });
};

export const action = async ({ request }) => {
  const ctx = await loadAppContext(request, { rules: false, settings: false });
  const formData = await request.formData();
  return saveRuleFromForm({ admin: ctx.admin, billing: ctx.billing, shop: ctx.shop, formData });
};

export default function NewRule() {
  const { plan, timezone, currency, options, defaultMessages, initial, templateTitle } = useLoaderData();
  const navigate = useNavigate();
  return (
    <AppPage
      title="Create rule"
      subtitle={templateTitle ? `From the “${templateTitle}” template — review each step, then save.` : "Set up a rule in five short steps."}
      back={
        <Button variant="tertiary" icon={ArrowLeftIcon} onClick={() => navigate("/app/rules")}>
          Rules
        </Button>
      }
    >
      <RuleForm
        mode="new"
        initial={initial}
        plan={plan}
        timezone={timezone}
        currency={currency}
        options={options}
        defaultMessages={defaultMessages}
      />
    </AppPage>
  );
}
