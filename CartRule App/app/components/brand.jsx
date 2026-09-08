import { InlineStack, Icon } from "@shopify/polaris";

// CartRules' own brand orange (from the logo/marketing site) — shared so
// every page's color accents come from one place instead of re-guessing a
// hex per file. Semantic Polaris tones (info/magic/caution/success) stay on
// Polaris components elsewhere; this is only for the app's own brand mark.
export const BRAND_ORANGE = "#ff5a1f";
export const BRAND_ORANGE_SOFT = "#fff0e6";

// Semantic Polaris tone -> its matching theme-aware surface token, for a
// tinted icon chip (adapts to dark mode automatically, unlike a hardcoded
// hex would). Reused anywhere an icon+label needs to stand out — KPI cards,
// activity rows, etc.
export const TONE_CHIP_BG = {
  info: "var(--p-color-bg-surface-info)",
  magic: "var(--p-color-bg-surface-magic)",
  caution: "var(--p-color-bg-surface-caution)",
  success: "var(--p-color-bg-surface-success)",
};

// Small uppercase kicker label (dot + text) that sits above a section's
// heading — the one recurring "more color" element across every page.
export function Eyebrow({ children }) {
  return (
    <InlineStack gap="150" blockAlign="center">
      <span
        style={{
          width: 6,
          height: 6,
          borderRadius: "50%",
          background: BRAND_ORANGE,
          display: "inline-block",
        }}
      />
      <span
        style={{
          color: BRAND_ORANGE,
          fontSize: 12,
          fontWeight: 700,
          letterSpacing: "0.06em",
          textTransform: "uppercase",
        }}
      >
        {children}
      </span>
    </InlineStack>
  );
}

// Rounded tinted square behind an Icon — the "KPI card" treatment, reused
// wherever an icon+label row would otherwise be a flat monochrome glyph.
export function IconChip({ icon, tone, size = 32 }) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        width: size,
        height: size,
        borderRadius: size >= 40 ? 10 : 8,
        background: TONE_CHIP_BG[tone] ?? "var(--p-color-bg-surface-secondary)",
        flexShrink: 0,
      }}
    >
      <Icon source={icon} tone={tone} />
    </div>
  );
}

// Small solid-orange circular step number, for numbered flows (the rule
// wizard's steps, "Quick start" cards) instead of plain "Step 1 —" text.
export function StepBadge({ n }) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        width: 24,
        height: 24,
        borderRadius: "50%",
        background: BRAND_ORANGE,
        color: "#fff",
        fontSize: 13,
        fontWeight: 700,
        flexShrink: 0,
      }}
    >
      {n}
    </div>
  );
}

// Solid-fill orange pill for a "most popular / recommended" highlight —
// Polaris's <Badge> can't render a solid brand-color fill, only its fixed
// tone palette, so this is a plain styled span instead.
export function BrandPill({ children }) {
  return (
    <span
      style={{
        display: "inline-block",
        background: BRAND_ORANGE,
        color: "#fff",
        fontSize: 11,
        fontWeight: 700,
        letterSpacing: "0.02em",
        textTransform: "uppercase",
        borderRadius: 999,
        padding: "3px 10px",
      }}
    >
      {children}
    </span>
  );
}
