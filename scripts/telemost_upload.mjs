// Uploads packs/<slug>/ images to the Telemost "Стикеры" bot through Chrome DevTools (port 9222).
// Resumes from pack.json telemost.uploaded. Usage: node scripts/telemost_upload.mjs [NN ...]
import { readFileSync, writeFileSync, readdirSync, appendFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { reportProgress } from './report_progress.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PACKS = join(ROOT, 'packs');
const LOG = join(ROOT, 'logs', 'transfer-log.md');
const BOT_URL = process.env.TELEMOST_BOT_URL || 'https://telemost.yandex.ru/user/fe21ed07-748c-969d-7459-b4e06d03e84d';
const DEVTOOLS = process.env.DEVTOOLS || 'http://127.0.0.1:9222';
const REPLY_TIMEOUT_S = Number(process.env.REPLY_TIMEOUT_S || 240);
const EVAL_TIMEOUT_MS = 20000;
const SPINNER_STALL_S = 90;

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const stamp = () => new Date().toISOString().slice(0, 16).replace('T', ' ');
const log = (pack, item, status, err = '') => {
  appendFileSync(LOG, `| ${stamp()} | ${pack}${item ? ' / ' + item : ''} | ${status} | ${err.replace(/\|/g, '/').replace(/\n/g, ' ')} |\n`);
  console.log(stamp(), pack, item, status, err);
};

async function connect() {
  const list = await (await fetch(DEVTOOLS + '/json/list')).json();
  const page = list.find(t => t.type === 'page' && t.url.includes('telemost.yandex.ru'));
  if (!page) throw new Error('no Telemost tab open in Chrome');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let id = 0;
  const pending = new Map();
  ws.addEventListener('message', (ev) => {
    const d = JSON.parse(ev.data);
    if (d.id && pending.has(d.id)) {
      const { resolve, reject } = pending.get(d.id);
      pending.delete(d.id);
      d.error ? reject(new Error(JSON.stringify(d.error))) : resolve(d.result);
    }
  });
  await new Promise(r => ws.addEventListener('open', r, { once: true }));
  const send = (method, params = {}, timeoutMs = 0) => new Promise((resolve, reject) => {
    const msgId = ++id;
    let timer;
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      pending.delete(msgId);
      fn(value);
    };
    if (timeoutMs > 0) {
      timer = setTimeout(() => finish(reject, new Error('devtools evaluate hung past 20s')), timeoutMs);
    }
    pending.set(msgId, {
      resolve: (value) => finish(resolve, value),
      reject: (err) => finish(reject, err),
    });
    ws.send(JSON.stringify({ id: msgId, method, params }));
  });
  const ev = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, EVAL_TIMEOUT_MS);
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'eval failed');
    return r.result.value;
  };
  await send('DOM.enable');
  return { send, ev, close: () => ws.close() };
}

// ui-pressable widgets ignore CDP mouse input; synthetic pointer events dispatched in the page work.
const pressJs = (sel) => `(() => {
  const e = ${sel};
  if (!e) return false;
  const b = e.getBoundingClientRect();
  if (!b.width) return false;
  const o = {bubbles: true, cancelable: true, composed: true, clientX: b.x + b.width / 2, clientY: b.y + b.height / 2, button: 0, pointerId: 1, pointerType: 'mouse', isPrimary: true};
  e.dispatchEvent(new PointerEvent('pointerdown', {...o, buttons: 1}));
  e.dispatchEvent(new MouseEvent('mousedown', {...o, buttons: 1}));
  e.dispatchEvent(new PointerEvent('pointerup', {...o, buttons: 0}));
  e.dispatchEvent(new MouseEvent('mouseup', {...o, buttons: 0}));
  e.dispatchEvent(new MouseEvent('click', {...o, buttons: 0}));
  return true;
})()`;

class Bot {
  constructor(c) { this.c = c; }

