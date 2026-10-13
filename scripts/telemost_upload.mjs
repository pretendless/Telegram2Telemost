// Uploads packs/<slug>/ images to the Telemost "Стикеры" bot through Chrome DevTools (port 9222).
// A finished pack (status done) is skipped. A draft left waiting for an emoji is not
// continued and is not closed with /done: that would publish the short pack. /start
// leaves that draft, then the same title is created again from the first image.
// Usage: node scripts/telemost_upload.mjs [NN ...]
import { readFileSync, writeFileSync, readdirSync, appendFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PACKS = join(ROOT, 'packs');
const LOG = join(ROOT, 'logs', 'transfer-log.md');
const BOT_URL = process.env.TELEMOST_BOT_URL || 'https://telemost.yandex.ru/user/fe21ed07-748c-969d-7459-b4e06d03e84d';
const DEVTOOLS = process.env.DEVTOOLS || 'http://127.0.0.1:9222';
const REPLY_TIMEOUT_S = Number(process.env.REPLY_TIMEOUT_S || 600);

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const stamp = () => new Date().toISOString().slice(0, 16).replace('T', ' ');
const log = (pack, item, status, err = '') => {
  const line = `| ${stamp()} | ${pack}${item ? ' / ' + item : ''} | ${status} | ${String(err).replace(/\|/g, '/').replace(/\n/g, ' ')} |`;
  console.log(line);
  try {
    appendFileSync(LOG, line + '\n');
  } catch (e) {
    console.log('log file skipped', e && e.code ? e.code : '');
  }
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
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const msgId = ++id;
    pending.set(msgId, { resolve, reject });
    ws.send(JSON.stringify({ id: msgId, method, params }));
  });
  const ev = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
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

  markSeen() {
    return this.c.ev(`document.querySelectorAll('article.message').forEach(a => a.dataset.tg2tmSeen = '1')`);
  }

  // Wait for a new incoming (bot) message that appeared after markSeen().
  async waitReply() {
    const t0 = Date.now();
    while ((Date.now() - t0) / 1000 < REPLY_TIMEOUT_S) {
      await sleep(1000);
      const txt = await this.c.ev(`(() => {
        const fresh = [...document.querySelectorAll('article.message')].filter(a => !a.dataset.tg2tmSeen && a.querySelector('.yamb-message-row') && !a.querySelector('.yamb-message-row_own'));
        return fresh.length ? fresh.map(a => (a.innerText || '').trim()).join('\\n') : null;
      })()`);
      if (txt) {
        const links = await this.c.ev(`[...document.querySelectorAll('article.message')].filter(a => !a.dataset.tg2tmSeen).flatMap(a => [...a.querySelectorAll('a[href]')].map(x => x.href))`);
        return { text: txt, links, seconds: (Date.now() - t0) / 1000 };
      }
    }
    throw new Error(`no bot reply in ${REPLY_TIMEOUT_S}s`);
  }

  async recentIncoming(limit = 4) {
    await this.ensureChat();
    await this.c.ev(`(() => { const s = document.querySelector('.ui-InfiniteList-ScrollContainer'); if (s && 'scrollTop' in s) s.scrollTop = s.scrollHeight; })()`);
    await sleep(700);
    const text = await this.c.ev(`(() => {
      const rows = [...document.querySelectorAll('article.message')].filter(a => a.querySelector('.yamb-message-row') && !a.querySelector('.yamb-message-row_own'));
      return rows.slice(-${Number(limit) || 4}).map(a => (a.innerText || '').trim()).filter(Boolean).join('\\n');
    })()`);
    const links = await this.c.ev(`(() => {
      const rows = [...document.querySelectorAll('article.message')].filter(a => a.querySelector('.yamb-message-row') && !a.querySelector('.yamb-message-row_own'));
      const last = rows[rows.length - 1];
      return last ? [...last.querySelectorAll('a[href]')].map(a => a.href) : [];
    })()`);
    return { text: text || '', links: links || [] };
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

  async sendImage(path) {
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
    return this.waitReply();
  }
}

const READY = /Стикер готов/;
const ASK_EMOJI = /Отправьте эмодзи/;
const NOT_EMOJI = /Это не эмодзи/;
const ASK_TITLE = /Напишите название/;
const CREATED = /Создан набор/;
const PUBLISHED = /сохранён|\/stickers\//;
const COMMAND_MENU = /\/newpack/;
const ASK_PICTURE = /картинк|изображен|фото|Отправьте стикер|Пришлите стикер|отправьте файл/i;

// A dialog already waiting for an emoji or rejecting text must not receive /start or /done.
export function packDialogOpen(text) {
  const body = String(text || '');
  return ASK_EMOJI.test(body) || NOT_EMOJI.test(body);
}

// /newpack asks for a title first. A picture is sent only after the bot asks for one.
export function afterNewpack(text) {
  const body = String(text || '');
  if (packDialogOpen(body)) return 'open';
  if (ASK_TITLE.test(body)) return 'title';
  if (wantsPicture(body)) return 'picture';
  return 'other';
}

