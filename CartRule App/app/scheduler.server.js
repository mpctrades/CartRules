// Background jobs, run in-process once a minute:
//  1. Scheduled rules — when a rule's start or end time passes, rebuild that
//     shop's checkout cache so the rule switches on/off on time
//     (ShopState.nextScheduleAt is written by syncRulesCache).
//  2. Email notifications (only with SMTP configured): new rule issues,
//     reminders the day before a scheduled rule starts, weekly summary.
//  3. Daily cleanup of activity older than any plan can show.
import db from "./db.server";
import { unauthenticated } from "./shopify.server";
import { syncRulesCache, listRules } from "./models/rules.server";
import { getSettings } from "./models/settings.server";
import { getRulesHealth } from "./models/health.server";
import { getKpis, purgeOldEvents } from "./models/events.server";
import { notificationsAvailable, sendMerchantEmail } from "./models/notifications.server";
import { formatDateTime } from "./models/ruleDisplay";
import { RULE_STATUS } from "./models/ruleConstants";

const TICK_MS = 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
let running = false;
let lastPurge = 0;
let lastNotify = 0;

async function shopAdmin(shop) {
  const { admin } = await unauthenticated.admin(shop);
  return admin;
}

async function runSchedules() {
  const due = await db.shopState.findMany({ where: { nextScheduleAt: { lte: new Date() } } });
  for (const state of due) {
    try {
      // Clear first so a failing shop isn't retried every minute forever;
      // a successful sync writes the next boundary back.
      await db.shopState.update({ where: { shop: state.shop }, data: { nextScheduleAt: null } });
      await syncRulesCache(await shopAdmin(state.shop), { activateValidation: false });
      console.log("Scheduled rules applied", { shop: state.shop });
    } catch (error) {
      console.error("Scheduled rule sync failed", { shop: state.shop, error: error?.message ?? String(error) });
      // Retry in 5 minutes.
      await db.shopState
        .update({ where: { shop: state.shop }, data: { nextScheduleAt: new Date(Date.now() + 5 * 60 * 1000) } })
        .catch(() => {});
    }
  }
}

async function shopEmail(admin) {
  const response = await admin.graphql(`#graphql
    query CartRulesShopEmail { shop { email ianaTimezone } }`);
  const json = await response.json();
  return { email: json.data?.shop?.email, timezone: json.data?.shop?.ianaTimezone };
}

async function notifyShop(shop) {
  const admin = await shopAdmin(shop);
  const settings = await getSettings(admin);
  const prefs = settings.notifications ?? {};
  if (!prefs.ruleErrors && !prefs.weeklySummary && !prefs.scheduleReminders) return;
  const [{ email, timezone }, rules, state] = await Promise.all([
    shopEmail(admin),
    listRules(admin),
    db.shopState.findUnique({ where: { shop } }),
  ]);
  if (!email) return;
  const now = Date.now();
  const updates = {};

  if (prefs.ruleErrors && (!state?.lastHealthCheck || now - state.lastHealthCheck.getTime() > DAY_MS)) {
    updates.lastHealthCheck = new Date();
    // Plan doesn't matter for "deleted targets"-style issues; use Pro so
    // plan-limit notes (shown in the app) aren't emailed.
    const { health } = await getRulesHealth(admin, shop, rules, { plan: "Pro", conflictMode: settings.conflictMode });
    const issues = rules
      .filter((r) => r.status === RULE_STATUS.ACTIVE)
      .flatMap((r) => (health[r.id]?.issues ?? []).map((i) => `• ${r.title}: ${i.message}`));
    const key = issues.join("|");
    if (issues.length && key !== state?.lastIssueKey) {
      await sendMerchantEmail(email, "CartRules: a rule needs attention", [
        "These CartRules rules need attention:",
        "",
        ...issues,
        "",
        "Open CartRules → Rules to fix them.",
      ]);
    }
    updates.lastIssueKey = key;
  }

  if (prefs.scheduleReminders) {
    const reminded = new Set(JSON.parse(state?.remindedRuleIds ?? "[]"));
    const upcoming = rules.filter((r) => {
      const start = r.schedule?.startsAt ? Date.parse(r.schedule.startsAt) : NaN;
      return r.status === RULE_STATUS.ACTIVE && start > now && start - now <= DAY_MS && !reminded.has(`${r.id}@${r.schedule.startsAt}`);
    });
    if (upcoming.length) {
      await sendMerchantEmail(email, "CartRules: scheduled rules start soon", [
        "These rules start within the next 24 hours:",
        "",
        ...upcoming.map((r) => `• ${r.title} — starts ${formatDateTime(r.schedule.startsAt, timezone)}`),
      ]);
      for (const r of upcoming) reminded.add(`${r.id}@${r.schedule.startsAt}`);
      updates.remindedRuleIds = JSON.stringify([...reminded].slice(-200));
    }
  }

  if (prefs.weeklySummary && (!state?.lastWeeklySummary || now - state.lastWeeklySummary.getTime() >= 7 * DAY_MS)) {
    const range = { start: new Date(now - 7 * DAY_MS), end: new Date(now) };
    const k = await getKpis(shop, range);
    const live = rules.filter((r) => r.status === RULE_STATUS.ACTIVE).length;
    await sendMerchantEmail(email, "Your weekly CartRules summary", [
      `Active rules: ${live}`,
      `Rule triggers (last 7 days): ${k.triggers.value}`,
      `Discounts blocked: ${k.discountsBlocked.value}`,
      `Quantity violations: ${k.quantityViolations.value}`,
      `Protected carts: ${k.checkoutsProtected.value}`,
      "",
      "Counts come from the CartRules storefront blocks on your product and cart pages.",
    ]);
    updates.lastWeeklySummary = new Date();
  }

  if (Object.keys(updates).length) {
    await db.shopState.upsert({ where: { shop }, create: { shop, ...updates }, update: updates });
  }
}

async function runNotifications() {
  if (!notificationsAvailable()) return;
  const shops = await db.session.findMany({ where: { isOnline: false }, select: { shop: true }, distinct: ["shop"] });
  for (const { shop } of shops) {
    try {
      await notifyShop(shop);
    } catch (error) {
      console.error("Notification run failed", { shop, error: error?.message ?? String(error) });
    }
  }
}

async function tick() {
  if (running) return;
  running = true;
  try {
    await runSchedules();
    if (Date.now() - lastNotify > 60 * 60 * 1000) {
      lastNotify = Date.now();
      await runNotifications();
    }
    if (Date.now() - lastPurge > DAY_MS) {
      lastPurge = Date.now();
      await purgeOldEvents();
    }
  } catch (error) {
    console.error("Scheduler tick failed", error);
  } finally {
    running = false;
  }
}

/** Starts the loop once per process (dev HMR re-imports this module). */
export function startScheduler() {
  if (global.__cartrulesScheduler || process.env.CARTRULES_DISABLE_SCHEDULER === "1") return;
  global.__cartrulesScheduler = setInterval(tick, TICK_MS);
  global.__cartrulesScheduler.unref?.();
  setTimeout(tick, 10 * 1000).unref?.();
}
