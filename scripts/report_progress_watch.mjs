// Watches packs/*/pack.json and reports to the Worker only when something changed.
// A status change or a jump of at least 10 stickers is sent at most once per 5 minutes.
// A pack that becomes done and has a packUrl is sent immediately.
// Local files are read every 30 seconds; that does not call the Worker.
//   node scripts/report_progress_watch.mjs
import { readdirSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { reportProgress } from "./report_progress.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PACKS = join(ROOT, "packs");
const STATE_PATH = join(ROOT, ".cache", "progress-watch.json");
const MIN_INTERVAL_MS = 5 * 60 * 1000;
const POLL_MS = 30 * 1000;
const STEP = 10;

function packs() {
  return readdirSync(PACKS).filter((name) => /^\d\d-/.test(name)).sort().map((dir) => {
    const meta = JSON.parse(readFileSync(join(PACKS, dir, "pack.json"), "utf8"));
    const telemost = meta.telemost || {};
    const total = Array.isArray(meta.images) && meta.images.length ? meta.images.length : meta.stickerCount || 0;
    return {
      meta,
      snap: {
        status: telemost.status || "pending",
        uploaded: telemost.uploaded || 0,
        packUrl: telemost.packUrl || null,
        total,
      },
    };
  });
}

function loadState() {
  try { return JSON.parse(readFileSync(STATE_PATH, "utf8")); } catch { return {}; }
}

function saveState(state) {
  mkdirSync(dirname(STATE_PATH), { recursive: true });
  writeFileSync(STATE_PATH, JSON.stringify(state));
}

function due(prev, snap, now) {
  const finished = snap.status === "done" && snap.packUrl
    && (!prev || prev.status !== "done" || prev.packUrl !== snap.packUrl);
  if (finished) return "now";
  const changed = !prev || prev.status !== snap.status || snap.uploaded - (prev.uploaded || 0) >= STEP;
  if (!changed && !prev?.pending) return null;
  if (prev?.sentAt && now - prev.sentAt < MIN_INTERVAL_MS) return "later";
  return "now";
}

async function tick(state) {
  const now = Date.now();
  for (const { meta, snap } of packs()) {
    const prev = state[meta.slug];
    const when = due(prev, snap, now);
    if (when === "later") {
      state[meta.slug] = { ...prev, pending: true };
      continue;
    }
    if (when !== "now") continue;
    const result = await reportProgress(meta);
    if (result.skipped) continue;
    if (!result.ok) continue;
    state[meta.slug] = { ...snap, sentAt: now, pending: false };
    console.log(meta.slug, snap.status, `${snap.uploaded}/${snap.total}`, result.status);
  }
  saveState(state);
}

const state = loadState();
if (!Object.keys(state).length) {
  for (const { meta, snap } of packs()) state[meta.slug] = { ...snap, sentAt: Date.now(), pending: false };
  saveState(state);
  console.log("seeded, no request sent");
}
await tick(state);
setInterval(() => { tick(loadState()).catch((err) => console.error(err.message)); }, POLL_MS);
