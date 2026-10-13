// Choose the pack a restart run will upload. The open dialog wins. An idle
// dialog takes the next stored user request. No pack title is fixed here.
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { restartTarget, stickerSetName } from './telemost_upload.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

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

const choice = JSON.parse(readFileSync(join(ROOT, 'logs', 'restart-choice.json'), 'utf8'));
const target = restartTarget({
  unfinished: Boolean(choice.unfinished),
  title: choice.title || '',
  catalogs: catalogs(),
  requests: await storedRequests(),
});
mkdirSync(join(ROOT, 'logs'), { recursive: true });
if (target.action === 'idle' || target.action === 'missing') {
  writeFileSync(join(ROOT, 'logs', 'restart-pack.json'), JSON.stringify(target));
  if (process.argv.includes('--github-output')) process.stdout.write(`action=${target.action}\n`);
  if (target.action === 'missing') {
    console.error('open pack was not matched');
    process.exit(1);
  }
  process.exit(0);
}
const dir = target.dir || writeRequestPack(target);
await focusRequest(target.requestId);
const selected = { ...target, dir, action: target.action };
writeFileSync(join(ROOT, 'logs', 'restart-pack.json'), JSON.stringify(selected));
writeFileSync(join(ROOT, 'logs', 'restart-fetch.txt'), join(ROOT, 'packs', dir));
if (process.argv.includes('--github-output')) process.stdout.write('action=upload\n');
console.log('restart-pack', selected.action, selected.title);
