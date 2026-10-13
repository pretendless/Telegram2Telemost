// Uploads packs/<slug>/ images to the Telemost "Стикеры" bot through Chrome DevTools (port 9222).
// A finished pack (status done) is skipped. A draft left waiting for an emoji is not
// continued and is not closed with /done: that would publish the short pack. /start
// leaves that draft, then the same title is created again from the first image.
// Usage: node scripts/telemost_upload.mjs [NN ...]
import { readFileSync, writeFileSync, readdirSync, appendFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { createAdminFeed, postProgress, telegramIo } from './admin_status.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PACKS = join(ROOT, 'packs');
const LOG = join(ROOT, 'logs', 'transfer-log.md');
const BOT_URL = process.env.TELEMOST_BOT_URL || 'https://telemost.yandex.ru/user/fe21ed07-748c-969d-7459-b4e06d03e84d';
const DEVTOOLS = process.env.DEVTOOLS || 'http://127.0.0.1:9222';
const POLL_MS = 100;

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

  botRows() {
    return this.c.ev(`(() => {
      const s = document.querySelector('.ui-InfiniteList-ScrollContainer');
      if (s && 'scrollTop' in s) s.scrollTop = s.scrollHeight;
      window.__tg2tmNext = window.__tg2tmNext || 1;
      const rows = [...document.querySelectorAll('article.message')].filter((a) => a.querySelector('.yamb-message-row') && !a.querySelector('.yamb-message-row_own'));
      return rows.map((a) => {
        if (!a.dataset.tg2tmId) a.dataset.tg2tmId = String(window.__tg2tmNext++);
        return { id: a.dataset.tg2tmId, text: (a.innerText || '').replace(/\\s+/g, ' ').trim() };
      });
    })()`);
  }

  scrollToBottom() {
    return this.c.ev(`(() => { const s = document.querySelector('.ui-InfiniteList-ScrollContainer'); if (s && 'scrollTop' in s) s.scrollTop = s.scrollHeight; })()`);
  }

  // A seen flag hides a bubble the bot rewrites in place. Compare text instead.
  // «Отправьте эмодзи» and the following «Стикер готов» are replies, not timeouts.
  async waitForReply(baseline, { onWait, until } = {}) {
    const started = Date.now();
    let lastSentAt = 0;
    let stable = '';
    let stableAt = 0;
    for (;;) {
      const rows = await this.botRows();
      // A sticker wait treats an existing «Стикер готов» line as acceptance.
      // A command wait does not: /newpack and a title need a new bot line.
      let seen;
      if (until === 'sticker') seen = stickerReplyText(baseline, rows);
      else {
        const changed = changedBotText(baseline, rows);
        seen = { text: changed, kind: imageReply(changed) };
      }
      const text = seen.text;
      const kind = seen.kind;
      const stickerReply = kind === 'ready' || kind === 'emoji' || kind === 'reject';
      if (until === 'sticker' && stickerReply) {
        return { text, links: [], seconds: (Date.now() - started) / 1000, kind };
      }
      if (until !== 'sticker' && text.trim()) {
        const sameFor = text === stable ? Date.now() - stableAt : 0;
        if (kind !== 'pending' || sameFor >= 400) {
          return { text, links: [], seconds: (Date.now() - started) / 1000, kind: kind === 'pending' ? 'other' : kind };
        }
      }
      if (text !== stable) {
        stable = text;
        stableAt = Date.now();
      }
      const now = Date.now();
      if (onWait && waitStatusDue(now, started, lastSentAt)) {
        lastSentAt = now;
        await onWait(Math.round((now - started) / 1000), lastBotLine(rows));
      }
      await sleep(POLL_MS);
    }
  }

  async recentIncoming(limit = 4) {
    await this.ensureChat();
    await this.c.ev(`(() => { const s = document.querySelector('.ui-InfiniteList-ScrollContainer'); if (s && 'scrollTop' in s) s.scrollTop = s.scrollHeight; })()`);
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
      await sleep(POLL_MS);
    }
    throw new Error('send button not found');
  }

  async say(text, opts) {
    await this.ensureChat();
    await this.scrollToBottom();
    const baseline = await this.botRows();
    await this.c.ev(`(() => { const e = document.querySelector('[contenteditable=true]'); e.focus(); })()`);
    await this.c.send('Input.insertText', { text });
    await this.clickSend(false);
    return this.waitForReply(baseline, opts || {});
  }

  async fileInput() {
    const doc = await this.c.send('DOM.getDocument', { depth: 2 });
    const one = await this.c.send('DOM.querySelector', { nodeId: doc.root.nodeId, selector: 'input[type=file]' });
    if (one.nodeId) return one.nodeId;
    const deep = await this.c.send('DOM.getDocument', { depth: -1, pierce: true });
    const q = await this.c.send('DOM.querySelectorAll', { nodeId: deep.root.nodeId, selector: 'input[type=file]' });
    if (!q.nodeIds.length) throw new Error('file input not found');
    return q.nodeIds[0];
  }

  async sendImage(path, opts) {
    await this.ensureChat();
    await this.scrollToBottom();
    const baseline = await this.botRows();
    const nodeId = await this.fileInput();
    await this.c.send('DOM.setFileInputFiles', { nodeId, files: [path] });
    for (let i = 0; i < 80; i++) {
      const open = await this.c.ev(`[...document.querySelectorAll('[aria-label="Отправить сообщение"]')].filter(e => e.getBoundingClientRect().width > 0).length > 1`);
      if (open) break;
      await sleep(POLL_MS);
    }
    await this.clickSend(true);
    return this.waitForReply(baseline, { until: 'sticker', ...(opts || {}) });
  }

  // Scroll the sticker-bot history once and keep every message. A later run
  // must not send an image the bot already accepted.
  async surveyChat() {
    await this.ensureChat();
    const scrollBy = (direction) => this.c.ev(scrollPageScript(direction));
    let height = -1;
    let stable = 0;
    for (let i = 0; i < 200 && stable < 8; i++) {
      const info = await this.c.ev(`(() => {
        const s = document.querySelector('.ui-InfiniteList-ScrollContainer');
        if (!s || !('scrollTop' in s)) return { top: -1, height: 0 };
        s.scrollTop = 0;
        return { top: s.scrollTop, height: s.scrollHeight };
      })()`);
      if (!info || info.top < 0) break;
      if (info.top === 0 && info.height === height) stable++;
      else stable = 0;
      height = info.height;
      await sleep(POLL_MS);
    }
    const reachedTop = stable >= 8;
    await this.c.ev(`(() => {
      window.__tg2tmLog = [];
      window.__tg2tmNext = 1;
      document.querySelectorAll('article.message').forEach(a => delete a.dataset.tg2tmId);
    })()`);
    const stamp = `(() => {
      const log = window.__tg2tmLog || (window.__tg2tmLog = []);
      let n = window.__tg2tmNext || 1;
      const have = new Set(log.map(m => m.id));
      for (const a of document.querySelectorAll('article.message')) {
        if (!a.dataset.tg2tmId) a.dataset.tg2tmId = String(n++);
        const id = a.dataset.tg2tmId;
        if (have.has(id)) continue;
        have.add(id);
        log.push({
          id,
          own: !!a.querySelector('.yamb-message-row_own'),
          text: (a.innerText || '').replace(/\\s+/g, ' ').trim(),
          links: [...a.querySelectorAll('a[href]')].map(x => x.href),
        });
      }
      window.__tg2tmNext = n;
      return log.length;
    })()`;
    let idle = 0;
    let prevCount = -1;
    for (let i = 0; i < 800 && idle < 3; i++) {
      const count = await this.c.ev(stamp);
      const pos = await scrollBy(1);
      if (pos < 0) break;
      const atBottom = await this.c.ev(`(() => {
        const s = document.querySelector('.ui-InfiniteList-ScrollContainer');
        if (!s || !('scrollTop' in s)) return true;
        return s.scrollTop + s.clientHeight >= s.scrollHeight - 2;
      })()`);
      if (atBottom && count === prevCount) idle++;
      else idle = 0;
      prevCount = count;
      await sleep(POLL_MS);
    }
    await this.c.ev(stamp);
    const messages = await this.c.ev(`window.__tg2tmLog || []`);
    return { messages: messages || [], reachedTop };
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
const IMAGE_FAIL = /Не удалось обработать|не подходит|слишком больш|отклон/i;

const EMOJI_ONLY = /^(?:\p{Extended_Pictographic}|\p{Emoji_Presentation}|\uFE0F|\u200D|\s)+$/u;

// The live bubble is "Стикеры <text> HH:MM". The phrase has to match that whole
// line. A 32-character cap hid «Отправьте эмодзи для стикера.» and the sender waited.
function replyCore(text) {
  return String(text || '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^Стикеры\s+/, '')
    .replace(/\s+\d{1,2}:\d{2}$/, '')
    .trim();
}

// «Отправьте эмодзи» or a bare emoji such as 🫣 asks for the sticker emoji.
// «Стикер готов» means that sticker is accepted.
export function isEmojiRequest(text) {
  const body = String(text || '').replace(/\s+/g, ' ').trim();
  if (!body) return false;
  if (ASK_EMOJI.test(body) || NOT_EMOJI.test(body)) return true;
  const core = replyCore(body);
  if (!core || core.length > 32) return false;
  return EMOJI_ONLY.test(core);
}

export function imageReply(text) {
  const body = String(text || '');
  if (!body.trim()) return 'pending';
  if (READY.test(body)) return 'ready';
  if (isEmojiRequest(body)) return 'emoji';
  if (IMAGE_FAIL.test(body)) return 'reject';
  return 'pending';
}

// The emoji phrase gets the sticker's emoji. A bare emoji is sent back as itself.
export function emojiAnswer(replyText, stickerEmoji) {
  const core = replyCore(replyText);
  if (core && EMOJI_ONLY.test(core)) return core;
  return stickerEmoji || '🙂';
}

// Same bubble, new text, is a new reply. A seen-flag would miss it.
// A clock tick on the same bubble is not a new reply.
export function changedBotText(baseline, rows) {
  const prev = new Map((baseline || []).map((row) => [String(row.id), row.text]));
  const parts = [];
  for (const row of rows || []) {
    if (!row || !row.text) continue;
    if (replyCore(prev.get(String(row.id))) === replyCore(row.text)) continue;
    parts.push(row.text);
  }
  return parts.join('\n');
}

export function lastBotLine(rows) {
  for (let i = (rows || []).length - 1; i >= 0; i--) {
    if (rows[i] && rows[i].text) return rows[i].text;
  }
  return '';
}

export function sameBotLine(left, right) {
  return replyCore(left) === replyCore(right);
}

// «Стикер готов» already means this sticker is in the pack, so the next
// image is sent. A clock tick on that bubble is the same acceptance, not a
// new wait. The same clock can still be replaced by an emoji ask or a
// rejection. A picture-request clock tick is not a reply.
export function stickerReplyText(baseline, rows) {
  const changed = changedBotText(baseline, rows);
  const changedKind = imageReply(changed);
  if (changedKind === 'emoji' || changedKind === 'reject') {
    return { text: changed, kind: changedKind };
  }
  if (changedKind === 'ready') return { text: changed, kind: 'ready' };
  const last = lastBotLine(rows);
  const prev = lastBotLine(baseline);
  // The line is already «Стикер готов». The same words, or only a new clock,
  // are that acceptance. Send the next image. Do not open another wait.
  if (imageReply(last) === 'ready' && imageReply(prev) === 'ready' && sameBotLine(last, prev)) {
    return { text: last, kind: 'ready' };
  }
  if (!last || sameBotLine(last, prev)) return { text: changed, kind: 'pending' };
  const lastKind = imageReply(last);
  if (lastKind === 'ready' || lastKind === 'emoji' || lastKind === 'reject') return { text: last, kind: lastKind };
  return { text: changed, kind: 'pending' };
}

// The first notices can be short. After 30s the card shows the line the bot is actually showing.
export function waitLastLine(seconds, lastLine) {
  if (Number(seconds) < 30) return '';
  return String(lastLine || '').replace(/\s+/g, ' ').trim();
}

// After send: answer an emoji request, accept «Стикер готов», or retry a real
// rejection. Silence is a wait, not one of those.
export function afterSendReply(kind) {
  if (kind === 'ready') return 'next';
  if (kind === 'emoji') return 'emoji';
  if (kind === 'reject') return 'retry';
  return 'wait';
}

export function waitStatusDue(now, startedAt, lastSentAt) {
  if (now - startedAt < 20000) return false;
  if (!lastSentAt) return true;
  return now - lastSentAt >= 20000;
}

export function settledImageReply(text, sameForMs) {
  const kind = imageReply(text);
  if (kind !== 'pending') return kind;
  if (String(text || '').trim() && sameForMs >= 400) return 'reject';
  return 'pending';
}

// A real «Не удалось обработать» can be retried. A silent wait is not one of
// these attempts and does not skip the file.
export const IMAGE_ATTEMPTS = 5;

export function afterImageAttempts(attempt, accepted) {
  if (accepted) return 'next';
  if (attempt < IMAGE_ATTEMPTS) return 'retry';
  return 'skip';
}

// The page script cannot see the Node variable. The direction has to be a
// number inside the script, or the chat survey throws and sends nothing.
export function scrollPageScript(direction) {
  const way = direction < 0 ? -1 : 1;
  return `(() => {
    const s = document.querySelector('.ui-InfiniteList-ScrollContainer');
    if (!s || !('scrollTop' in s)) return -1;
    const step = Math.max(120, Math.floor(s.clientHeight * 0.25));
    const direction = ${way};
    s.scrollTop = direction < 0 ? Math.max(0, s.scrollTop - step) : Math.min(s.scrollHeight, s.scrollTop + step);
    return s.scrollTop;
  })()`;
}

function mentionsPack(text, title, kind) {
  const body = String(text || '');
  if (!body.includes('«' + title + '»')) return false;
  if (kind === 'saved') return SAVED.test(body);
  return /Создан набор/.test(body);
}

// Count only «Стикер готов» after this pack was created. Older packs in the
// same chat do not count. A saved pack is not continued.
export function resumeFromChat(messages, title, imageCount) {
  const incoming = (messages || []).filter((message) => message && !message.own);
  let createdAt = -1;
  let saved = null;
  let savedAt = -1;
  incoming.forEach((message, index) => {
    if (mentionsPack(message.text, title, 'created')) createdAt = index;
    if (mentionsPack(message.text, title, 'saved')) {
      saved = message;
      savedAt = index;
    }
  });
  if (saved && savedAt > createdAt) {
    return {
      action: 'saved',
      uploaded: imageCount,
      url: extractPackUrl(saved.text, saved.links),
      lastText: saved.text || '',
    };
  }
  if (createdAt < 0) return { action: 'newpack', uploaded: 0, lastText: '' };
  const after = incoming.slice(createdAt + 1);
  const accepted = after.filter((message) => READY.test(message.text)).length;
  const last = after.length ? after[after.length - 1] : null;
  const lastText = last ? last.text : '';
  if (accepted >= imageCount) return { action: 'finish', uploaded: imageCount, lastText };
  if (last && isEmojiRequest(lastText)) return { action: 'emoji', uploaded: accepted, lastText };
  return { action: 'continue', uploaded: accepted, lastText };
}

// Ready lines at the tail of an open pack. The emoji ask or the picture request
// after them is not another accepted sticker.
export function acceptedInOpenPack(messages) {
  const incoming = (messages || []).filter((message) => message && !message.own);
  let end = incoming.length;
  while (end > 0) {
    const text = incoming[end - 1].text || '';
    if (READY.test(text)) break;
    if (isEmojiRequest(text) || wantsPicture(text) || /не картинк/i.test(text)) {
      end -= 1;
      continue;
    }
    break;
  }
  let accepted = 0;
  for (let i = end - 1; i >= 0; i--) {
    if (!READY.test(incoming[i].text || '')) break;
    accepted += 1;
  }
  return accepted;
}

// Survey can miss the created-title line and call the open pack "new".
// Continue it. Do not send /newpack, and do not close it with /done.
export function planUpload(historyPlan, messages, liveText, imageCount) {
  if (!historyPlan || historyPlan.action !== 'newpack' || !unfinishedPack(liveText)) return historyPlan;
  const accepted = Math.min(acceptedInOpenPack(messages), imageCount);
  const lastText = String(liveText || historyPlan.lastText || '');
  if (accepted >= imageCount) return { action: 'finish', uploaded: imageCount, lastText };
  if (isEmojiRequest(lastText)) return { action: 'emoji', uploaded: accepted, lastText };
  return { action: 'continue', uploaded: accepted, lastText };
}

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
  if (/не картинк/i.test(body)) return false;
  return ASK_PICTURE.test(body) || (CREATED.test(body) && /отправ/i.test(body));
}

// The idle menu names /newpack and /done. An open pack is still accepting
// stickers, or it just refused a command because it wanted a picture.
export function unfinishedPack(text) {
  const body = String(text || '');
  if (!body.trim() || SAVED.test(body) || ASK_TITLE.test(body)) return false;
  if (READY.test(body) || CREATED.test(body)) return true;
  if (ASK_EMOJI.test(body) || NOT_EMOJI.test(body)) return true;
  if (/не картинк/i.test(body)) return true;
  if (ASK_PICTURE.test(body)) return true;
  return false;
}

// /newpack and /start must not land in an open pack. /done comes first.
export function nextCommand(seenText, intended) {
  if (unfinishedPack(seenText) && intended !== '/done') return '/done';
  return intended;
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

function openAdminFeed(dirRef) {
  const token = process.env.TG2TMBOT_TOKEN || '';
  return createAdminFeed({
    io: token ? telegramIo(fetch, token) : null,
    requester: process.env.TELEGRAM_CHAT_ID || '',
    writeState: (state) => {
      try {
        mkdirSync(join(ROOT, 'logs'), { recursive: true });
        writeFileSync(join(ROOT, 'logs', 'admin-last.json'), JSON.stringify(state));
      } catch {
        console.log('admin status file skipped');
      }
    },
    onDelivered: (event, delivery) => {
      if (!delivery || delivery.action === 'skip' || !dirRef.dir) return;
      const index = Number(event.index);
      const total = Number(event.total);
      return postProgress(fetch, process.env.TG2TM_PROGRESS_URL || '', process.env.UPLOADER_SECRET || '', {
        slug: dirRef.dir,
        title: event.pack,
        status: event.phase === 'error' || event.phase === 'failed' ? 'error' : event.phase === 'saved' || event.phase === 'link' ? 'done' : 'uploading',
        uploaded: Number.isFinite(index) ? index : 0,
        total: Number.isFinite(total) ? total : 0,
        packUrl: event.link || null,
        error: event.error || null,
        lastLine: event.lastLine || null,
        phase: event.phase,
        requester: event.requester || null,
      });
    },
  });
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

async function uploadPack(bot, dir, { close = false, note = async () => {}, dirRef = null } = {}) {
  const p = loadPack(dir);
  const m = p.meta;
  const tm = m.telemost = { status: 'pending', uploaded: 0, packUrl: null, error: null, ...m.telemost };
  if (tm.status === 'done') { console.log(dir, 'already done'); return; }
  if (!m.images?.length) throw new Error(`${dir}: no images yet`);
  if (dirRef) dirRef.title = m.title;
  await note({ phase: 'start', pack: m.title, total: m.images.length });

  const history = await bot.surveyChat();
  let plan = resumeFromChat(history.messages, m.title, m.images.length);
  const live = await bot.recentIncoming(2);
  const liveText = String(live.text || plan.lastText || '');
  plan = planUpload(plan, history.messages, liveText, m.images.length);
  console.log(dir, 'chat-plan', plan.action, plan.uploaded, history.reachedTop ? 'top' : 'partial', unfinishedPack(liveText) ? 'open' : 'idle');
  if (plan.action === 'newpack' && !history.reachedTop && !unfinishedPack(liveText)) {
    throw new Error('chat history did not load; not sending images');
  }
  if (plan.action === 'newpack' && unfinishedPack(liveText)) {
    throw new Error(`refusing /newpack while a pack is still open: ${liveText.replace(/\s+/g, ' ').trim().slice(0, 200)}`);
  }
  if (plan.action === 'saved') {
    if (!plan.url) throw new Error('pack already saved but the link was not in the chat');
    await rememberAndPost(p, dir, plan.url, plan.lastText, note);
    return;
  }

  let lastText = plan.lastText || '';
  if (plan.action !== 'newpack') {
    tm.created = true;
    tm.uploaded = plan.uploaded;
    tm.pendingFile = null;
    tm.status = 'uploading';
    if (plan.action === 'emoji') {
      const img = m.images[plan.uploaded];
      const onWait = (seconds, seenLine) => note({
        phase: 'waiting',
        pack: m.title,
        index: plan.uploaded + 1,
        total: m.images.length,
        seconds,
        lastLine: waitLastLine(seconds, seenLine),
      });
      await note({ phase: 'emoji', pack: m.title, index: plan.uploaded + 1, total: m.images.length, lastLine: lastText });
      let reply = await bot.say(emojiAnswer('', img.emoji), { onWait, until: 'sticker' });
      if (reply.kind === 'emoji') reply = await bot.say('🙂', { onWait, until: 'sticker' });
      if (reply.kind !== 'ready') throw new Error(`emoji: ${String(reply.text || '').slice(0, 200)}`);
      await note({ phase: 'ready', pack: m.title, index: plan.uploaded + 1, total: m.images.length, lastLine: reply.text });
      tm.uploaded += 1;
      lastText = reply.text;
    }
    savePack(p);
  } else if (mustOpenNewPack(tm)) {
    const before = await bot.recentIncoming(1);
    if (nextCommand(before.text, '/newpack') !== '/newpack') {
      throw new Error(`refusing /newpack while a pack is still open: ${String(before.text || '').replace(/\s+/g, ' ').trim().slice(0, 200)}`);
    }
    await note({ phase: 'newpack', pack: m.title, lastLine: before.text });
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
    await note({ phase: 'sending', pack: m.title, index: i + 1, total: m.images.length, lastLine: lastText });
    const onWait = (seconds, seenLine) => note({
      phase: 'waiting',
      pack: m.title,
      index: i + 1,
      total: m.images.length,
      seconds,
      lastLine: waitLastLine(seconds, seenLine),
    });
    let accepted = false;
    let rejects = 0;
    while (!accepted) {
      const reply = await bot.sendImage(file, { onWait });
      const shown = String(reply.text || '').replace(/\s+/g, ' ').trim();
      console.log(dir, 'bot', reply.kind, shown.slice(0, 180));
      if (reply.kind === 'reject') {
        rejects += 1;
        log(m.title, img.file, `ошибка, попытка ${rejects}`, shown);
        await note({ phase: 'retry', pack: m.title, index: i + 1, total: m.images.length, attempt: rejects, lastLine: shown, error: shown });
        if (afterImageAttempts(rejects, false) === 'skip') {
          tm.skipped = [...(tm.skipped || []), img.file];
          log(m.title, img.file, 'пропуск', 'бот отклонил картинку');
          await note({ phase: 'error', pack: m.title, index: i + 1, total: m.images.length, lastLine: shown, error: 'бот отклонил картинку' });
          savePack(p);
          break;
        }
        await sleep(1000);
        continue;
      }
      let done = reply;
      if (reply.kind === 'emoji') {
        console.log(dir, 'emoji', img.file);
        await note({ phase: 'emoji', pack: m.title, index: i + 1, total: m.images.length, lastLine: shown });
        done = await bot.say(emojiAnswer(reply.text, img.emoji), { onWait, until: 'sticker' });
        if (done.kind === 'emoji') done = await bot.say('🙂', { onWait, until: 'sticker' });
        if (done.kind === 'emoji') {
          const baseline = await bot.botRows();
          done = await bot.waitForReply(baseline, { onWait, until: 'sticker' });
        }
        const doneText = String(done.text || '').replace(/\s+/g, ' ').trim();
        console.log(dir, 'bot', done.kind, doneText.slice(0, 180));
        if (done.kind === 'reject') {
          rejects += 1;
          log(m.title, img.file, `ошибка, попытка ${rejects}`, doneText);
          await note({ phase: 'retry', pack: m.title, index: i + 1, total: m.images.length, attempt: rejects, lastLine: doneText, error: doneText });
          if (afterImageAttempts(rejects, false) === 'skip') {
            tm.skipped = [...(tm.skipped || []), img.file];
            log(m.title, img.file, 'пропуск', 'бот отклонил картинку');
            await note({ phase: 'error', pack: m.title, index: i + 1, total: m.images.length, lastLine: doneText, error: 'бот отклонил картинку' });
            savePack(p);
            break;
          }
          await sleep(1000);
          continue;
        }
      }
      // «Стикер готов» is already on screen, including when only its clock moved.
      // That sticker is in the pack. Send the next image. Do not wait again.
      if (done.kind !== 'ready') continue;
      lastText = done.text;
      await note({ phase: 'ready', pack: m.title, index: i + 1, total: m.images.length, lastLine: lastText });
      accepted = true;
    }
    if (!accepted) continue;
    tm.uploaded = i + 1;
    if (tm.uploaded % 10 === 0 || tm.uploaded === m.images.length) {
      savePack(p);
      console.log(dir, tm.uploaded, '/', m.images.length);
    }
  }

  tm.status = 'uploading';
  tm.error = null;
  savePack(p);
  if (!close) {
    log(m.title, '', `отправлены ${m.images.length} стикеров`, 'без /done');
    return;
  }
  let readyText = lastText;
  if (finalizeDecision(readyText).action !== 'done') {
    const seen = await bot.recentIncoming(1);
    readyText = seen.text;
    const shown = String(readyText || '').replace(/\s+/g, ' ').trim();
    console.log(dir, 'last-reply', shown.slice(0, 400));
  }
  if (finalizeDecision(readyText).action !== 'done') {
    throw new Error(`not ready to save: ${String(readyText || '').replace(/\s+/g, ' ').trim().slice(0, 200)}`);
  }
  const saved = await publishSavedPack(bot, p, dir, note);
  if (!saved) throw new Error('done did not save the pack');
}

async function rememberAndPost(p, dir, url, replyText, note = async () => {}) {
  const m = p.meta;
  const tm = m.telemost;
  tm.status = 'done';
  tm.packUrl = url;
  tm.error = null;
  tm.uploaded = m.images.length;
  tm.pendingFile = null;
  tm.botReply = String(replyText || '').slice(0, 300);
  savePack(p);
  console.log(dir, 'pack-url', url);
  await note({ phase: 'saved', pack: m.title, lastLine: replyText });
  await note({ phase: 'link', pack: m.title, lastLine: replyText, link: url });
  await postPackLink(fetch, process.env.TG2TMBOT_TOKEN || '', m.title, url);
  console.log(dir, 'channel-posted', '@tg2tm');
}

async function publishSavedPack(bot, p, dir, note = async () => {}) {
  const m = p.meta;
  const tm = m.telemost;
  await note({ phase: 'done', pack: m.title, lastLine: tm.botReply || '' });
  const done = await bot.say('/done');
  const doneText = String(done.text || '').replace(/\s+/g, ' ').trim();
  console.log(dir, 'done-reply', doneText.slice(0, 400));
  const url = extractPackUrl(done.text, done.links);
  if (!SAVED.test(done.text) || !url) {
    console.log(dir, 'draft-gone', 'done did not save the pack');
    return false;
  }
  tm.status = 'done';
  tm.packUrl = url;
  tm.error = null;
  tm.uploaded = m.images.length;
  tm.pendingFile = null;
  tm.botReply = doneText.slice(0, 300);
  savePack(p);
  console.log(dir, 'pack-url', url);
  await note({ phase: 'saved', pack: m.title, lastLine: doneText });
  await note({ phase: 'link', pack: m.title, lastLine: doneText, link: url });
  await postPackLink(fetch, process.env.TG2TMBOT_TOKEN || '', m.title, url);
  console.log(dir, 'channel-posted', '@tg2tm');
  return true;
}

async function finalizePack(bot, dir, note = async () => {}, dirRef = null) {
  const p = loadPack(dir);
  const m = p.meta;
  if (dirRef) dirRef.title = m.title;
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
  const saved = await publishSavedPack(bot, p, dir, note);
  if (!saved) return;
}

export function dirsForRun(dirs, { finalize = false, close = false } = {}) {
  const list = [...dirs];
  if (finalize) return list.filter((dir) => dir.startsWith('07'));
  if (close) return list.filter((dir) => dir.startsWith('08'));
  return list;
}

async function main() {
  const finalize = process.argv.includes('--finalize');
  const close = process.argv.includes('--close');
  const wanted = process.argv.slice(2).filter((arg) => arg !== '--finalize' && arg !== '--close');
  let dirs = readdirSync(PACKS).filter(d => /^\d\d-/.test(d)).sort().filter(d => !wanted.length || wanted.includes(d.slice(0, 2)) || wanted.includes(d));
  const skipped = dirs.filter((dir) => !dirsForRun([dir], { finalize, close }).length);
  if (skipped.length) console.log('skip', skipped.join(' '));
  dirs = dirsForRun(dirs, { finalize, close });
  const c = await connect();
  const bot = new Bot(c);
  const dirRef = { dir: '', title: '' };
  const note = openAdminFeed(dirRef);
  for (const d of dirs) {
    dirRef.dir = d;
    try {
      if (finalize) await finalizePack(bot, d, note, dirRef);
      else await uploadPack(bot, d, { close, note, dirRef });
    } catch (e) {
      log(d, '', 'остановлено', e.message);
      await note({ phase: 'error', pack: dirRef.title || d, error: e.message });
      process.exitCode = 1;
      break;
    }
  }
  c.close();
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
