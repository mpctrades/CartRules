import { BlockStack, Box, Icon, InlineGrid, InlineStack, Text } from "@shopify/polaris";
import { CheckCircleIcon } from "@shopify/polaris-icons";
import { RULE_TYPES } from "../models/ruleConstants";

// Selectable-card version of the rule-type picker, used by both the create
// (app.rules.new.jsx) and edit (app.rules.$id.jsx) rule screens instead of a
// plain ButtonGroup — makes step 1 feel guided rather than form-based.
const OPTIONS = [
  {
    value: RULE_TYPES.NO_DISCOUNT,
    title: "Block discounts",
    description: "Prevent discount codes from applying to selected products.",
  },
  {
    value: RULE_TYPES.MAX_QUANTITY,
    title: "Maximum quantity",
    description: "Limit how many units customers can purchase.",
  },
];

export default function RuleTypeCards({ value, onChange }) {
  return (
    <InlineGrid columns={{ xs: 1, sm: 2 }} gap="300">
      {OPTIONS.map((option) => {
        const selected = value === option.value;
        return (
          <Box
            key={option.value}
            as="button"
            type="button"
            onClick={() => onChange(option.value)}
            background={selected ? "bg-surface-selected" : "bg-surface"}
            borderWidth="025"
            borderColor={selected ? "border-emphasis" : "border"}
            borderRadius="200"
            padding="300"
            width="100%"
          >
            <BlockStack gap="100">
              <InlineStack align="space-between" blockAlign="center" wrap={false}>
                <Text as="h3" variant="headingSm">
                  {option.title}
                </Text>
                {selected ? <Icon source={CheckCircleIcon} tone="success" /> : null}
              </InlineStack>
              <Text as="p" tone="subdued" alignment="start">
                {option.description}
              </Text>
            </BlockStack>
          </Box>
        );
      })}
    </InlineGrid>
  );
}