export function wantsPicture(text) {
  const body = String(text || '');
  if (packDialogOpen(body)) return false;
  return ASK_PICTURE.test(body) || (CREATED.test(body) && /отправ/i.test(body));
}

// The saved 14-sticker draft is not the pack the bot is in now. Open a new one.
const SAVED = /сохранён/i;

// After a sticker is accepted the bot says «Стикер готов» and still holds the
// unpublished pack. That is the offer to finish it with /done. The idle command
// menu also names /done, and a brand-new pack only asks for a picture: neither
// of those is this pack waiting to be saved.
export function finalizeDecision(text) {
  const body = String(text || '');
  if (SAVED.test(body)) return { action: 'stop', reason: 'draft-gone' };
  if (ASK_EMOJI.test(body) || NOT_EMOJI.test(body)) return { action: 'stop', reason: 'waiting-emoji' };
  if (READY.test(body)) return { action: 'done' };
  return { action: 'stop', reason: 'draft-gone' };
}

export function extractPackUrl(text, links) {
  const fromLinks = (links || []).find((href) => /\/stickers\//.test(href) && !/addstickers/i.test(href));
  if (fromLinks) return fromLinks;
  const match = String(text || '').match(/https?:\/\/\S+/);
  if (!match) return '';
  const url = match[0].replace(/[),.;]+$/, '');
  if (!/\/stickers\//.test(url) || /addstickers/i.test(url)) return '';
  return url;
}

export async function postPackLink(fetchImpl, token, title, url) {
  const response = await fetchImpl('https://api.telegram.org/bot' + token + '/sendMessage', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      chat_id: '@tg2tm',
      text: `«${title}»\n\n${url}`,
      link_preview_options: { is_disabled: true },
    }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.ok) {
    const description = data && data.description ? data.description : String(response.status);
    throw new Error(`channel post failed: ${description}`);
  }
}

export function mustOpenNewPack(tm) {
  if (!tm || tm.status === 'done') return false;
  if (tm.status === 'stopped' || tm.pendingFile) return true;
  return !tm.created;
}

// The partial «Сэт, Рэдж и Летти» pack is this case: 14 accepted, 015.png sent, emoji never sent.
export function draftNeedsAbandon(tm) {
  if (!tm || tm.status === 'done') return false;
  const waiting = ASK_EMOJI.test(tm.botReply || '');
  return Boolean(tm.pendingFile) || (tm.status === 'stopped' && waiting);
}

export function resetForNewPack(tm) {
  return {
    ...tm,
    status: 'pending',
    uploaded: 0,
    nextImage: 0,
    created: false,
    pendingFile: null,
    botReply: null,
    error: null,
    packUrl: null,
    stoppedAt: null,
  };
}

// /start shows the command list. It is not an emoji and it is not /done.
export function abandonReplyOk(text) {
  const body = String(text || '');
  if (ASK_EMOJI.test(body) || READY.test(body) || PUBLISHED.test(body)) return false;
  return COMMAND_MENU.test(body);
}

export async function leaveUnpublishedDraft(say) {
  const reply = await say('/start');
  const text = reply && reply.text ? reply.text : '';
  if (!abandonReplyOk(text)) {
    throw new Error('still inside the unpublished pack; not sending an emoji and not sending /done');
  }
  return reply;
}

function loadPack(dir) {
  const path = join(PACKS, dir, 'pack.json');
  return { path, meta: JSON.parse(readFileSync(path, 'utf8')) };
}
// Only the telemost block is ours; re-read so concurrent edits to other fields survive.
function savePack(p) {
  const onDisk = JSON.parse(readFileSync(p.path, 'utf8'));
  onDisk.telemost = p.meta.telemost;
  writeFileSync(p.path, JSON.stringify(onDisk, null, 2) + '\n');
}

async function withRetry(label, fn, tries = 4) {
  let err;
  for (let i = 0; i < tries; i++) {
    try { return await fn(); } catch (e) { err = e; console.log(label, 'retry', i + 1, e.message); await sleep(5000 * (i + 1)); }
  }
  throw err;
}