  async ensureChat() {
    const href = await this.c.ev('location.href');
    if (!href.startsWith(BOT_URL)) await this.c.send('Page.navigate', { url: BOT_URL });
    for (let i = 0; i < 60; i++) {
      if (await this.c.ev(`!!document.querySelector('[contenteditable=true]')`)) return;
      await sleep(500);
    }
    throw new Error('Telemost bot chat did not load');
  }

  // A tab whose file uploads stall (red "!" on the image) recovers only after a reload.
  async reload() {
    await this.c.send('Page.reload', { ignoreCache: true });
    await sleep(2000);
    await this.ensureChat();
    // data-* markers disappear on reload. Mark everything already rendered as
    // old before retrying, otherwise an old "Стикер готов" is a false reply.
    await this.markSeen();
  }

  markSeen() {
    return this.c.ev(`document.querySelectorAll('article.message').forEach(a => a.dataset.tg2tmSeen = '1')`);
  }

  // Count of accepted stickers already in the chat. Compared before a resend
  // so a late «Стикер готов» is never followed by a second copy.
  readyCount() {
    return this.c.ev(`([...document.querySelectorAll('article.message')].filter(a => !a.querySelector('.yamb-message-row_own') && /Стикер готов/.test(a.innerText || '')).length)`);
  }

  // Wait for a new incoming (bot) message that appeared after markSeen().
  // stall.used means this image already reloaded once: a second spinner or a
  // hung evaluate must not reload again.
  async waitReply(stall = { used: false }) {
    const t0 = Date.now();
    let transferRetries = 0;
    let spinnerSince = null;
    let evalHangs = 0;
    const limitS = () => stall.used ? Math.max(REPLY_TIMEOUT_S, 15 * 60) : REPLY_TIMEOUT_S;
    while ((Date.now() - t0) / 1000 < limitS()) {
      await sleep(1000);
      let snap;
      try {
        snap = await this.c.ev(`(() => {
          const freshArticles = [...document.querySelectorAll('article.message')].filter(a => !a.dataset.tg2tmSeen);
          const spinning = freshArticles.some(a => a.querySelector('.yamb-transfer-status_status_progress'));
          const failed = freshArticles.filter(a => a.querySelector('.yamb-message-row_own .yamb-transfer-status_status_failed')).at(-1);
          const retry = failed && failed.querySelector('[aria-label="Повторить попытку"]');
          if (retry) {
            const b = retry.getBoundingClientRect();
            const o = {bubbles: true, cancelable: true, composed: true, clientX: b.x + b.width / 2, clientY: b.y + b.height / 2, button: 0, pointerId: 1, pointerType: 'mouse', isPrimary: true};
            retry.dispatchEvent(new PointerEvent('pointerdown', {...o, buttons: 1}));
            retry.dispatchEvent(new MouseEvent('mousedown', {...o, buttons: 1}));
            retry.dispatchEvent(new PointerEvent('pointerup', {...o, buttons: 0}));
            retry.dispatchEvent(new MouseEvent('mouseup', {...o, buttons: 0}));
            retry.dispatchEvent(new MouseEvent('click', {...o, buttons: 0}));
          }
          const fresh = freshArticles.filter(a => a.querySelector('.yamb-message-row') && !a.querySelector('.yamb-message-row_own'));
          const text = fresh.length ? fresh.map(a => (a.innerText || '').trim()).join('\\n') : null;
          const links = freshArticles.flatMap(a => [...a.querySelectorAll('a[href]')].map(x => x.href));
          return { spinning, clicked: !!retry, text, links };
        })()`);
        evalHangs = 0;
      } catch (err) {
        if (!/devtools evaluate hung past 20s/.test(err.message)) throw err;
        if (!stall.used) throw new Error('stall: evaluate');
        evalHangs++;
        if (evalHangs >= 3) throw new Error('devtools evaluate hung past 20s');
        continue;
      }
      if (snap.spinning) {
        if (!spinnerSince) spinnerSince = Date.now();
      } else {
        spinnerSince = null;
      }
      if (snap.clicked) {
        transferRetries++;
        if (transferRetries >= 5) throw new Error('file transfer error mark after 5 retries');
        await sleep(2000);
        continue;
      }
      if (snap.text) {
        return { text: snap.text, links: snap.links, seconds: (Date.now() - t0) / 1000 };
      }
      if (spinnerSince && (Date.now() - spinnerSince) / 1000 >= SPINNER_STALL_S) {
        if (!stall.used) throw new Error('stall: spinner');
        // Second spin: leave the tab alone and keep waiting for a real reply.
        if ((Date.now() - t0) / 1000 > 15 * 60) throw new Error('still spinning after reload');
      }
    }
    throw new Error(`no bot reply in ${REPLY_TIMEOUT_S}s`);
  }

