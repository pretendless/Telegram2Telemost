// Tells the Cloudflare bot about one pack. Upload itself stays in Chrome.
// Skips quietly when TG2TM_PROGRESS_URL or UPLOADER_SECRET is unset, so a local
// upload still works. Run directly to push every packs/*/pack.json:
//   TG2TM_PROGRESS_URL=https://<worker>/progress UPLOADER_SECRET=... node scripts/report_progress.mjs
import { readdirSync, readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath, pathToFileURL } from "url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PACKS = join(ROOT, "packs");

export async function reportProgress(meta) {
  const url = process.env.TG2TM_PROGRESS_URL;
  const secret = process.env.UPLOADER_SECRET;
  if (!url || !secret) return { skipped: true };
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
