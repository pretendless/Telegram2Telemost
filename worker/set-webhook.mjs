// Points @tg2tmbot at this Worker. Do not run while the polling script is still
// calling getUpdates: Telegram delivers each update to only one of them.
//
//   CONFIRM_STOP_POLLING=1 TG2TMBOT_TOKEN=... WEBHOOK_SECRET=... \
//     TG2TM_WEBHOOK_URL=https://<worker>/telegram node set-webhook.mjs

if (process.env.CONFIRM_STOP_POLLING !== "1") {
  console.error("Polling must be stopped first. Set CONFIRM_STOP_POLLING=1 only after that.");
  process.exit(1);
}

const token = process.env.TG2TMBOT_TOKEN || process.env.TELEGRAM_BOT_TOKEN;
const secret = process.env.WEBHOOK_SECRET;
const url = process.env.TG2TM_WEBHOOK_URL;
if (!token || !secret || !url) {
  console.error("Need TG2TMBOT_TOKEN (or TELEGRAM_BOT_TOKEN), WEBHOOK_SECRET and TG2TM_WEBHOOK_URL.");
  process.exit(1);
}

const body = new URLSearchParams({
  url,
  secret_token: secret,
  allowed_updates: JSON.stringify(["message"]),
});
const res = await fetch(`https://api.telegram.org/bot${token}/setWebhook`, { method: "POST", body });
const json = await res.json();
if (!json.ok) {
  console.error(json.description || "setWebhook failed");
  process.exit(1);
}
console.log("webhook set");
