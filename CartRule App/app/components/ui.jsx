// Shared CartRules UI building blocks (layout in app/styles/cartrules.css).
// Every page uses these so spacing, cards, statuses and charts look the same.
import { useMemo, useState } from "react";
import { Badge, Button, Icon, Popover, Text, TextField, BlockStack, InlineStack } from "@shopify/polaris";
import { CalendarIcon } from "@shopify/polaris-icons";
import { DISPLAY_STATUS_INFO } from "../models/ruleConstants";

export function AppPage({ title, subtitle, actions, back, children }) {
  return (
    <div className="cr-page">
      {back ? <div style={{ marginBottom: 8 }}>{back}</div> : null}
      <div className="cr-page-header">
        <div style={{ minWidth: 0 }}>
          <h1 className="cr-page-title">{title}</h1>
          {subtitle ? <p className="cr-page-subtitle">{subtitle}</p> : null}
        </div>
        {actions ? <div className="cr-page-actions">{actions}</div> : null}
      </div>
      <div className="cr-stack">{children}</div>
    </div>
  );
}

export function Box({ title, subtitle, actions, children, flush, accent, style }) {
  return (
    <section className={`cr-card${flush ? " cr-card--flush" : ""}${accent ? " cr-card--accent" : ""}`} style={style}>
      {title || actions ? (
        <div className="cr-card-header" style={flush ? { padding: "20px 24px 0" } : undefined}>
          <div style={{ minWidth: 0 }}>
            {title ? <h2 className="cr-card-title">{title}</h2> : null}
            {subtitle ? <div className="cr-muted" style={{ marginTop: 2 }}>{subtitle}</div> : null}
          </div>
          {actions ? <InlineStack gap="200" blockAlign="center">{actions}</InlineStack> : null}
        </div>
      ) : null}
      {children}
    </section>
  );
}

/** Rule status badge — soft green / gray / blue / amber per the design rules. */
export function StatusBadge({ status }) {
  const info = DISPLAY_STATUS_INFO[status] ?? { label: status };
  return (
    <Badge tone={info.tone} progress={status === "active" ? "complete" : undefined}>
      {info.label}
    </Badge>
  );
}

/** Inline status text with a dot: ok / warn / off / bad. */
export function StatusText({ kind = "ok", children }) {
  const colors = {
    ok: "var(--p-color-bg-fill-success)",
    warn: "var(--p-color-bg-fill-caution)",
    off: "var(--p-color-border)",
    bad: "var(--p-color-bg-fill-critical)",
  };
  return (
    <span className={`cr-status cr-status--${kind}`}>
      <span className="cr-dot" style={{ background: colors[kind] }} />
      {children}
    </span>
  );
}

export function formatNumber(n) {
  return new Intl.NumberFormat().format(Number(n) || 0);
}

/** KPI card: label, big number, change vs previous period (or "No activity yet"). */
export function KpiCard({ label, value, changePct, hint }) {
  let delta;
  if (!value) {
    delta = <span className="cr-muted">No activity yet</span>;
  } else if (changePct == null) {
    delta = <span className="cr-muted">New this period</span>;
  } else if (changePct === 0) {
    delta = <span className="cr-muted">No change vs previous period</span>;
  } else {
    // More enforcement isn't "bad" — show direction neutrally in color.
    delta = (
      <span className={`cr-delta ${changePct > 0 ? "cr-delta--up" : "cr-delta--down"}`}>
        {changePct > 0 ? "↑" : "↓"} {Math.abs(changePct)}% <span className="cr-muted">vs previous period</span>
      </span>
    );
  }
  return (
    <div className="cr-card" title={hint}>
      <div className="cr-kpi-label">{label}</div>
      <div className="cr-kpi-value">{formatNumber(value)}</div>
      {delta}
    </div>
  );
}

export function ProgressLine({ value, max }) {
  const pct = max ? Math.round((value / max) * 100) : 0;
  return (
    <div className="cr-progress" role="progressbar" aria-valuenow={value} aria-valuemin={0} aria-valuemax={max}>
      <span style={{ width: `${pct}%` }} />
    </div>
  );
}

