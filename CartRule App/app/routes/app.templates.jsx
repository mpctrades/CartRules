import { json } from "@remix-run/node";
import { useLoaderData, useNavigate, useSearchParams } from "@remix-run/react";
import { Badge, BlockStack, Button, InlineStack, Text } from "@shopify/polaris";
import { authenticate } from "../shopify.server";
import { getPlan, lockedFeatures } from "../models/plan.server";
import { TEMPLATES, TEMPLATE_CATEGORIES } from "../models/templates";
import { RULE_TYPE_INFO, TARGET_INFO } from "../models/ruleConstants";
import { describeTarget, describeCustomer } from "../models/ruleDisplay";
import { AppPage, Segmented } from "../components/ui";

// Templates only pre-fill the rule form (/app/rules/new?template=<id>) —
// nothing is created or activated from this page.
export const loader = async ({ request }) => {
  const { admin, session, billing } = await authenticate.admin(request);
  const plan = await getPlan(admin, billing, session.shop);
  const requiredPlan = Object.fromEntries(
    TEMPLATES.map((t) => {
      const rule = {
        ...t.rule,
        schedule: t.rule.scheduled ? { startsAt: "pending", endsAt: null } : null,
      };
      const locked = lockedFeatures(rule, plan.name);
      const needs = locked.length ? (locked.some((f) => f.plan === "Pro") ? "Pro" : "Growth") : null;
      return [t.id, needs];
    }),
  );
  return json({ plan: plan.name, requiredPlan });
};

export default function Templates() {
  const { requiredPlan } = useLoaderData();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const category = TEMPLATE_CATEGORIES.some((c) => c.id === searchParams.get("category"))
    ? searchParams.get("category")
    : "all";
  const shown = category === "all" ? TEMPLATES : TEMPLATES.filter((t) => t.categories.includes(category));

  return (
    <AppPage
      title="Templates"
      subtitle="Start from a proven rule. You choose the products and review everything before saving — nothing goes live on its own."
    >
      <div>
        <Segmented
          label="Template category"
          options={TEMPLATE_CATEGORIES.map((c) => ({ label: c.label, value: c.id }))}
          value={category}
          onChange={(value) => {
            const next = new URLSearchParams(searchParams);
            if (value === "all") next.delete("category");
            else next.set("category", value);
            setSearchParams(next, { replace: true });
          }}
        />
      </div>

      <div className="cr-grid cr-grid--3">
        {shown.map((t) => {
          const needs = requiredPlan[t.id];
          const extras = [];
          if (t.rule.customer) extras.push(describeCustomer(t.rule.customer));
          if (t.rule.scheduled) extras.push("Runs on a schedule");
          return (
            <div key={t.id} className="cr-card" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              <InlineStack align="space-between" blockAlign="start" gap="200" wrap={false}>
                <BlockStack gap="050">
                  <Text as="h3" variant="headingMd">
                    {t.title}
                  </Text>
                  <span className="cr-link-accent" style={{ fontSize: 13 }}>
                    {t.summary}
                  </span>
                </BlockStack>
                {needs ? <Badge tone="info">{`${needs} plan`}</Badge> : null}
              </InlineStack>
              <Text as="p" tone="subdued">
                {t.description}
              </Text>
              <div className="cr-muted" style={{ marginTop: "auto" }}>
                {RULE_TYPE_INFO[t.rule.ruleType]?.title} ·{" "}
                {t.rule.target.type !== "all" && !t.rule.target.values.length
                  ? `${TARGET_INFO[t.rule.target.type]?.label} you choose`
                  : describeTarget(t.rule.target)}
                {extras.length ? ` · ${extras.join(" · ")}` : ""}
              </div>
              <div>
                <Button onClick={() => navigate(`/app/rules/new?template=${encodeURIComponent(t.id)}`)}>
                  Use template
                </Button>
              </div>
            </div>
          );
        })}
      </div>
      {Object.values(requiredPlan).some(Boolean) ? (
        <Text as="p" tone="subdued">
          Templates marked with a plan use features from that plan. You can still open them and adjust the rule, or{" "}
          <a className="cr-link-accent" href="/app/billing" onClick={(e) => { e.preventDefault(); navigate("/app/billing"); }}>
            compare plans
          </a>
          .
        </Text>
      ) : null}
    </AppPage>
  );
}
