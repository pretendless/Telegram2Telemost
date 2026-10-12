// Tells the Cloudflare bot about one pack. Upload itself stays in Chrome.
// Without UPLOADER_SECRET the same updates are appended to logs/progress-local.md.
// Run directly to push every packs/*/pack.json:
//   TG2TM_PROGRESS_URL=https://<worker>/progress UPLOADER_SECRET=... node scripts/report_progress.mjs
import { appendFileSync, readdirSync, readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath, pathToFileURL } from "url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

// Local uploader settings. The file is gitignored and never printed.
function loadUploaderEnv() {
  const path = join(ROOT, "config", "uploader.env");
  let raw = "";
  try { raw = readFileSync(path, "utf8"); } catch { return; }
  for (const line of raw.split(/\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq < 1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    if (!process.env[key]) process.env[key] = value;
  }
}
loadUploaderEnv();

const PACKS = join(ROOT, "packs");
const LOCAL_LOG = join(ROOT, "logs", "progress-local.md");
const lastSent = new Map();

// Routine counts wait 5 minutes. A finished pack URL, or an error, is sent at once.
function shouldReport(meta) {
  const telemost = meta.telemost || {};
  const snapshot = JSON.stringify({
    status: telemost.status || "pending",
    uploaded: telemost.uploaded || 0,
    packUrl: telemost.packUrl || null,
    error: telemost.error || null,
  });
  const prev = lastSent.get(meta.slug);
  if (prev && prev.snapshot === snapshot) return false;
  const immediate = (telemost.status === "done" && telemost.packUrl) || telemost.status === "error";
  if (prev && !immediate && Date.now() - prev.at < 5 * 60 * 1000) return false;
  lastSent.set(meta.slug, { snapshot, at: Date.now() });
  return true;
}

function logLocal(meta, note) {
  const telemost = meta.telemost || {};
  const total = Array.isArray(meta.images) && meta.images.length ? meta.images.length : meta.stickerCount || 0;
  const line = `| ${new Date().toISOString().slice(0, 16).replace("T", " ")} | ${meta.slug} | ${telemost.status || "pending"} | ${telemost.uploaded || 0}/${total} | ${telemost.packUrl || ""} | ${(telemost.error || note || "").replace(/\|/g, "/").replace(/\n/g, " ")} |\n`;
  try { appendFileSync(LOCAL_LOG, line); } catch { /* local log is best-effort */ }
}

export async function reportProgress(meta) {
  if (!shouldReport(meta)) return { skipped: true, reason: "unchanged or throttled" };
  const url = process.env.TG2TM_PROGRESS_URL || "https://tg2tmbot.prtndz.workers.dev/progress";
  const secret = process.env.UPLOADER_SECRET;
  if (!secret) {
    logLocal(meta, "UPLOADER_SECRET missing");
    return { skipped: true, reason: "UPLOADER_SECRET missing" };
  }
  const telemost = meta.telemost || {};
  const total = Array.isArray(meta.images) && meta.images.length ? meta.images.length : meta.stickerCount || 0;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${secret}`,
      },
      body: JSON.stringify({
        slug: meta.slug,
        title: meta.title,
        source: meta.sourceMessage || null,
        status: telemost.status || "pending",
        uploaded: telemost.uploaded || 0,
        total,
        packUrl: telemost.packUrl || null,
        error: telemost.error || null,
      }),
      signal: AbortSignal.timeout(20000),
    });
    if (!res.ok) {
      const text = await res.text();
      console.error("progress report", meta.slug, res.status, text.slice(0, 200));
    }
    return { ok: res.ok, status: res.status };
  } catch (err) {
    console.error("progress report failed", meta.slug, err.message);
    return { ok: false, error: err.message };
  }
}

async function main() {
  if (!process.env.TG2TM_PROGRESS_URL || !process.env.UPLOADER_SECRET) {
    console.error("Set TG2TM_PROGRESS_URL and UPLOADER_SECRET.");
    process.exit(1);
  }
  let failed = 0;
  for (const dir of readdirSync(PACKS).filter((name) => /^\d\d-/.test(name)).sort()) {
    const meta = JSON.parse(readFileSync(join(PACKS, dir, "pack.json"), "utf8"));
    try {
      const result = await reportProgress(meta);
      if (!result.ok) failed++;
      else console.log(dir, result.status);
    } catch (err) {
      failed++;
      console.error(dir, err.message);
    }
  }
  process.exit(failed ? 1 : 0);
}

const invoked = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invoked) await main();
