// Client-safe event time/source formatting in the shop's timezone. Event
// type labels and the attempted/allowed line live in ruleDisplay.js
// (EVENT_LABELS, describeEvent).

export const SOURCE_LABELS = { storefront: "Storefront", test: "Test", order: "Order" };

function dayKey(date, timeZone) {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
}

/** "Today, 15:42" / "Yesterday, 09:10" / "Oct 3, 15:42" in the shop's timezone. */
export function formatEventTime(iso, timeZone, now = new Date()) {
  const date = new Date(iso);
  const tz = timeZone || undefined;
  let time;
  try {
    time = new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: tz }).format(date);
    const today = dayKey(now, tz);
    const yesterday = dayKey(new Date(now.getTime() - 24 * 60 * 60 * 1000), tz);
    const key = dayKey(date, tz);
    if (key === today) return `Today, ${time}`;
    if (key === yesterday) return `Yesterday, ${time}`;
    const day = new Intl.DateTimeFormat(undefined, {
      month: "short",
      day: "numeric",
      ...(date.getFullYear() !== now.getFullYear() ? { year: "numeric" } : {}),
      timeZone: tz,
    }).format(date);
    return `${day}, ${time}`;
  } catch (_e) {
    return date.toISOString();
  }
}
