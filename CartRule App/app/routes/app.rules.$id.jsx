import { json } from "@remix-run/node";
import { useLoaderData, useNavigate } from "@remix-run/react";
import { Button } from "@shopify/polaris";
import { ArrowLeftIcon } from "@shopify/polaris-icons";
import { loadAppContext } from "../models/context.server";
import { getRule } from "../models/rules.server";
import { loadRuleFormOptions, saveRuleFromForm, formDefaults } from "../models/ruleForm.server";
import RuleForm from "../components/RuleForm";
import { AppPage, StatusBadge } from "../components/ui";
import { getScheduleStatus } from "../models/ruleDisplay";

export const loader = async ({ request, params }) => {
  const ctx = await loadAppContext(request, { rules: false });
  const rule = await getRule(ctx.admin, decodeURIComponent(params.id));
  if (!rule) throw new Response("Rule not found", { status: 404 });
  const options = await loadRuleFormOptions(ctx.admin);
  return json({
    rule,
    plan: ctx.plan.name,
    timezone: ctx.timezone,
    currency: ctx.currency,
    options,
    defaultMessages: formDefaults(ctx.settings),
  });
};

export const action = async ({ request, params }) => {
  const ctx = await loadAppContext(request, { rules: false, settings: false });
  const existing = await getRule(ctx.admin, decodeURIComponent(params.id));
  if (!existing) return json({ ok: false, error: "This rule no longer exists." }, { status: 404 });
  const formData = await request.formData();
  return saveRuleFromForm({ admin: ctx.admin, billing: ctx.billing, shop: ctx.shop, formData, existing });
};

export default function EditRule() {
  const { rule, plan, timezone, currency, options, defaultMessages } = useLoaderData();
  const navigate = useNavigate();
  return (
    <AppPage
      title={rule.title || "Edit rule"}
      subtitle="Change anything below — checkout is updated as soon as you save."
      back={
        <Button variant="tertiary" icon={ArrowLeftIcon} onClick={() => navigate("/app/rules")}>
          Rules
        </Button>
      }
      actions={
        <>
          <StatusBadge status={getScheduleStatus(rule)} />
          <Button url={`/app/test?ruleId=${encodeURIComponent(rule.id)}`}>Test rule</Button>
        </>
      }
    >
      <RuleForm
        key={rule.id}
        mode="edit"
        initial={rule}
        existingStatus={rule.status}
        plan={plan}
        timezone={timezone}
        currency={currency}
        options={options}
        defaultMessages={defaultMessages}
      />
    </AppPage>
  );
}
