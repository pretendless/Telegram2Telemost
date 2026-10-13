// Choose the pack a restart run will upload. The open dialog wins. An idle
// dialog takes the next stored user request. No pack title is fixed here.
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { isClockLine, restartTarget, screenLine, statusPackName, stickerSetName } from './telemost_upload.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// GITHUB_OUTPUT is name=value per line. Values may include spaces and =, but
// not newlines. Names must stay a single token (no spaces, no JSON).
export function githubOutputValue(value) {
  return String(value ?? '').replace(/[\r\n]+/g, ' ').trimEnd();
}

export function restartGithubOutput({ action, title = '', lastLine = '' } = {}) {
  return [
    `action=${githubOutputValue(action)}`,
    `restart_seen_title=${githubOutputValue(title)}`,
    `restart_seen_last_line=${githubOutputValue(lastLine)}`,
  ].join('\n') + '\n';
}

function catalogs() {
  const packs = join(ROOT, 'packs');
  return readdirSync(packs)
    .filter((dir) => /^\d\d-/.test(dir))
    .map((dir) => {
      const meta = JSON.parse(readFileSync(join(packs, dir, 'pack.json'), 'utf8'));
      return { title: meta.title, dir };
    });
}

async function storedRequests() {
  const secret = process.env.UPLOADER_SECRET || '';
  const progress = process.env.TG2TM_PROGRESS_URL || '';
  if (!secret || !progress) return [];
  const url = progress.replace(/\/progress\/?$/, '/queue/plan');
  const response = await fetch(url, { headers: { authorization: 'Bearer ' + secret } });
  if (!response.ok) throw new Error('queue plan http ' + response.status);
  const data = await response.json();
  return data.items || [];
}

async function focusRequest(id) {
  if (!id) return;
  const secret = process.env.UPLOADER_SECRET || '';
  const progress = process.env.TG2TM_PROGRESS_URL || '';
  if (!secret || !progress) return;
  const url = progress.replace(/\/progress\/?$/, '/queue/claim');
  const response = await fetch(url, {
    method: 'POST',
    headers: { authorization: 'Bearer ' + secret, 'content-type': 'application/json' },
    body: JSON.stringify({ focus: id }),
  });
  if (!response.ok) throw new Error('queue focus http ' + response.status);
}

function writeRequestPack(target) {
  const slug = ('request-' + String(target.requestId || 'next').replace(/[^A-Za-z0-9_-]/g, '')).slice(0, 48);
  const sets = (target.links || []).map((link) => ({ url: link, name: stickerSetName(link) })).filter((set) => set.name);
  if (!sets.length) throw new Error('request has no sticker sets');
  const folder = join(ROOT, 'packs', slug);
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, 'pack.json'), JSON.stringify({
    title: target.title,
    slug,
    stickerLinks: target.links,
    stickerSets: sets,
    telemost: { status: 'pending', uploaded: 0, packUrl: null, error: null },
  }, null, 2) + '\n');
  return slug;
}

function writeGithubOutput(payload) {
  process.stdout.write(restartGithubOutput(payload));
}

async function main() {
  const githubOutput = process.argv.includes('--github-output');
  const choice = JSON.parse(readFileSync(join(ROOT, 'logs', 'restart-choice.json'), 'utf8'));
  const title = statusPackName(choice.title);
  const lastLine = (!isClockLine(choice.lastLine) && choice.lastLine)
    ? String(choice.lastLine).replace(/\s+/g, ' ').trim()
    : screenLine(choice.liveText);
  const seen = { title, lastLine };
  // Keep diagnostics off stdout when that stream is GITHUB_OUTPUT.
  console.error('restart-seen', JSON.stringify(seen));
  const target = restartTarget({
    unfinished: Boolean(choice.unfinished),
    title,
    liveText: choice.liveText || '',
    catalogs: catalogs(),
    requests: await storedRequests(),
  });
  mkdirSync(join(ROOT, 'logs'), { recursive: true });
  if (target.action === 'idle' || target.action === 'seen' || target.action === 'close') {
    writeFileSync(join(ROOT, 'logs', 'restart-pack.json'), JSON.stringify({ ...target, ...seen, liveText: choice.liveText || '' }));
    if (githubOutput) writeGithubOutput({ action: target.action, ...seen });
    // Empty or clock-only title is fine: close the open dialog, or report a
    // real unmatched title as "seen". Neither may write invalid GITHUB_OUTPUT.
    process.exit(0);
  }
  const dir = target.dir || writeRequestPack(target);
  await focusRequest(target.requestId);
  const selected = { ...target, dir, action: target.action };
  writeFileSync(join(ROOT, 'logs', 'restart-pack.json'), JSON.stringify(selected));
  writeFileSync(join(ROOT, 'logs', 'restart-fetch.txt'), join(ROOT, 'packs', dir));
  if (githubOutput) writeGithubOutput({ action: 'upload', ...seen });
  console.error('restart-pack', selected.action, selected.title);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
