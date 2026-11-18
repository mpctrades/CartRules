// Multi-value text input with suggestions, shared by the rule form and the
// group editor.
import { useState } from "react";
import { BlockStack, Combobox, InlineStack, Listbox, Tag } from "@shopify/polaris";

/** Multi-value input with suggestions (tags, vendors, types, countries). */
export function TokenField({ label, values, onChange, suggestions = [], placeholder, disabled, format = (v) => v, helpText }) {
  const [input, setInput] = useState("");
  const lowerValues = values.map((v) => String(v).toLowerCase());
  const matches = suggestions
    .filter((s) => !lowerValues.includes(String(s).toLowerCase()))
    .filter((s) => !input || format(s).toLowerCase().includes(input.toLowerCase()) || String(s).toLowerCase().includes(input.toLowerCase()))
    .slice(0, 12);
  const add = (raw) => {
    const v = String(raw ?? "").trim();
    if (!v || lowerValues.includes(v.toLowerCase())) {
      setInput("");
      return;
    }
    onChange([...values, v]);
    setInput("");
  };
  const exact = suggestions.some((s) => String(s).toLowerCase() === input.trim().toLowerCase());
  return (
    <BlockStack gap="200">
      <Combobox
        activator={
          <Combobox.TextField
            label={label}
            value={input}
            onChange={setInput}
            placeholder={placeholder}
            autoComplete="off"
            disabled={disabled}
            helpText={helpText}
          />
        }
      >
        {matches.length > 0 || (input.trim() && !exact) ? (
          <Listbox onSelect={add}>
            {input.trim() && !exact ? (
              <Listbox.Option value={input.trim()}>{`Add “${input.trim()}”`}</Listbox.Option>
            ) : null}
            {matches.map((s) => (
              <Listbox.Option key={s} value={s}>
                {format(s)}
              </Listbox.Option>
            ))}
          </Listbox>
        ) : null}
      </Combobox>
      {values.length ? (
        <InlineStack gap="150" wrap>
          {values.map((v) => (
            <Tag key={v} onRemove={disabled ? undefined : () => onChange(values.filter((x) => x !== v))}>
              {format(v)}
            </Tag>
          ))}
        </InlineStack>
      ) : null}
    </BlockStack>
  );
}