  async clickSend(inDialog) {
    const sel = inDialog
      ? `[...document.querySelectorAll('[aria-label="Отправить сообщение"]')].filter(e => e.getBoundingClientRect().width > 0).sort((a, b) => a.getBoundingClientRect().y - b.getBoundingClientRect().y)[0]`
      : `[...document.querySelectorAll('[aria-label="Отправить сообщение"]')].filter(e => e.getBoundingClientRect().width > 0).pop()`;
    for (let i = 0; i < 40; i++) {
      if (await this.c.ev(pressJs(sel))) return;
      await sleep(250);
    }
    throw new Error('send button not found');
  }

  async say(text) {
    await this.ensureChat();
    await this.markSeen();
    await this.c.ev(`(() => { const e = document.querySelector('[contenteditable=true]'); e.focus(); })()`);
    await this.c.send('Input.insertText', { text });
    await sleep(250);
    await this.clickSend(false);
    return this.waitReply();
  }

  async sendImage(path, stall = { used: false }) {
    await this.ensureChat();
    await this.markSeen();
    const doc = await this.c.send('DOM.getDocument', { depth: -1, pierce: true });
    const q = await this.c.send('DOM.querySelectorAll', { nodeId: doc.root.nodeId, selector: 'input[type=file]' });
    if (!q.nodeIds.length) throw new Error('file input not found');
    await this.c.send('DOM.setFileInputFiles', { nodeId: q.nodeIds[0], files: [path] });
    for (let i = 0; i < 40; i++) {
      await sleep(250);
      const open = await this.c.ev(`[...document.querySelectorAll('[aria-label="Отправить сообщение"]')].filter(e => e.getBoundingClientRect().width > 0).length > 1`);
      if (open) break;
    }
    await sleep(400);
    await this.clickSend(true);
    return this.waitReply(stall);
  }
}

const READY = /Стикер готов/;
const ASK_EMOJI = /Отправьте эмодзи/;
const NOT_EMOJI = /Это не эмодзи/;
const IMAGE_REJECT = /Не удалось обработать картинку\. Попробуйте отправить другую/;
const ASK_TITLE = /Напишите название/;
const CREATED = /Создан набор/;

function loadPack(dir) {
  const path = join(PACKS, dir, 'pack.json');
  return { path, meta: JSON.parse(readFileSync(path, 'utf8')) };
}
// Only the telemost block is ours; re-read so concurrent edits to other fields survive.
// After the write, tell @tg2tmbot. A missing progress URL does not stop the upload.
async function savePack(p) {
  const onDisk = JSON.parse(readFileSync(p.path, 'utf8'));
  onDisk.telemost = p.meta.telemost;
  writeFileSync(p.path, JSON.stringify(onDisk, null, 2) + '\n');
  await reportProgress(onDisk);
}

async function withRetry(label, fn, tries = 4) {
  let err;
  for (let i = 0; i < tries; i++) {
    try { return await fn(); } catch (e) { err = e; console.log(label, 'retry', i + 1, e.message); await sleep(5000 * (i + 1)); }
  }
  throw err;
}

