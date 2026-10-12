// Claims priority pack requests from the Worker and uploads them only when no
// Telemost upload is already running. The original 01–08 sequence is never
// reordered or interrupted: unfinished numbered packs are resumed first, in
// order, and a claimed request runs only after those.
//
// The Worker route is not live yet. This polls POST /request/next with the
// same bearer token as /progress and treats 404 as "not exposed yet".
// A claimed body is { id, title, links } or { request: { id, title, links } }.
// A requester chat id, if the Worker sends one, is stored only in the
// gitignored config/priority-requests.json. It is not written to pack.json
// or the transfer log.
//
//   node scripts/priority_queue.mjs
import { spawn, spawnSync } from "child_process";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { reportProgress } from "./report_progress.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PACKS = join(ROOT, "packs");
const IDS_PATH = join(ROOT, "config", "priority-requests.json");
const POLL_MS = 5 * 60 * 1000;

function loadIds() {
  try { return JSON.parse(readFileSync(IDS_PATH, "utf8")); } catch { return {}; }
}

function saveIds(ids) {
  mkdirSync(dirname(IDS_PATH), { recursive: true });
  writeFileSync(IDS_PATH, JSON.stringify(ids));
}

function readPack(dir) {
  try { return JSON.parse(readFileSync(join(PACKS, dir, "pack.json"), "utf8")); } catch { return null; }
}

function unfinishedNumbered() {
  return readdirSync(PACKS).filter((name) => /^\d\d-/.test(name)).sort().filter((name) => {
    const meta = readPack(name);
    return meta && (meta.telemost || {}).status !== "done";
  });
}

function uploadRunning() {
  // pgrep -f prints pids only. The pattern matches the live uploader and its shell, not this watcher.
  const result = spawnSync("pgrep", ["-f", "scripts/telemost_upload.mjs"], { encoding: "utf8" });
  return result.stdout.split("\n").some((pid) => pid.trim() && pid.trim() !== String(process.pid));
}

function run(cmd, args) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd: ROOT, stdio: "inherit" });
    child.on("exit", (code) => resolve(code || 0));
  });
}

async function claim() {
  const url = (process.env.TG2TM_PROGRESS_URL || "").replace(/\/progress$/, "") + "/request/next";
  const secret = process.env.UPLOADER_SECRET;
  if (!process.env.TG2TM_PROGRESS_URL || !secret) return { missing: true };
  const res = await fetch(url, {
    method: "POST",
    headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" },
    body: "{}",
    signal: AbortSignal.timeout(20000),
  });
  if (res.status === 204 || res.status === 404) return { empty: true, status: res.status };
  const body = await res.json().catch(() => ({}));
  if (!res.ok) return { error: res.status };
  const request = body.request || body;
  if (!request || !request.id || !request.title || !Array.isArray(request.links) || !request.links.length) return { empty: true };
  return { request };
}

function materialize(request) {
  const id = String(request.id).replace(/[^A-Za-z0-9_-]/g, "").slice(0, 40);
  const dir = `q-${id}`;
  const folder = join(PACKS, dir);
  mkdirSync(folder, { recursive: true });
  const links = request.links.map(String);
  const meta = {
    title: String(request.title).slice(0, 120),
    slug: dir,
    sourceMessage: null,
    stickerLinks: links,
    stickerSets: links.map((link) => ({ url: link, name: link.split("/").pop(), telegramTitle: null, stickerCount: null })),
    stickerCount: null,
    images: [],
    telemost: { status: "pending", uploaded: 0, packUrl: null, error: null, priority: true },
  };
  writeFileSync(join(folder, "pack.json"), JSON.stringify(meta, null, 2) + "\n");
  if (request.chatId != null) {
    const ids = loadIds();
    ids[id] = String(request.chatId);
    saveIds(ids);
  }
  return dir;
}

async function once() {
  if (uploadRunning()) return;
  const todo = unfinishedNumbered();
  if (todo.length) {
    console.log("resume numbered packs first", todo.join(" "));
    await run("node", ["scripts/telemost_upload.mjs", ...todo]);
    return;
  }
  let claimed;
  try {
    claimed = await claim();
  } catch (err) {
    console.error("priority claim failed", err.message);
    return;
  }
  if (!claimed.request) {
    if (claimed.status === 404) console.log("priority endpoint not exposed yet");
    return;
  }
  const dir = materialize(claimed.request);
  console.log("claimed priority", dir);
  const converted = await run("python3", ["scripts/fetch_and_convert.py", "--dir", join(PACKS, dir)]);
  if (converted !== 0) return;
  await run("node", ["scripts/telemost_upload.mjs", dir]);
  const meta = readPack(dir);
  if (meta) await reportProgress(meta);
}

let busy = false;
async function guarded() {
  if (busy) return;
  busy = true;
  try { await once(); } finally { busy = false; }
}

await guarded();
setInterval(() => { guarded().catch((err) => console.error(err.message)); }, POLL_MS);
