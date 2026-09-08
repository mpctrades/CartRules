import { useMemo, useState } from "react";
import { useNavigate } from "@remix-run/react";
import { Page, Card, BlockStack, InlineGrid, InlineStack, Text, Button, Badge, Tabs } from "@shopify/polaris";
import { AlertTriangleIcon, CartDiscountIcon } from "@shopify/polaris-icons";
import { RULE_TYPES } from "../models/ruleConstants";
import { Eyebrow, IconChip } from "../components/brand";

// Icon and Badge don't share a tone vocabulary (Icon has "caution", Badge
// doesn't) — badgeTone is the closest valid <Badge tone> for the same
// category.
function templateIcon(category) {
  return category === "quantity"
    ? { icon: AlertTriangleIcon, tone: "caution", badgeTone: "warning" }
    : { icon: CartDiscountIcon, tone: "magic", badgeTone: "magic" };
}

// Pre-built starting points for the 3-step wizard. Only using the two rule
// types CartRules actually enforces (no_discount / max_quantity) — no
// "minimum quantity" / "cart value" / scheduled templates here, since those
// rule types don't exist in the checkout Function yet (see the roadmap
// items in README). A template pre-fills step 1 (rule type) and step 3
// (message) — the merchant still picks their own products/tags/collection
// in step 2, since a template can't know that.
const TEMPLATES = [
  {
    key: "limited-edition",
    title: "Limited edition",
    badge: "Max 1 per order",
    description: "Protect limited drops and exclusive items from being bought in bulk.",
    ruleType: RULE_TYPES.MAX_QUANTITY,
    maxQuantity: "1",
    message: "This is a limited edition item — only 1 per order.",
    category: "quantity",
  },
  {
    key: "no-discount",
    title: "No discount",
    badge: "Block discount codes",
    description: "Exclude products from promotional discounts to protect margin.",
    ruleType: RULE_TYPES.NO_DISCOUNT,
    message: "This item is already at its best price — discount codes do not apply.",
    category: "discount",
  },
  {
    key: "bulky-item-cap",
    title: "Bulky item cap",
    badge: "Max 2 per order",
    description: "Cap orders on heavy or oversized items to protect shipping margin.",
    ruleType: RULE_TYPES.MAX_QUANTITY,
    maxQuantity: "2",
    message: "There is a maximum of 2 per order for this item due to shipping size.",
    category: "quantity",
  },
  {
    key: "reseller-protection",
    title: "Reseller protection",
    badge: "Max 3 per order",
    description: "Stop resellers from emptying limited stock in a single order.",
    ruleType: RULE_TYPES.MAX_QUANTITY,
    maxQuantity: "3",
    message: "There is a maximum quantity for this item per order.",
    category: "quantity",
  },
];

// Only categories with at least one real template today — no "Cart" or
// "Wholesale" chip yet, since those rule types don't exist until the
// checkout Function supports them (see the roadmap in README).
const CATEGORIES = [
  { id: "all", label: "All" },
  { id: "quantity", label: "Quantity" },
  { id: "discount", label: "Discount" },
];

export default function Templates() {
  const navigate = useNavigate();
  const [categoryTab, setCategoryTab] = useState(0);

  const useTemplate = (template) => {
    const params = new URLSearchParams({ ruleType: template.ruleType, message: template.message });
    if (template.maxQuantity) params.set("maxQuantity", template.maxQuantity);
    navigate(`/app/rules/new?${params.toString()}`);
  };

  const activeCategory = CATEGORIES[categoryTab].id;
  const visibleTemplates = useMemo(
    () => (activeCategory === "all" ? TEMPLATES : TEMPLATES.filter((t) => t.category === activeCategory)),
    [activeCategory],
  );

  return (
    <Page title="Templates" subtitle="Common rules, ready to adjust and use.">
      <BlockStack gap="400">
        <Eyebrow>Templates</Eyebrow>
        <Tabs tabs={CATEGORIES.map((c) => ({ id: c.id, content: c.label }))} selected={categoryTab} onSelect={setCategoryTab} />
        <InlineGrid columns={{ xs: 1, sm: 2, md: 2 }} gap="400">
          {visibleTemplates.map((template) => {
            const { icon, tone, badgeTone } = templateIcon(template.category);
            return (
              <Card key={template.key}>
                <BlockStack gap="200">
                  <InlineStack gap="200" blockAlign="center">
                    <IconChip icon={icon} tone={tone} />
                    <BlockStack gap="100">
                      <Text as="h2" variant="headingMd">
                        {template.title}
                      </Text>
                      <div>
                        <Badge tone={badgeTone}>{template.badge}</Badge>
                      </div>
                    </BlockStack>
                  </InlineStack>
                  <Text as="p" tone="subdued">
                    {template.description}
                  </Text>
                  <div>
                    <Button onClick={() => useTemplate(template)}>Use template</Button>
                  </div>
                </BlockStack>
              </Card>
            );
          })}
        </InlineGrid>
        {visibleTemplates.length === 0 ? (
          <Text as="p" tone="subdued">
            No templates in this category yet.
          </Text>
        ) : null}
      </BlockStack>
    </Page>
  );
}
