// Fills telemost.packUrl for finished packs from the "Набор «…» сохранён и доступен по ссылке" messages
// in the Telemost «Стикеры» chat. The link is an <a> in that message, not plain text.
// Usage: node scripts/telemost_links.mjs   (Chrome with --remote-debugging-port=9222 and the bot chat open)
import { readFileSync, writeFileSync, readdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { reportProgress } from './report_progress.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PACKS = join(ROOT, 'packs');
const DEVTOOLS = process.env.DEVTOOLS || 'http://127.0.0.1:9222';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const list = await (await fetch(DEVTOOLS + '/json/list')).json();
const page = list.find(t => t.type === 'page' && t.url.includes('telemost.yandex.ru'));
if (!page) throw new Error('no Telemost tab');
const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0;
const pending = new Map();
ws.addEventListener('message', (ev) => {
  const d = JSON.parse(ev.data);
  if (d.id && pending.has(d.id)) { const p = pending.get(d.id); pending.delete(d.id); d.error ? p.reject(new Error(JSON.stringify(d.error))) : p.resolve(d.result); }
});
await new Promise(r => ws.addEventListener('open', r, { once: true }));
const ev = (expression) => new Promise((resolve, reject) => {
  const msgId = ++id;
  pending.set(msgId, { resolve: (r) => resolve(r.result.value), reject });
  ws.send(JSON.stringify({ id: msgId, method: 'Runtime.evaluate', params: { expression, returnByValue: true } }));
});

const grab = () => ev(`[...document.querySelectorAll('article.message')].map(a => {
  const m = (a.innerText || '').match(/Набор «([^»]+)» сохранён/);
  const link = [...a.querySelectorAll('a[href]')].map(x => x.href).find(h => /stickers\\//.test(h));
  return m && link ? [m[1], link] : null;
}).filter(Boolean)`);

const found = new Map();
const scroller = `(document.querySelector('.ui-InfiniteList-ScrollContainer') || {})`;
for (let i = 0; i < 60; i++) {
  for (const [title, link] of await grab()) found.set(title, link);
  const top = await ev(`(() => { const s = ${scroller}; if (!('scrollTop' in s)) return true; s.scrollTop = Math.max(0, s.scrollTop - 3000); return s.scrollTop === 0; })()`);
  await sleep(700);
  if (top) { for (const [t, l] of await grab()) found.set(t, l); break; }
}
await ev(`(() => { const s = ${scroller}; if ('scrollTop' in s) s.scrollTop = s.scrollHeight; })()`);
ws.close();

for (const dir of readdirSync(PACKS).filter(d => /^\d\d-/.test(d)).sort()) {
  const path = join(PACKS, dir, 'pack.json');
  const meta = JSON.parse(readFileSync(path, 'utf8'));
  const tm = meta.telemost || {};
  const link = found.get(meta.title);
  if (tm.status === 'done' && link && tm.packUrl !== link) {
    tm.packUrl = link;
    meta.telemost = tm;
    writeFileSync(path, JSON.stringify(meta, null, 2) + '\n');
    console.log(dir, link);
    await reportProgress(meta);
  }
}
console.log('links seen:', Object.fromEntries(found));
