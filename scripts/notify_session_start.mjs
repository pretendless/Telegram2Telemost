// GitHub Actions: tell the Worker admin chat that this run started (once per run id).
import { enrichDispatchReason } from "../vm/dispatch_reason.js";
import { defaultPacksRoot, titlesForPackNumbers } from "../vm/pack_titles.js";
import { defaultSessionReason } from "../vm/session_notify.js";

const url = process.env.TG2TM_SESSION_NOTIFY_URL
  || String(process.env.TG2TM_PROGRESS_URL || "").replace(/\/progress\/?$/i, "/session-started");
const secret = process.env.UPLOADER_SECRET || "";
const runId = String(process.env.RUN_ID || process.env.GITHUB_RUN_ID || "").trim();
const runUrl = String(process.env.RUN_URL || "").trim();
const mode = process.env.MODE || process.env.INPUT_MODE || "";
const packs = process.env.PACKS || process.env.INPUT_PACKS || "";
const reason = enrichDispatchReason({
  dispatchReason: String(process.env.DISPATCH_REASON || "").trim(),
  mode,
  packs,
  resolveTitles: (nums) => titlesForPackNumbers(nums, defaultPacksRoot(import.meta.url)),
}) || defaultSessionReason(mode);

async function main() {
  if (!url || !secret || !runId) {
    console.log("session notify skipped");
    return;
  }
  const response = await fetch(url, {
    method: "POST",
    headers: {
      authorization: "Bearer " + secret,
      "content-type": "application/json",
      "user-agent": "tg2tm-session-notify",
    },
    body: JSON.stringify({ runId, url: runUrl, reason }),
  });
  if (!response.ok) {
    console.error("session notify http", response.status);
    process.exit(1);
  }
}

await main();
