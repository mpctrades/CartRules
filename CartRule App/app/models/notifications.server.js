// Merchant email notifications (Settings → Notifications). Sent only when an
// SMTP server is configured (SMTP_URL, e.g. smtps://user:pass@smtp.host:465,
// plus SMTP_FROM). Without it the Settings page shows the section as
// unavailable instead of offering switches that do nothing.
import nodemailer from "nodemailer";

let transport = null;

export function notificationsAvailable() {
  return Boolean(process.env.SMTP_URL);
}

function getTransport() {
  if (!notificationsAvailable()) return null;
  if (!transport) transport = nodemailer.createTransport(process.env.SMTP_URL);
  return transport;
}

export async function sendMerchantEmail(to, subject, lines) {
  const t = getTransport();
  if (!t || !to) return false;
  const text = [...lines, "", "— CartRules", "You can change these emails in CartRules → Settings → Notifications."].join("\n");
  await t.sendMail({
    from: process.env.SMTP_FROM || "CartRules <no-reply@cartrules.mpctrades.com>",
    to,
    subject,
    text,
  });
  return true;
}