export function Segmented({ options, value, onChange, label }) {
  return (
    <div className="cr-segmented" role="group" aria-label={label}>
      {options.map((o) => (
        <button key={o.value} type="button" aria-pressed={value === o.value} onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function EmptyBlock({ icon, title, children, action }) {
  return (
    <div className="cr-empty">
      {icon ? (
        <div className="cr-empty-icon">
          <Icon source={icon} />
        </div>
      ) : null}
      <div className="cr-empty-title">{title}</div>
      {children ? (
        <div className="cr-muted" style={{ maxWidth: 420, margin: "0 auto" }}>
          {children}
        </div>
      ) : null}
      {action ? <div style={{ marginTop: 16 }}>{action}</div> : null}
    </div>
  );
}

function shortDate(iso) {
  const d = new Date(`${iso}T00:00:00Z`);
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric", timeZone: "UTC" });
}

/** Area chart of daily counts — inline SVG, no chart library. */
export function ActivityChart({ series, height = 220, label = "events" }) {
  const [hover, setHover] = useState(null);
  const width = 720;
  const pad = { top: 12, right: 12, bottom: 26, left: 36 };
  const max = Math.max(1, ...series.map((p) => p.count));
  const niceMax = max <= 4 ? 4 : Math.ceil(max / 4) * 4;
  const innerW = width - pad.left - pad.right;
  const innerH = height - pad.top - pad.bottom;
  const x = (i) => pad.left + (series.length <= 1 ? innerW / 2 : (i / (series.length - 1)) * innerW);
  const y = (v) => pad.top + innerH - (v / niceMax) * innerH;

  const { line, area } = useMemo(() => {
    if (series.length === 0) return { line: "", area: "" };
    const pts = series.map((p, i) => `${x(i).toFixed(1)},${y(p.count).toFixed(1)}`);
    return {
      line: `M${pts.join(" L")}`,
      area: `M${x(0).toFixed(1)},${y(0)} L${pts.join(" L")} L${x(series.length - 1).toFixed(1)},${y(0)} Z`,
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [series, niceMax]);

  const ticks = [0, niceMax / 4, niceMax / 2, (3 * niceMax) / 4, niceMax];
  const labelEvery = Math.max(1, Math.ceil(series.length / 7));

  return (
    <div className="cr-chart">
      <svg
        viewBox={`0 0 ${width} ${height}`}
        role="img"
        aria-label={`Daily ${label}`}
        onMouseLeave={() => setHover(null)}
        onMouseMove={(e) => {
          const rect = e.currentTarget.getBoundingClientRect();
          const px = ((e.clientX - rect.left) / rect.width) * width;
          const i = Math.round(((px - pad.left) / innerW) * (series.length - 1));
          if (i >= 0 && i < series.length) setHover(i);
        }}
      >
        <defs>
          <linearGradient id="crArea" x1="0" x2="0" y1="0" y2="1">
            <stop offset="0%" stopColor="#ff5a1f" stopOpacity="0.22" />
            <stop offset="100%" stopColor="#ff5a1f" stopOpacity="0" />
          </linearGradient>
        </defs>
        {ticks.map((t) => (
          <g key={t}>
            <line x1={pad.left} x2={width - pad.right} y1={y(t)} y2={y(t)} stroke="#ebebeb" />
            <text x={pad.left - 8} y={y(t) + 4} textAnchor="end" fontSize="11" fill="#8a8a8a">
              {Number.isInteger(t) ? t : ""}
            </text>
          </g>
        ))}
        {series.map((p, i) =>
          i % labelEvery === 0 || i === series.length - 1 ? (
            <text key={p.date} x={x(i)} y={height - 6} textAnchor="middle" fontSize="11" fill="#8a8a8a">
              {shortDate(p.date)}
            </text>
          ) : null,
        )}
        <path d={area} fill="url(#crArea)" />
        <path d={line} fill="none" stroke="#ff5a1f" strokeWidth="2" strokeLinejoin="round" />
        {hover != null ? (
          <g>
            <line x1={x(hover)} x2={x(hover)} y1={pad.top} y2={pad.top + innerH} stroke="#d4d4d4" />
            <circle cx={x(hover)} cy={y(series[hover].count)} r="4" fill="#fff" stroke="#ff5a1f" strokeWidth="2" />
          </g>
        ) : null}
      </svg>
      {hover != null ? (
        <div
          className="cr-chart-tooltip"
          style={{ left: `${(x(hover) / width) * 100}%`, top: `${(y(series[hover].count) / height) * 100}%` }}
        >
          {shortDate(series[hover].date)} · {formatNumber(series[hover].count)} {label}
        </div>
      ) : null}
    </div>
  );
}

/** Horizontal bar list (top rules / products / types). */
export function BarList({ items, empty = "No data yet" }) {
  const max = Math.max(1, ...items.map((i) => i.count));
  if (items.length === 0) return <Text tone="subdued">{empty}</Text>;
  return (
    <div className="cr-list">
      {items.map((item) => (
        <div key={item.key} className="cr-list-row" style={{ display: "block" }}>
          <InlineStack align="space-between" blockAlign="center" wrap={false} gap="200">
            <span className="cr-truncate" style={{ fontSize: 14 }}>
              {item.label}
            </span>
            <Text as="span" fontWeight="semibold">
              {formatNumber(item.count)}
            </Text>
          </InlineStack>
          <div className="cr-bar" style={{ marginTop: 6 }}>
            <span style={{ width: `${Math.round((item.count / max) * 100)}%` }} />
          </div>
        </div>
      ))}
    </div>
  );
}

export const RANGE_PRESETS = [
  { label: "Last 7 days", value: "7" },
  { label: "Last 30 days", value: "30" },
  { label: "Last 90 days", value: "90" },
];

/**
 * Date range picker: presets + Custom (from/to). Calls onChange with
 * { days } or { from, to } (YYYY-MM-DD). `maxDays` greys out presets the
 * plan's history doesn't cover.
 */
export function RangePicker({ value, onChange, maxDays = 365, allowCustom = true }) {
  const [open, setOpen] = useState(false);
  const [from, setFrom] = useState(value.from ?? "");
  const [to, setTo] = useState(value.to ?? "");
  const current = value.from
    ? `${value.from} – ${value.to || "today"}`
    : (RANGE_PRESETS.find((p) => p.value === String(value.days))?.label ?? `Last ${value.days} days`);
  return (
    <Popover
      active={open}
      onClose={() => setOpen(false)}
      activator={
        <Button icon={CalendarIcon} disclosure onClick={() => setOpen((o) => !o)}>
          {current}
        </Button>
      }
      preferredAlignment="right"
    >
      <div style={{ padding: 12, width: 260 }}>
        <BlockStack gap="200">
          {RANGE_PRESETS.map((p) => {
            const locked = Number(p.value) > maxDays;
            return (
              <Button
                key={p.value}
                variant={!value.from && String(value.days) === p.value ? "primary" : "tertiary"}
                textAlign="start"
                fullWidth
                disabled={locked}
                onClick={() => {
                  setOpen(false);
                  onChange({ days: p.value });
                }}
              >
                {p.label}
                {locked ? " (upgrade)" : ""}
              </Button>
            );
          })}
          {allowCustom ? (
            <BlockStack gap="200">
              <Text as="p" variant="bodySm" tone="subdued">
                Custom range
              </Text>
              <TextField label="From" type="date" value={from} onChange={setFrom} autoComplete="off" />
              <TextField label="To" type="date" value={to} onChange={setTo} autoComplete="off" />
              <Button
                disabled={!from}
                onClick={() => {
                  setOpen(false);
                  onChange({ from, to });
                }}
              >
                Apply
              </Button>
              <Text as="p" variant="bodySm" tone="subdued">
                Your plan keeps {maxDays} days of activity.
              </Text>
            </BlockStack>
          ) : null}
        </BlockStack>
      </div>
    </Popover>
  );
}

/** Reads ?days= / ?from=&to= into a RangePicker value. */
export function rangeFromSearch(searchParams, fallbackDays = 30) {
  const from = searchParams.get("from");
  if (from) return { from, to: searchParams.get("to") ?? "" };
  return { days: searchParams.get("days") ?? String(fallbackDays) };
}

/** Writes a RangePicker value back into URLSearchParams. */
export function applyRange(searchParams, range) {
  const next = new URLSearchParams(searchParams);
  next.delete("days");
  next.delete("from");
  next.delete("to");
  if (range.from) {
    next.set("from", range.from);
    if (range.to) next.set("to", range.to);
  } else {
    next.set("days", range.days);
  }
  return next;
}