async function sendImageOnce(bot, img, file, ctx) {
  if (ctx.sent) {
    const now = await bot.readyCount();
    if (now > ctx.readyBefore) return { accepted: true, already: true };
  } else {
    ctx.readyBefore = await bot.readyCount();
  }
  ctx.sent = true;
  const r = await bot.sendImage(file, { used: ctx.stallUsed });
  if (IMAGE_REJECT.test(r.text)) return { accepted: false, rejected: true, reply: 'Не удалось обработать картинку. Попробуйте отправить другую.' };
  if (READY.test(r.text)) return { accepted: true };
  // Still waiting for the emoji of this same image from an earlier attempt:
  // finish it, do not resend the image.
  if (NOT_EMOJI.test(r.text)) {
    const e = await bot.say('🙂');
    if (!READY.test(e.text)) throw new Error(`emoji fallback: ${e.text.slice(0, 200)}`);
    return { accepted: true };
  }
  if (!ASK_EMOJI.test(r.text)) throw new Error(`unexpected image reply: ${r.text.slice(0, 200)}`);
  let e = await bot.say(img.emoji || '🙂');
  if (!READY.test(e.text) && (ASK_EMOJI.test(e.text) || NOT_EMOJI.test(e.text))) e = await bot.say('🙂');
  if (!READY.test(e.text)) throw new Error(`emoji: ${e.text.slice(0, 200)}`);
  if (r.seconds + e.seconds > 60) return { accepted: true, slow: r.seconds + e.seconds };
  return { accepted: true };
}

// An explicit image refusal is not a stall: resend the same file, without a
// reload, up to five times. Timeouts and other failures retain the existing
// three-attempt recovery path.
async function sendImageWithPolicy(bot, m, img, file, number, phase) {
  let refusalCount = 0;
  let transientAttempt = 0;
  const ctx = { sent: false, readyBefore: 0, stallUsed: false };
  while (refusalCount < 5) {
    try {
      const result = await sendImageOnce(bot, img, file, ctx);
      if (result.accepted) {
        if (result.already) log(m.title, img.file, 'уже принят', 'Стикер готов');
        else if (result.slow) log(m.title, img.file, 'медленно', `${result.slow.toFixed(0)} с`);
        return { accepted: true, refusals: refusalCount };
      }
      refusalCount++;
      log(m.title, img.file, `картинка отклонена ${refusalCount}/5`, result.reply);
      // Do not reload: the bot gave an actual, meaningful reply.
      if (refusalCount < 5) await sleep(1500);
    } catch (err) {
      if (/stall: (spinner|evaluate)|devtools evaluate hung past 20s/.test(err.message) && !ctx.stallUsed) {
        ctx.stallUsed = true;
        log(m.title, img.file, 'зависание, перезагрузка вкладки', err.message);
        await bot.reload();
        continue;
      }
      // The one reload for this image was already used. A second spin or a
      // second hung evaluate must not reload again, and must not send a copy.
      if (ctx.stallUsed && /stall:|still spinning|devtools evaluate hung/.test(err.message)) throw err;
      transientAttempt++;
      log(m.title, img.file, `ошибка, попытка ${transientAttempt}/3`, err.message);
      if (transientAttempt >= 3) throw err;
      await sleep(10000 * transientAttempt);
      if (/file transfer error mark/.test(err.message) && !ctx.stallUsed) {
        ctx.stallUsed = true;
        await bot.reload();
      }
    }
  }
  return {
    accepted: false,
    refusals: refusalCount,
    reply: 'Не удалось обработать картинку. Попробуйте отправить другую.',
    phase,
    number,
  };
}

async function recordSkipped(p, m, img, number, result, phase) {
  const tm = m.telemost;
  tm.skippedStickers ||= [];
  let item = tm.skippedStickers.find((x) => x.file === img.file);
  if (!item) {
    item = { file: img.file, stickerNumber: number, reply: result.reply, firstPassFailures: 0, retryFailures: 0, retried: false, resolved: false };
    tm.skippedStickers.push(item);
  }
  if (phase === 'first') item.firstPassFailures = result.refusals;
  else {
    item.retryFailures = result.refusals;
    item.retried = true;
  }
  const detail = `${result.reply} (${phase === 'first' ? 'первый проход' : 'повтор перед /done'}, 5/5)`;
  log(m.title, `${number}/${m.images.length} ${img.file}`, 'стикер отложен', detail);
  // An error snapshot makes @tg2tmbot notify subscribers, then the uploading
  // snapshot makes clear that the pack continues.
  tm.status = 'error';
  tm.error = `стикер ${number} (${img.file}): ${detail}`;
  await savePack(p);
  tm.status = 'uploading';
  tm.error = null;
  await savePack(p);
}

