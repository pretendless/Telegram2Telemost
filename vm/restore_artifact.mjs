// Download the newest encrypted session artifact for one account.
// The file stays ciphertext. GH_TOKEN is the job's GITHUB_TOKEN, not a cookie.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { ACCOUNT_RE, githubHeaders } from "./dispatch.js";

export function artifactName(account) {
  if (!ACCOUNT_RE.test(account || "")) throw new Error("account");
  return `telemost-session-${account}`;
}

export function latestArtifact(artifacts, name) {
  const rows = (artifacts || []).filter((row) => row && row.name === name && !row.expired && row.id != null);
  rows.sort((a, b) => String(b.created_at || "").localeCompare(String(a.created_at || "")));
  return rows[0] || null;
}

export function findSessionFile(root, account) {
  const want = `${account}.tg2tm-session`;
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    let entries = [];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) stack.push(path);
      else if (entry.name === want) return path;
    }
  }
  return "";
}

async function downloadZip(fetchImpl, token, url) {
  const first = await fetchImpl(url, { headers: githubHeaders(token), redirect: "manual" });
  if (first.status >= 300 && first.status < 400) {
    const location = first.headers.get("location") || "";
    if (!/^https:\/\//.test(location)) throw new Error("redirect");
    return fetchImpl(location, { redirect: "follow" });
  }
  return first;
}

function defaultUnzip(buffer, dir) {
  const zipPath = join(dir, "artifact.zip");
  const out = join(dir, "unzipped");
  mkdirSync(out, { recursive: true });
  writeFileSync(zipPath, buffer);
  const res = spawnSync("unzip", ["-o", zipPath, "-d", out], { encoding: "utf8" });
  if (res.status !== 0) throw new Error("unzip failed");
  return out;
}

export async function restoreArtifact(env, deps = {}) {
  const account = env.ACCOUNT;
  const name = artifactName(account);
  const dir = env.SESSION_DIR || "sessions";
  mkdirSync(dir, { recursive: true });
  const dest = join(dir, `${account}.tg2tm-session`);
  if (existsSync(dest) && env.FORCE !== "1") return { ok: true, path: dest, source: "local" };
  if (!env.GH_TOKEN || !env.GH_REPO) return { ok: false, reason: "no-session" };
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(env.GH_REPO)) throw new Error("repo");

  const fetchImpl = deps.fetch || fetch;
  const listUrl =
    `https://api.github.com/repos/${env.GH_REPO}/actions/artifacts?name=${encodeURIComponent(name)}&per_page=20`;
  const listRes = await fetchImpl(listUrl, { headers: githubHeaders(env.GH_TOKEN) });
  if (!listRes.ok) return { ok: false, reason: "github", status: listRes.status };
  const list = await listRes.json();
  const artifact = latestArtifact(list.artifacts, name);
  if (!artifact) return { ok: false, reason: "no-session" };

  const zipRes = await downloadZip(
    fetchImpl,
    env.GH_TOKEN,
    `https://api.github.com/repos/${env.GH_REPO}/actions/artifacts/${artifact.id}/zip`,
  );
  if (!zipRes.ok) return { ok: false, reason: "github", status: zipRes.status };
  const bytes = Buffer.from(await zipRes.arrayBuffer());
  const work = deps.workdir || join(tmpdir(), `tg2tm-${account}-${artifact.id}`);
  mkdirSync(work, { recursive: true });
  const unzip = deps.unzip || defaultUnzip;
  const root = await unzip(bytes, work);
  const found = findSessionFile(root, account);
  if (!found) return { ok: false, reason: "no-session" };
  writeFileSync(dest, readFileSync(found), { mode: 0o600 });
  return { ok: true, path: dest, source: "artifact" };
}

async function main() {
  const result = await restoreArtifact(process.env);
  if (!result.ok && result.reason === "github") {
    console.error("github artifact download failed", result.status || "");
    process.exit(1);
  }
  if (result.ok) console.log(result.source);
  else console.log("no-session");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err && err.message ? err.message : "restore failed");
    process.exit(1);
  });
}
