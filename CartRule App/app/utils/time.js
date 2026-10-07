// Schedules are entered as wall-clock date + time in the SHOP's timezone
// (Settings → General in Shopify), and stored as UTC ISO strings. These two
// helpers convert between the two without a date library.

function offsetMinutes(utcMs, timeZone) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(new Date(utcMs));
  const get = (type) => Number(parts.find((p) => p.type === type)?.value);
  const asUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));
  return Math.round((asUtc - utcMs) / 60000);
}

/** ("2026-11-20", "00:00", "Europe/Paris") -> "2026-11-19T23:00:00.000Z" */
export function zonedToUtcIso(date, time, timeZone) {
  if (!date) return null;
  const [y, m, d] = date.split("-").map(Number);
  const [hh, mm] = (time || "00:00").split(":").map(Number);
  if (![y, m, d, hh, mm].every(Number.isFinite)) return null;
  const guess = Date.UTC(y, m - 1, d, hh, mm);
  if (!timeZone) return new Date(guess).toISOString();
  // Two passes handle DST boundaries.
  let utc = guess - offsetMinutes(guess, timeZone) * 60000;
  utc = guess - offsetMinutes(utc, timeZone) * 60000;
  return new Date(utc).toISOString();
}

/** "2026-11-19T23:00:00.000Z" + "Europe/Paris" -> { date: "2026-11-20", time: "00:00" } */
export function utcIsoToZoned(iso, timeZone) {
  if (!iso) return { date: "", time: "" };
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return { date: "", time: "" };
  const local = new Date(ms + (timeZone ? offsetMinutes(ms, timeZone) : 0) * 60000);
  const pad = (n) => String(n).padStart(2, "0");
  return {
    date: `${local.getUTCFullYear()}-${pad(local.getUTCMonth() + 1)}-${pad(local.getUTCDate())}`,
    time: `${pad(local.getUTCHours())}:${pad(local.getUTCMinutes())}`,
  };
}