async function uploadPack(bot, dir) {
  const p = loadPack(dir);
  const m = p.meta;
  const tm = m.telemost = { status: 'pending', uploaded: 0, packUrl: null, error: null, ...m.telemost };
  if (tm.status === 'done') { console.log(dir, 'already done'); await reportProgress(m); return; }
  if (!m.images?.length) throw new Error(`${dir}: no images yet`);

  if (!tm.created) {
    const r1 = await withRetry('newpack', () => bot.say('/newpack'));
    if (!ASK_TITLE.test(r1.text)) throw new Error(`/newpack: unexpected reply: ${r1.text.slice(0, 200)}`);
    const r2 = await withRetry('title', () => bot.say(m.title));
    if (!CREATED.test(r2.text)) throw new Error(`title: unexpected reply: ${r2.text.slice(0, 200)}`);
    tm.created = true;
    tm.status = 'uploading';
    await savePack(p);
    log(m.title, '', 'набор создан');
  }

  tm.nextImage ??= tm.uploaded;
  tm.skippedStickers ||= [];
  for (let i = tm.nextImage; i < m.images.length; i++) {
    const img = m.images[i];
    const file = join(PACKS, dir, img.file);
    const result = await sendImageWithPolicy(bot, m, img, file, i + 1, 'first');
    tm.nextImage = i + 1;
    if (result.accepted) {
      tm.uploaded++;
    } else {
      await recordSkipped(p, m, img, i + 1, result, 'first');
    }
    if (tm.nextImage % 10 === 0 || tm.nextImage === m.images.length || !result.accepted) {
      await savePack(p);
      console.log(dir, `${tm.uploaded} accepted, ${tm.nextImage}/${m.images.length} processed`);
    }
  }

  // Retry all explicitly refused files once more, five attempts each, before
  // /done. They are appended, which preserves every non-refused sticker's
  // relative order and keeps the result as close to source order as possible.
  for (const skipped of tm.skippedStickers.filter((x) => !x.resolved && !x.retried)) {
    const img = m.images.find((x) => x.file === skipped.file);
    if (!img) continue;
    const result = await sendImageWithPolicy(bot, m, img, join(PACKS, dir, img.file), skipped.stickerNumber, 'retry');
    skipped.retried = true;
    if (result.accepted) {
      skipped.resolved = true;
      tm.uploaded++;
      log(m.title, `${skipped.stickerNumber}/${m.images.length} ${img.file}`, 'отложенный стикер добавлен', '');
      await savePack(p);
    } else {
      await recordSkipped(p, m, img, skipped.stickerNumber, result, 'retry');
    }
  }

  const done = await withRetry('done', () => bot.say('/done'));
  const url = (done.links || []).find(h => /\/stickers\//.test(h)) || done.text.match(/https?:\/\/\S+/)?.[0] || null;
  tm.status = 'done';
  tm.packUrl = url;
  tm.error = null;
  tm.botReply = done.text.replace(/^Стикеры\s*/, '').slice(0, 300);
  await savePack(p);
  const unresolved = tm.skippedStickers.filter((x) => !x.resolved).length;
  log(m.title, '', `готово, ${tm.uploaded} стикеров${unresolved ? `; пропущено ${unresolved}` : ''}`, url || '');
}

const wanted = process.argv.slice(2);
const dirs = readdirSync(PACKS)
  .filter(d => /^\d\d-/.test(d) || d.startsWith("q-"))
  .sort()
  .filter(d => !wanted.length || wanted.includes(d.slice(0, 2)) || wanted.includes(d));
const c = await connect();
const bot = new Bot(c);
for (const d of dirs) {
  try {
    await uploadPack(bot, d);
  } catch (e) {
    log(d, '', 'остановлено', e.message);
    process.exitCode = 1;
    break;
  }
}
c.close();