async function uploadPack(bot, dir) {
  const p = loadPack(dir);
  const m = p.meta;
  const tm = m.telemost = { status: 'pending', uploaded: 0, packUrl: null, error: null, ...m.telemost };
  if (tm.status === 'done') { console.log(dir, 'already done'); return; }
  if (!m.images?.length) throw new Error(`${dir}: no images yet`);

  if (mustOpenNewPack(tm)) {
    const opened = await withRetry('newpack', () => bot.say('/newpack'));
    const openedText = String(opened.text || '').replace(/\s+/g, ' ').trim();
    console.log(dir, 'newpack-reply', openedText.slice(0, 400));
    const step = afterNewpack(opened.text);
    if (step === 'open') {
      throw new Error(`pack dialog already open; not sending /start or /done: ${openedText.slice(0, 200)}`);
    }
    let picture = opened;
    if (step === 'title') {
      const titled = await withRetry('title', () => bot.say(m.title));
      const titledText = String(titled.text || '').replace(/\s+/g, ' ').trim();
      console.log(dir, 'title-reply', titledText.slice(0, 400));
      if (packDialogOpen(titled.text)) {
        throw new Error(`pack dialog already open; not sending /start or /done: ${titledText.slice(0, 200)}`);
      }
      picture = titled;
    }
    if (!wantsPicture(picture.text)) {
      const shown = String(picture.text || '').replace(/\s+/g, ' ').trim();
      throw new Error(`bot has not asked for a picture yet: ${shown.slice(0, 200)}`);
    }
    tm.created = true;
    tm.uploaded = 0;
    tm.nextImage = 0;
    tm.pendingFile = null;
    tm.status = 'uploading';
    tm.botReply = String(picture.text || '').slice(0, 300);
    savePack(p);
    log(m.title, '', 'набор создан', 'без /start и без /done');
  }

  for (let i = tm.uploaded; i < m.images.length; i++) {
    const img = m.images[i];
    const file = join(PACKS, dir, img.file);
    console.log(dir, 'send', img.file);
    let ok = false;
    for (let attempt = 1; attempt <= 3 && !ok; attempt++) {
      try {
        const r = await bot.sendImage(file);
        if (READY.test(r.text)) { ok = true; break; }
        if (!ASK_EMOJI.test(r.text)) throw new Error(`image rejected: ${r.text.slice(0, 200)}`);
        let e = await bot.say(img.emoji || '🙂');
        if (!READY.test(e.text) && ASK_EMOJI.test(e.text)) e = await bot.say('🙂');
        if (!READY.test(e.text)) throw new Error(`emoji: ${e.text.slice(0, 200)}`);
        ok = true;
        if (r.seconds + e.seconds > 60) log(m.title, img.file, 'медленно', `${(r.seconds + e.seconds).toFixed(0)} с`);
      } catch (err) {
        log(m.title, img.file, `ошибка, попытка ${attempt}`, err.message);
        await sleep(10000 * attempt);
      }
    }
    if (!ok) {
      tm.status = 'error';
      tm.error = `stopped at ${img.file}`;
      savePack(p);
      throw new Error(`${dir}: ${img.file} failed 3 times`);
    }
    tm.uploaded = i + 1;
    if (tm.uploaded % 10 === 0 || tm.uploaded === m.images.length) {
      savePack(p);
      console.log(dir, tm.uploaded, '/', m.images.length);
    }
  }

  tm.status = 'uploading';
  tm.error = null;
  savePack(p);
  log(m.title, '', `отправлены ${m.images.length} стикеров`, 'без /done');
}

async function finalizePack(bot, dir) {
  const p = loadPack(dir);
  const m = p.meta;
  const tm = m.telemost = { status: 'pending', uploaded: 0, packUrl: null, error: null, ...m.telemost };
  if (tm.status === 'done' && tm.packUrl) {
    console.log(dir, 'draft-gone', tm.packUrl);
    return;
  }
  const seen = await bot.recentIncoming(1);
  const shown = String(seen.text || '').replace(/\s+/g, ' ').trim();
  console.log(dir, 'last-reply', shown.slice(0, 400));
  const decision = finalizeDecision(seen.text);
  if (decision.action !== 'done') {
    console.log(dir, 'draft-gone', decision.reason);
    return;
  }
  const done = await bot.say('/done');
  const doneText = String(done.text || '').replace(/\s+/g, ' ').trim();
  console.log(dir, 'done-reply', doneText.slice(0, 400));
  const url = extractPackUrl(done.text, done.links);
  if (!SAVED.test(done.text) || !url) {
    console.log(dir, 'draft-gone', 'done did not save the pack');
    return;
  }
  tm.status = 'done';
  tm.packUrl = url;
  tm.error = null;
  tm.uploaded = m.images.length;
  tm.pendingFile = null;
  tm.botReply = doneText.slice(0, 300);
  savePack(p);
  console.log(dir, 'pack-url', url);
  await postPackLink(fetch, process.env.TG2TMBOT_TOKEN || '', m.title, url);
  console.log(dir, 'channel-posted', '@tg2tm');
}

async function main() {
  const finalize = process.argv.includes('--finalize');
  const wanted = process.argv.slice(2).filter((arg) => arg !== '--finalize');
  let dirs = readdirSync(PACKS).filter(d => /^\d\d-/.test(d)).sort().filter(d => !wanted.length || wanted.includes(d.slice(0, 2)) || wanted.includes(d));
  if (finalize) {
    if (dirs.some((dir) => !dir.startsWith('07'))) console.log('skip pack 08');
    dirs = dirs.filter((dir) => dir.startsWith('07'));
  }
  const c = await connect();
  const bot = new Bot(c);
  for (const d of dirs) {
    try {
      if (finalize) await finalizePack(bot, d);
      else await uploadPack(bot, d);
    } catch (e) {
      log(d, '', 'остановлено', e.message);
      process.exitCode = 1;
      break;
    }
  }
  c.close();
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
