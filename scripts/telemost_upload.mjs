// Uploads packs/<slug>/ images to the Telemost "Стикеры" bot through Chrome DevTools (port 9222).
// A finished pack (status done) is skipped. A draft left waiting for an emoji is not
// continued and is not closed with /done: that would publish the short pack. /start
// leaves that draft, then the same title is created again from the first image.
// Usage: node scripts/telemost_upload.mjs [NN ...]
import { readFileSync, writeFileSync, readdirSync, appendFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { createAdminFeed, postProgress, telegramIo } from './admin_status.mjs';
import { drainRemainingQueue } from './queue_drain.mjs';
import { queueCredentialsReadable } from './queue_client.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PACKS = join(ROOT, 'packs');
const LOG = join(ROOT, 'logs', 'transfer-log.md');
const DEFAULT_BOT_URL = 'https://telemost.yandex.ru/user/fe21ed07-748c-969d-7459-b4e06d03e84d';
const DEFAULT_STAGING_URL = 'https://telemost.yandex.ru/join#87de7b40-0e2e-0557-537a-fa84858fd189';
const DEVTOOLS = process.env.DEVTOOLS || 'http://127.0.0.1:9222';
const POLL_MS = 100;

// Bot + staging chat URLs live in config/settings.json (overridable by env).
export function loadTelemostUrls(env = process.env, settingsPath = join(ROOT, 'config', 'settings.json')) {
  let file = {};
  try {
    file = JSON.parse(readFileSync(settingsPath, 'utf8'));
  } catch {
    file = {};
  }
  const t = (file && file.telemost) || {};
  const botUrl = String(env.TELEMOST_BOT_URL || t.botUrl || DEFAULT_BOT_URL).trim();
  const stagingUrl = String(env.TELEMOST_STAGING_URL || t.stagingUrl || DEFAULT_STAGING_URL).trim();
  const windowRaw = Number(env.TELEMOST_STAGING_WINDOW || t.stagingWindow || 5);
  const stagingWindow = Number.isFinite(windowRaw) && windowRaw > 0 ? Math.floor(windowRaw) : 5;
  const flag = env.TELEMOST_STAGING != null ? env.TELEMOST_STAGING : t.staging;
  const stagingEnabled = Boolean(stagingUrl) && String(flag == null ? '1' : flag) !== '0' && String(flag) !== 'false';
  return { botUrl, stagingUrl, stagingWindow, stagingEnabled };
}

export function stagingFillTo(uploaded, filled, total, windowSize) {
  const start = Math.max(Number(filled) || 0, Number(uploaded) || 0);
  const end = Math.min(Number(total) || 0, (Number(uploaded) || 0) + Math.max(1, Number(windowSize) || 5));
  const need = [];
  for (let i = start; i < end; i++) need.push(i);
  return need;
}

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
  constructor(c, urls = loadTelemostUrls()) {
    this.c = c;
    this.botUrl = urls.botUrl || DEFAULT_BOT_URL;
    this.stagingUrl = urls.stagingUrl || '';
    this.chatUrl = this.botUrl;
    this.settledByTarget = Object.create(null);
  }

  async openChat(url) {
    const target = String(url || '').trim();
    if (!target) throw new Error('Telemost chat URL is empty');
    this.chatUrl = target;
    await this.ensureChat();
  }

  async ensureChat() {
    const target = this.chatUrl || this.botUrl;
    const settled = this.settledByTarget[target];
    const href = await this.c.ev('location.href');
    const here = String(href || '');
    const onTarget = here === target
      || (settled && (here === settled || here.startsWith(settled)))
      || (target.includes('#') && here.includes(target.slice(target.indexOf('#'))))
      || (!target.includes('#') && here.startsWith(target));
    if (!onTarget) {
      await this.c.send('Page.navigate', { url: target });
    }
    for (let i = 0; i < 60; i++) {
      if (await this.c.ev(`!!document.querySelector('[contenteditable=true]')`)) {
        this.settledByTarget[target] = await this.c.ev('location.href');
        return;
      }
      await sleep(500);
    }
    throw new Error('Telemost chat did not load');
  }

  // Every bubble (ours and the bot's) shares one id space so a reply can be
  // anchored after the outbound message we just sent.
  chatRows() {
    return this.c.ev(`(() => {
      const s = document.querySelector('.ui-InfiniteList-ScrollContainer');
      if (s && 'scrollTop' in s) s.scrollTop = s.scrollHeight;
      window.__tg2tmNext = window.__tg2tmNext || 1;
      const rows = [...document.querySelectorAll('article.message')].filter((a) => a.querySelector('.yamb-message-row'));
      return rows.map((a) => {
        if (!a.dataset.tg2tmId) a.dataset.tg2tmId = String(window.__tg2tmNext++);
        return {
          id: a.dataset.tg2tmId,
          own: !!a.querySelector('.yamb-message-row_own'),
          hasImage: !!a.querySelector('img[src], img[data-src], picture img'),
          text: (a.innerText || '').replace(/\\s+/g, ' ').trim(),
          // «сохранён и доступен по ссылке» keeps the pack URL only on <a href>.
          links: [...a.querySelectorAll('a[href]')].map((x) => x.href),
        };
      });
    })()`);
  }

  async botRows() {
    const rows = await this.chatRows();
    return (rows || []).filter((row) => row && !row.own).map(({ id, text, links }) => ({ id, text, links }));
  }

  scrollToBottom() {
    return this.c.ev(`(() => { const s = document.querySelector('.ui-InfiniteList-ScrollContainer'); if (s && 'scrollTop' in s) s.scrollTop = s.scrollHeight; })()`);
  }

  // A seen flag hides a bubble the bot rewrites in place. Compare text instead.
  // «Отправьте эмодзи» and the following «Стикер готов» are replies, not timeouts.
  // An unchanged «Стикер готов» from the previous sticker is not acceptance of
  // the image just sent — wait for a real new bot line after our outbound
  // message (or stall and recover).
  async waitForReply(baseline, {
    onWait,
    until,
    savedTimeoutMs = 20000,
    stallMs = STALL_MS,
    ownBeforeIds = null,
  } = {}) {
    const started = Date.now();
    let lastSentAt = 0;
    let stable = '';
    let stableAt = 0;
    let savedSeenAt = 0;
    let progressAt = started;
    let progressKey = '';
    let busySince = 0;
    for (;;) {
      const thread = until === 'sticker' ? await this.chatRows() : null;
      const rows = thread ? (thread || []).filter((row) => row && !row.own) : await this.botRows();
      const busy = until === 'sticker' ? await this.chatBusy() : false;
      // A sticker wait needs a new bot line that advances or errors.
      // A command wait does not reuse an old «Стикер готов».
      // /done waits for «сохранён» even when an older emoji ask is still in the
      // changed text, and keeps polling until the sticker <a> appears.
      let seen;
      if (until === 'sticker') {
        const afterOwnId = newOwnId(ownBeforeIds, thread);
        seen = stickerReplyText(baseline, rows, { thread, afterOwnId });
      } else if (until === 'saved') seen = savedReplyText(baseline, rows);
      else {
        const changed = changedBotText(baseline, rows);
        seen = { text: changed, links: changedBotLinks(baseline, rows), kind: imageReply(changed) };
      }
      const text = seen.text;
      const links = seen.links || [];
      const kind = seen.kind;
      const stickerReply = kind === 'ready' || kind === 'emoji' || kind === 'reject';
      // Busy must not sit in this key: page chrome that flickers busy would
      // reset the stall clock forever while a real «Стикер готов» sits ignored.
      const key = `${kind}|${replyCore(text)}|${replyCore(lastBotLine(rows))}`;
      if (key !== progressKey) {
        progressKey = key;
        progressAt = Date.now();
      }
      if (busy) {
        if (!busySince) busySince = Date.now();
        else if (Date.now() - busySince >= 2000) progressAt = Date.now();
      } else {
        busySince = 0;
      }
      if (until === 'sticker' && stickerReply) {
        return { text, links, seconds: (Date.now() - started) / 1000, kind };
      }
      if (until === 'sticker' && stallDue(Date.now(), progressAt, stallMs)) {
        return {
          text: text || lastBotLine(rows),
          links,
          seconds: (Date.now() - started) / 1000,
          kind: 'stall',
        };
      }
      if (until === 'saved') {
        if (SAVED.test(text)) {
          if (!savedSeenAt) savedSeenAt = Date.now();
          const url = extractPackUrl(text, links);
          const waited = Date.now() - savedSeenAt;
          // The href often lands a moment after the «сохранён» wording.
          if (url || waited >= 2500) {
            return { text, links, seconds: (Date.now() - started) / 1000, kind: 'saved' };
          }
        } else if (Date.now() - started >= savedTimeoutMs) {
          // Let publishSavedPack re-read the chat or send /done again.
          return {
            text: text || lastBotLine(rows),
            links: [...links, ...savedPackLinks(rows)],
            seconds: (Date.now() - started) / 1000,
            kind: kind === 'pending' ? 'other' : kind,
          };
        }
      } else if (until !== 'sticker' && text.trim()) {
        const sameFor = text === stable ? Date.now() - stableAt : 0;
        if (kind !== 'pending' || sameFor >= 400) {
          return { text, links, seconds: (Date.now() - started) / 1000, kind: kind === 'pending' ? 'other' : kind };
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

  // Only spinners on recent bubbles count as "bot working". Page-wide
  // progress/skeleton chrome used to keep resetting the stall timer.
  chatBusy() {
    return this.c.ev(`(() => {
      const messages = [...document.querySelectorAll('article.message')].slice(-8);
      for (const a of messages) {
        if (a.querySelector('[aria-busy="true"], [role="progressbar"]')) {
          const hit = a.querySelector('[aria-busy="true"], [role="progressbar"]');
          const r = hit.getBoundingClientRect();
          if (r.width > 0 && r.height > 0) return true;
        }
        for (const el of a.querySelectorAll('[class]')) {
          const cls = String(el.className || '');
          if (!/(?:^|\\s|_|-)(?:spinner|Spinner|loading|Loading)(?:\\s|_|-|$)/.test(cls)) continue;
          const r = el.getBoundingClientRect();
          if (r.width > 0 && r.height > 0) return true;
        }
      }
      return false;
    })()`);
  }

  async recoverChat() {
    await this.c.send('Page.reload', { ignoreCache: false });
    for (let i = 0; i < 80; i++) {
      if (await this.c.ev(`!!document.querySelector('[contenteditable=true]')`)) break;
      await sleep(500);
    }
    await this.ensureChat();
    await this.scrollToBottom();
  }

  async recentIncoming(limit = 4) {
    await this.ensureChat();
    await this.c.ev(`(() => { const s = document.querySelector('.ui-InfiniteList-ScrollContainer'); if (s && 'scrollTop' in s) s.scrollTop = s.scrollHeight; })()`);
    const slice = Math.max(1, Number(limit) || 4);
    const bubbles = await this.c.ev(`(() => {
      const rows = [...document.querySelectorAll('article.message')].filter(a => a.querySelector('.yamb-message-row') && !a.querySelector('.yamb-message-row_own'));
      return rows.slice(-${slice}).map((row) => ({
        text: (row.innerText || '').trim(),
        links: [...row.querySelectorAll('a[href]')].map((a) => a.href),
      })).filter((b) => b.text);
    })()`);
    const list = bubbles || [];
    const text = list.map((b) => b.text).join('\n');
    // The command menu can be the last bubble. The pack URL sits on the
    // «сохранён» message just above it, so scan the whole recent window.
    const links = list.flatMap((b) => b.links || []);
    return { text: text || '', links: links || [], bubbles: list };
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
    const thread = await this.chatRows();
    const baseline = (thread || []).filter((row) => row && !row.own).map(({ id, text, links }) => ({ id, text, links }));
    const ownBeforeIds = ownIds(thread);
    await this.c.ev(`(() => { const e = document.querySelector('[contenteditable=true]'); e.focus(); })()`);
    await this.c.send('Input.insertText', { text });
    await this.clickSend(false);
    return this.waitForReply(baseline, { ownBeforeIds, ...(opts || {}) });
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
    const nodeId = await this.fileInput();
    await this.c.send('DOM.setFileInputFiles', { nodeId, files: [path] });
    for (let i = 0; i < 80; i++) {
      const open = await this.c.ev(`[...document.querySelectorAll('[aria-label="Отправить сообщение"]')].filter(e => e.getBoundingClientRect().width > 0).length > 1`);
      if (open) break;
      await sleep(POLL_MS);
    }
    // Baseline at click time so a late ready from the previous sticker is not
    // treated as the reply to this file, and a ready that lands after our send
    // can still be matched against the outbound bubble.
    const thread = await this.chatRows();
    const baseline = (thread || []).filter((row) => row && !row.own).map(({ id, text, links }) => ({ id, text, links }));
    const ownBeforeIds = ownIds(thread);
    await this.clickSend(true);
    return this.waitForReply(baseline, { until: 'sticker', ownBeforeIds, ...(opts || {}) });
  }

  // Staging buffer: put the file in the open chat and return when our bubble
  // appears. Do not wait for a bot reply — that chat is only an image queue.
  async sendImageNoWait(path, { timeoutMs = 60000 } = {}) {
    await this.ensureChat();
    await this.scrollToBottom();
    const threadBefore = await this.chatRows();
    const beforeOwnIds = ownIds(threadBefore);
    const beforeCount = (threadBefore || []).length;
    const beforeAllIds = rowIds(threadBefore);
    const nodeId = await this.fileInput();
    await this.c.send('DOM.setFileInputFiles', { nodeId, files: [path] });
    for (let i = 0; i < 80; i++) {
      const open = await this.c.ev(`[...document.querySelectorAll('[aria-label="Отправить сообщение"]')].filter(e => e.getBoundingClientRect().width > 0).length > 1`);
      if (open) break;
      await sleep(POLL_MS);
    }
    await this.clickSend(true);
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      const rows = await this.chatRows();
      const ownId = stagingOwnIdAfterSend(beforeOwnIds, beforeCount, rows, beforeAllIds);
      if (ownId) return ownId;
      await sleep(POLL_MS);
    }
    const rows = await this.chatRows();
    console.log('staging upload timeout', {
      beforeCount,
      rowCount: (rows || []).length,
      ownCount: ownIds(rows).length,
    });
    throw new Error('staging upload: own message did not appear');
  }

  async clickLabel(label) {
    const lit = JSON.stringify(String(label));
    for (let i = 0; i < 40; i++) {
      const ok = await this.c.ev(`(() => {
        const want = ${lit};
        const nodes = [...document.querySelectorAll('button, [role="menuitem"], [role="button"], [aria-label], span, div')];
        const el = nodes.find((e) => {
          const aria = (e.getAttribute('aria-label') || '').trim();
          const text = (e.innerText || e.textContent || '').replace(/\\s+/g, ' ').trim();
          if (aria === want || text === want) {
            const r = e.getBoundingClientRect();
            return r.width > 0 && r.height > 0;
          }
          return false;
        });
        if (!el) return false;
        el.click();
        return true;
      })()`);
      if (ok) return true;
      await sleep(POLL_MS);
    }
    return false;
  }

  async openMessageMenu(ownId) {
    const id = JSON.stringify(String(ownId));
    const opened = await this.c.ev(`(() => {
      const want = ${id};
      const row = [...document.querySelectorAll('article.message')].find((a) => a.dataset.tg2tmId === want);
      if (!row) return false;
      row.scrollIntoView({ block: 'center' });
      const r = row.getBoundingClientRect();
      const x = r.x + Math.min(r.width - 4, Math.max(4, r.width * 0.5));
      const y = r.y + Math.min(r.height - 4, Math.max(4, r.height * 0.5));
      const opts = { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 2, buttons: 2 };
      row.dispatchEvent(new MouseEvent('contextmenu', opts));
      const btn = row.querySelector('[aria-label="Действия с сообщением"], [aria-label="Ещё"], button[aria-haspopup="menu"]');
      if (btn) btn.click();
      return true;
    })()`);
    if (!opened) throw new Error(`staging forward: message ${ownId} not found`);
    await sleep(200);
  }

  // Forward one staging bubble into the stickers bot chat (no disk upload there).
  async forwardOwnToBot(ownId, botUrl = this.botUrl) {
    await this.scrollToBottom();
    await this.openMessageMenu(ownId);
    if (!(await this.clickLabel('Переслать'))) {
      throw new Error('staging forward: Переслать not found');
    }
    await sleep(300);
    const botName = 'Стикеры';
    const botUser = (String(botUrl).match(/\/user\/([^/?#]+)/) || [])[1] || '';
    const picked = await this.c.ev(`(() => {
      const want = ${JSON.stringify(botName)};
      const user = ${JSON.stringify(botUser)};
      const nodes = [...document.querySelectorAll('button, [role="option"], [role="listitem"], a, div, span')];
      const el = nodes.find((e) => {
        const text = (e.innerText || e.textContent || '').replace(/\\s+/g, ' ').trim();
        const href = e.getAttribute && (e.getAttribute('href') || '');
        const r = e.getBoundingClientRect();
        if (r.width < 2 || r.height < 2) return false;
        if (text === want || text.startsWith(want + ' ')) return true;
        if (user && href && href.includes(user)) return true;
        return false;
      });
      if (!el) return false;
      el.click();
      return true;
    })()`);
    if (!picked) {
      const search = await this.c.ev(`(() => {
        const el = document.querySelector('input[type="search"], input[placeholder*="Поиск"], input[aria-label*="Поиск"]');
        if (!el) return false;
        el.focus();
        return true;
      })()`);
      if (search) {
        await this.c.send('Input.insertText', { text: botName });
        await sleep(400);
        if (!(await this.clickLabel(botName))) {
          throw new Error('staging forward: stickers chat not in picker');
        }
      } else {
        throw new Error('staging forward: stickers chat not in picker');
      }
    }
    await sleep(200);
    const sent = await this.c.ev(`(() => {
      const buttons = [...document.querySelectorAll('[aria-label="Отправить сообщение"], button')].filter((e) => e.getBoundingClientRect().width > 0);
      const confirm = buttons.find((e) => {
        const t = (e.innerText || e.getAttribute('aria-label') || '').replace(/\\s+/g, ' ').trim();
        return t === 'Переслать' || t === 'Отправить' || t === 'Отправить сообщение';
      });
      if (!confirm) return false;
      confirm.click();
      return true;
    })()`);
    void sent;
    await this.openChat(botUrl);
  }

  // Best-effort residue cleanup: delete recent own bubbles (staging or bot chat).
  async clearChatResidue({ limit = 200 } = {}) {
    await this.ensureChat();
    await this.scrollToBottom();
    let removed = 0;
    for (let n = 0; n < limit; n++) {
      const thread = await this.chatRows();
      const own = [...(thread || [])].reverse().find((row) => row && row.own);
      if (!own) break;
      try {
        await this.openMessageMenu(own.id);
      } catch {
        break;
      }
      if (!(await this.clickLabel('Удалить')) && !(await this.clickLabel('Удалить сообщение'))) {
        await this.c.ev(`(() => { document.body.click(); })()`);
        break;
      }
      await sleep(150);
      if (!(await this.clickLabel('Удалить у всех'))) await this.clickLabel('Удалить');
      removed += 1;
      await sleep(150);
    }
    const cleared = await this.c.ev(`(() => {
      const btn = [...document.querySelectorAll('button, [role="menuitem"]')].find((e) => /Очистить историю|Clear history/i.test((e.innerText || e.getAttribute('aria-label') || '')));
      if (!btn || btn.getBoundingClientRect().width < 1) return false;
      btn.click();
      return true;
    })()`);
    if (cleared) {
      await sleep(200);
      await this.clickLabel('Очистить') || await this.clickLabel('Удалить');
    }
    return removed;
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
const SAVED = /сохранён/i;
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

// Collect hrefs from bubbles whose text just changed. Late-hydrated links on a
// «сохранён» bubble are gathered separately by savedPackLinks.
export function changedBotLinks(baseline, rows) {
  const prev = new Map((baseline || []).map((row) => [String(row.id), row.text]));
  const links = [];
  for (const row of rows || []) {
    if (!row || !row.text) continue;
    if (replyCore(prev.get(String(row.id))) === replyCore(row.text)) continue;
    for (const href of row.links || []) links.push(href);
  }
  return links;
}

// The pack URL is only on the «сохранён» <a>, including when the command menu
// is the newest bot line and an older emoji ask is still in the changed text.
export function savedPackLinks(rows) {
  const links = [];
  for (const row of rows || []) {
    if (!row || !SAVED.test(row.text || '')) continue;
    for (const href of row.links || []) links.push(href);
  }
  return links;
}

export function savedReplyText(baseline, rows) {
  const changed = changedBotText(baseline, rows);
  const fromSaved = (rows || [])
    .filter((row) => row && SAVED.test(row.text || ''))
    .map((row) => row.text);
  const text = [changed, ...fromSaved].filter(Boolean).join('\n');
  const links = [...changedBotLinks(baseline, rows), ...savedPackLinks(rows)];
  if (SAVED.test(text)) return { text, links, kind: 'saved' };
  return { text: changed, links, kind: imageReply(changed) };
}

// «сохранён» without a /stickers/ href is not enough to mark the upload done.
export function packSavedReply(text, links) {
  const body = String(text || '');
  if (!SAVED.test(body)) return { ok: false, reason: 'not-saved', url: '' };
  const url = extractPackUrl(body, links);
  if (!url) return { ok: false, reason: 'missing-url', url: '' };
  return { ok: true, reason: 'saved', url };
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

export function ownIds(rows) {
  return (rows || []).filter((row) => row && row.own).map((row) => String(row.id));
}

export function rowIds(rows) {
  return (rows || []).filter((row) => row && row.id != null).map((row) => String(row.id));
}

// Rows that appeared after a staging send (join buffer may omit .yamb-message-row_own).
export function stagingNewRows(beforeCount, beforeAllIds, rows) {
  const list = rows || [];
  if (beforeAllIds && beforeAllIds.length) {
    const have = new Set(beforeAllIds.map(String));
    const byId = list.filter((row) => row && !have.has(String(row.id)));
    if (byId.length) return byId;
  }
  if (list.length > beforeCount) return list.slice(beforeCount);
  return [];
}

// Staging buffer: accept .own bubbles or any new row (prefer one with an image).
export function stagingOwnIdAfterSend(beforeOwnIds, beforeCount, rows, beforeAllIds = null) {
  const ownId = newOwnId(beforeOwnIds, rows);
  if (ownId) return ownId;
  const newcomers = stagingNewRows(beforeCount, beforeAllIds, rows);
  for (let i = newcomers.length - 1; i >= 0; i--) {
    const row = newcomers[i];
    if (row && row.hasImage) return String(row.id);
  }
  const last = newcomers[newcomers.length - 1];
  return last ? String(last.id) : null;
}

// Newest outbound bubble that was not present before the send.
export function newOwnId(beforeIds, rows) {
  const have = new Set((beforeIds || []).map(String));
  let found = null;
  for (const row of rows || []) {
    if (!row || !row.own) continue;
    if (!have.has(String(row.id))) found = String(row.id);
  }
  return found;
}

// Bot bubbles that sit after our outbound message in the live thread.
export function botRepliesAfterOwn(thread, afterOwnId) {
  if (afterOwnId == null) return [];
  const list = thread || [];
  const idx = list.findIndex((row) => row && String(row.id) === String(afterOwnId));
  if (idx < 0) return [];
  const out = [];
  for (let i = idx + 1; i < list.length; i++) {
    const row = list[i];
    if (!row || row.own || !row.text) continue;
    out.push(row);
  }
  return out;
}

// Only a *new* bot line after the send advances the sticker step.
// An unchanged «Стикер готов» (or its clock tick) from the previous sticker
// is silence: the image just sent still needs a reply. When that line is
// replaced by an emoji ask, rejection, or a fresh «Стикер готов» after our
// outbound bubble, advance.
export function stickerReplyText(baseline, rows, opts = {}) {
  const thread = Array.isArray(opts.thread) ? opts.thread : null;
  const bots = thread ? thread.filter((row) => row && !row.own) : (rows || []);
  const changed = changedBotText(baseline, bots);
  const afterOwnId = opts.afterOwnId;
  // Live chat waits must anchor on a bot line *after* our outbound bubble.
  // changedBotText alone would accept an old «Стикер готов» above the image
  // and send the next file while the bot is still silent.
  if (thread) {
    if (afterOwnId == null) return { text: changed, kind: 'pending' };
    const after = botRepliesAfterOwn(thread, afterOwnId);
    for (let i = after.length - 1; i >= 0; i--) {
      const kind = imageReply(after[i].text);
      if (kind === 'ready' || kind === 'emoji' || kind === 'reject') {
        return { text: after[i].text, kind };
      }
    }
    return { text: changed, kind: 'pending' };
  }
  const changedKind = imageReply(changed);
  if (changedKind === 'emoji' || changedKind === 'reject' || changedKind === 'ready') {
    return { text: changed, kind: changedKind };
  }
  const last = lastBotLine(bots);
  const prev = lastBotLine(baseline);
  // Same bubble / clock-only: still waiting for this send's reply.
  if (!last || sameBotLine(last, prev)) return { text: changed, kind: 'pending' };
  const lastKind = imageReply(last);
  if (lastKind === 'ready' || lastKind === 'emoji' || lastKind === 'reject') {
    return { text: last, kind: lastKind };
  }
  return { text: changed, kind: 'pending' };
}

// No new bubble and no busy spinner for this long → reload and resend.
export const STALL_MS = 120000;

export function stallDue(now, progressAt, stallMs = STALL_MS) {
  return Number(now) - Number(progressAt) >= Number(stallMs);
}

// The first notices can be short. After 30s the card shows the line the bot is actually showing.
export function waitLastLine(seconds, lastLine) {
  if (Number(seconds) < 30) return '';
  return String(lastLine || '').replace(/\s+/g, ' ').trim();
}

// After send: answer an emoji request, accept «Стикер готов», retry a real
// rejection, or recover from a stall. Silence is a wait, not one of those.
export function afterSendReply(kind) {
  if (kind === 'ready') return 'next';
  if (kind === 'emoji') return 'emoji';
  if (kind === 'reject') return 'retry';
  if (kind === 'stall') return 'recover';
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

// /addsticker opens an existing saved pack. The bot asks for the pack link,
// then for pictures the same way as /newpack.
export function afterAddsticker(text) {
  const body = String(text || '');
  if (packDialogOpen(body)) return 'open';
  if (wantsPicture(body)) return 'picture';
  if (/ссылк|stickers\/|набор/i.test(body)) return 'link';
  return 'other';
}

// A saved pack that is short of its images can take more stickers via /addsticker.
// uploaded must be the accurate accepted count (not a raced counter).
export function needsAddSticker(tm, imageCount) {
  if (!tm || !tm.packUrl) return false;
  const uploaded = Number(tm.uploaded) || 0;
  const total = Number(imageCount) || 0;
  if (total <= 0 || uploaded >= total) return false;
  if (tm.status === 'incomplete') return true;
  if (tm.status === 'done' && uploaded < total) return true;
  return false;
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

const INCOMING_BLOCK_START = /^(?:Набор\s|[\u00AB"\u201C\u201E']|Создан набор|Стикер готов|Отправьте|Пришлите|Это не|Напишите название|\/newpack)/;

// When recentIncoming joins several bot bubbles, SAVED on an older line must not
// hide an open draft in the newest bubble.
export function incomingTailText(text) {
  const body = String(text || '').trim();
  if (!body) return '';
  const lines = body.split('\n');
  let start = 0;
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].replace(/\s+/g, ' ').trim();
    if (!line || isClockLine(line)) continue;
    if (INCOMING_BLOCK_START.test(line) || SAVED.test(line) || CREATED.test(line) || COMMAND_MENU.test(line)) {
      start = i;
    }
  }
  return lines.slice(start).join('\n').trim();
}

export function unfinishedPackTail(text) {
  return unfinishedPack(incomingTailText(text));
}

function isCommandMenuBubble(text) {
  const body = String(text || '');
  return COMMAND_MENU.test(body) && /\/done/.test(body);
}

// Open/idle decisions use only the newest bot bubble (skip a trailing menu).
export function latestIncomingText(incoming) {
  const bubbles = incoming?.bubbles;
  if (Array.isArray(bubbles) && bubbles.length) {
    for (let i = bubbles.length - 1; i >= 0; i--) {
      const t = String(bubbles[i].text || '').trim();
      if (!t) continue;
      if (isCommandMenuBubble(t)) continue;
      return t;
    }
    return String(bubbles[bubbles.length - 1].text || '').trim();
  }
  return incomingTailText(String(incoming?.text || incoming || ''));
}

const CREATED_TITLE = /Создан набор(?: стикеров)?\s*[\u00AB"\u201C\u201E']([^»"\u201D']+)[\u00BB"\u201D']/;

// The last created title that has not been saved. Any pack, not one fixed name.
export function openPackTitle(messages) {
  let title = '';
  let open = false;
  for (const message of messages || []) {
    if (!message || message.own) continue;
    const text = String(message.text || '');
    const created = text.match(CREATED_TITLE);
    if (created) {
      title = created[1].trim();
      open = true;
    }
    if (title && text.includes(title) && SAVED.test(text)) open = false;
  }
  return open ? title : '';
}

// Telemost stamps each bubble with HH:MM. That clock is not a pack title and
// must not become the admin-card name or a hard "на экране" error.
export function isClockLine(text) {
  return /^\d{1,2}:\d{2}$/.test(String(text || '').replace(/\s+/g, ' ').trim());
}

export function screenLine(text) {
  const lines = String(text || '')
    .split('\n')
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!isClockLine(lines[i])) return lines[i];
  }
  return '';
}

// Admin cards and restart errors: a real pack name, never a bare clock.
export function statusPackName(value) {
  const named = String(value || '').replace(/\s+/g, ' ').trim();
  if (!named || isClockLine(named)) return '';
  return named;
}

// After /done the bot says «Набор «…» сохранён». Use that when peek missed the title.
export function savedPackTitle(text) {
  const body = String(text || '');
  const match = body.match(/Набор\s*[\u00AB"\u201C\u201E']([^»"\u201D']+)[\u00BB"\u201D']\s*сохранён/i);
  return match ? match[1].trim() : '';
}

// The create-title bot line can scroll away. The title the uploader typed after
// /newpack often remains and is enough to match a folder or stored request.
export function typedPackTitle(messages) {
  let afterNewpack = false;
  let typed = '';
  for (const message of messages || []) {
    if (!message) continue;
    const text = String(message.text || '').replace(/\s+/g, ' ').trim();
    if (message.own && /^\/newpack\b/i.test(text)) {
      afterNewpack = true;
      typed = '';
      continue;
    }
    if (!message.own && (CREATED.test(text) || SAVED.test(text))) {
      afterNewpack = false;
      if (SAVED.test(text)) typed = '';
      continue;
    }
    if (afterNewpack && message.own && text && !text.startsWith('/')) typed = text;
  }
  return typed;
}

// Folder and request titles match without case, quotes, or emoji.
export function packTitleKey(value) {
  return String(value || '')
    .normalize('NFKC')
    .replace(/\p{Extended_Pictographic}/gu, '')
    .replace(/[\u200d\uFE0F\u200b]/g, '')
    .replace(/[\u00AB\u00BB"'\u201C\u201D\u201E\u2018\u2019\u2039\u203A`]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function samePackTitle(left, right) {
  const key = packTitleKey(left);
  return Boolean(key) && key === packTitleKey(right);
}

export function stickerSetName(link) {
  const match = String(link || '').match(/addstickers\/([A-Za-z0-9_]+)/);
  return match ? match[1] : '';
}

function byRequestTime(left, right) {
  const a = String(left.createdAt || '');
  const b = String(right.createdAt || '');
  if (a < b) return -1;
  if (a > b) return 1;
  return String(left.id || '') < String(right.id || '') ? -1 : 1;
}

// An open dialog restarts that pack from its first image. An idle dialog
// takes the next queued request first; only if the queue is empty does it
// resume the row already marked uploading.
// A missing title (or a bare Telemost clock) is not a hard stop: close the
// open dialog, then restart via the active request or the next queued one.
function activeQueueRow(item) {
  return item && (item.status === 'queued' || item.status === 'uploading');
}

// Restart and /queue/plan only consider open work. Done rows must not resurrect.
export function activeQueueRequests(requests) {
  return (requests || []).filter((item) => activeQueueRow(item));
}

export function restartTarget({ unfinished, title, liveText, catalogs, requests, allowCatalog = false } = {}) {
  const stored = activeQueueRequests(requests);
  const namedTitle = statusPackName(title);
  if (unfinished) {
    const catalogsHit = (catalogs || []).filter((pack) => pack && samePackTitle(pack.title, namedTitle));
    const requestsHit = stored.filter((item) => item && samePackTitle(item.title, namedTitle));
    if (catalogsHit.length === 1 && (allowCatalog || requestsHit.length === 1)) {
      const named = requestsHit.length === 1 ? requestsHit[0] : null;
      return {
        action: 'restart',
        title: catalogsHit[0].title,
        dir: catalogsHit[0].dir || '',
        requestId: named ? named.id || '' : '',
        links: named && named.links ? named.links : [],
        chatId: named ? named.chatId || '' : '',
      };
    }
    if (catalogsHit.length === 1 && !allowCatalog && !requestsHit.length) {
      // Finished catalog folder (07, 08, …) with no queued/uploading row: close the dialog.
      if (!packTitleKey(namedTitle)) {
        // empty title — fall through below
      } else {
        return { action: 'close', title: '', liveText: liveText || '' };
      }
    }
    if (catalogsHit.length === 0 && requestsHit.length === 1) {
      const named = requestsHit[0];
      return {
        action: 'restart',
        title: named.title,
        dir: '',
        requestId: named.id || '',
        links: named.links || [],
        chatId: named.chatId || '',
      };
    }
    const active = stored.filter((item) => item && item.status === 'uploading');
    if (!packTitleKey(namedTitle) && catalogsHit.length === 0 && requestsHit.length === 0 && active.length === 1) {
      return {
        action: 'restart',
        title: active[0].title,
        dir: '',
        requestId: active[0].id || '',
        links: active[0].links || [],
        chatId: active[0].chatId || '',
      };
    }
    // Real unmatched / ambiguous title still surfaces as "seen". An empty or
    // clock-only title falls through so /done can run and the queue can continue.
    if (packTitleKey(namedTitle)) {
      const matches = [...catalogsHit.map((pack) => pack.title), ...requestsHit.map((item) => item.title)];
      return { action: 'seen', title: namedTitle, liveText: liveText || '', matches };
    }
  }
  const waiting = stored.filter((item) => item && item.status === 'queued').sort(byRequestTime);
  const priority = waiting.filter((item) => item.priority);
  const next = (priority.length ? priority : waiting)[0];
  if (next) {
    return {
      action: 'upload',
      title: next.title,
      dir: '',
      requestId: next.id || '',
      links: next.links || [],
      chatId: next.chatId || '',
    };
  }
  const active = stored.find((item) => item && item.status === 'uploading');
  if (active) {
    return {
      action: 'upload',
      title: active.title,
      dir: '',
      requestId: active.id || '',
      links: active.links || [],
      chatId: active.chatId || '',
    };
  }
  return unfinished ? { action: 'close', title: '', liveText: liveText || '' } : { action: 'idle' };
}

export function restartAfterClose(text) {
  if (unfinishedPack(text)) return { action: 'stop' };
  return { action: 'newpack', uploaded: 0 };
}

// /newpack and /start must not land in an open pack. /done comes first.
export function nextCommand(seenText, intended) {
  if (unfinishedPack(seenText) && intended !== '/done') return '/done';
  return intended;
}

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
    requester: dirRef.requesterChatId || process.env.TELEGRAM_CHAT_ID || '',
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
        requester: dirRef.requesterChatId || null,
        requesterChatId: dirRef.requesterChatId || null,
        queueRequestId: dirRef.queueRequestId || null,
        sessionDrain: Boolean(dirRef.sessionDrain),
      });
    },
  });
}

function queueDrainEnabled(argv) {
  if (argv.includes('--drain-queue') || argv.includes('--drain-queue-only')) return true;
  if (!queueCredentialsReadable()) return false;
  const flag = String(process.env.TG2TM_QUEUE_DRAIN ?? '1').trim();
  return /^(1|true|yes)$/i.test(flag);
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

// /start only shows the command menu; never use it to close an open draft before /newpack.
export function shouldAbandonOpenPack(liveText, _messages = []) {
  const body = String(liveText || '');
  if (!unfinishedPack(body)) return false;
  // Emoji-waiting (packDialogOpen): closeOpenPackPlan returns blocked — no blind /done or /start.
  if (packDialogOpen(body)) return false;
  return false;
}

export function closeOpenPackPlan(liveText, messages = []) {
  if (!unfinishedPack(liveText)) return { action: 'idle' };
  // ASK_EMOJI / NOT_EMOJI: bot expects an emoji; /done would not safely finish the step.
  if (packDialogOpen(liveText)) return { action: 'blocked' };
  if (finalizeDecision(liveText).action === 'done') return { action: 'done' };
  const accepted = acceptedInOpenPack(messages);
  if (accepted > 0) return { action: 'done' };
  const body = String(liveText || '');
  if (wantsPicture(body) || (CREATED.test(body) && !READY.test(body))) return { action: 'done' };
  return { action: 'done' };
}

// Before /newpack or the next queue item: one /done (with retry), never /start to «abandon».
export async function closeOpenBotPackBeforeNew(bot, note, { label = 'перезапуск', lastLine = '' } = {}) {
  const history = await bot.surveyChat();
  const live = await bot.recentIncoming(2);
  const liveText = String(live.text || '');
  const tailText = latestIncomingText(live);
  if (!unfinishedPack(tailText)) {
    return { action: 'idle', closedText: liveText, liveText, title: '' };
  }

  const plan = closeOpenPackPlan(tailText, history.messages);
  await note({
    phase: 'done',
    pack: label,
    lastLine: lastLine || screenLine(tailText),
  });

  let closedText = '';

  if (plan.action !== 'done') {
    throw new Error(`refusing /newpack while a pack is still open: ${tailText.replace(/\s+/g, ' ').trim().slice(0, 200)}`);
  }
  const closed = await withRetry('close-before-new-done', () => bot.say('/done'));
  closedText = String(closed.text || '');
  console.log('close-before-new-done', closedText.replace(/\s+/g, ' ').trim().slice(0, 400));

  if (restartAfterClose(closedText).action === 'stop') {
    throw new Error(`refusing /newpack while a pack is still open: ${closedText.replace(/\s+/g, ' ').trim().slice(0, 200)}`);
  }

  return {
    action: plan.action,
    closedText,
    liveText,
    title: statusPackName(savedPackTitle(closedText)),
  };
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

async function uploadPack(bot, dir, { close = false, restart = false, note = async () => {}, dirRef = null } = {}) {
  const p = loadPack(dir);
  const m = p.meta;
  let tm = m.telemost = { status: 'pending', uploaded: 0, packUrl: null, error: null, ...m.telemost };
  if (restart) tm = m.telemost = resetForNewPack(tm);
  else if (tm.status === 'done') { console.log(dir, 'already done'); return; }
  if (!m.images?.length) throw new Error(`${dir}: no images yet`);
  if (dirRef) {
    dirRef.title = m.title;
    dirRef.queueRequestId = m.queueRequestId || '';
    dirRef.requesterChatId = m.requesterChatId || '';
  }
  if (restart) {
    await closeOpenBotPackBeforeNew(bot, note, { label: m.title });
  }
  await note({ phase: 'start', pack: m.title, total: m.images.length });

  const history = await bot.surveyChat();
  let plan = resumeFromChat(history.messages, m.title, m.images.length);
  const live = await bot.recentIncoming(2);
  const liveText = String(live.text || plan.lastText || '');
  const tailText = latestIncomingText(live.text ? live : { text: liveText, bubbles: [] });
  plan = planUpload(plan, history.messages, tailText, m.images.length);
  if (restart) plan = { action: 'newpack', uploaded: 0, lastText: '' };
  console.log(dir, 'chat-plan', plan.action, plan.uploaded, history.reachedTop ? 'top' : 'partial', unfinishedPack(tailText) ? 'open' : 'idle');
  if (!restart && plan.action === 'newpack' && !history.reachedTop && !unfinishedPack(tailText)) {
    throw new Error('chat history did not load; not sending images');
  }
  if (plan.action === 'newpack' && unfinishedPack(tailText)) {
    throw new Error(`refusing /newpack while a pack is still open: ${tailText.replace(/\s+/g, ' ').trim().slice(0, 200)}`);
  }
  if (plan.action === 'saved') {
    if (!plan.url) throw new Error('pack already saved but the link was not in the chat');
    tm.packUrl = plan.url;
    // Short saved pack: keep going with /addsticker when pack.json says so.
    // A full save (or unknown short pack without incomplete + uploaded) posts the link.
    if (restart || !needsAddSticker(tm, m.images.length)) {
      await rememberAndPost(p, dir, plan.url, plan.lastText, note);
      return;
    }
    console.log(dir, 'chat-plan', 'addsticker', tm.uploaded, plan.url);
  }

  let lastText = plan.lastText || '';
  const addMore = !restart && needsAddSticker(tm, m.images.length);
  if (addMore) {
    // Saved but short: /addsticker + pack URL, then continue from tm.uploaded.
    // Only when uploaded is the real accepted count (set by a wait that did not race).
    const before = await bot.recentIncoming(1);
    const beforeTail = latestIncomingText(before);
    if (unfinishedPack(beforeTail)) {
      throw new Error(`refusing /addsticker while a pack is still open: ${beforeTail.replace(/\s+/g, ' ').trim().slice(0, 200)}`);
    }
    await note({ phase: 'newpack', pack: m.title, lastLine: beforeTail });
    const opened = await withRetry('addsticker', () => bot.say('/addsticker'));
    const openedText = String(opened.text || '').replace(/\s+/g, ' ').trim();
    console.log(dir, 'addsticker-reply', openedText.slice(0, 400));
    let step = afterAddsticker(opened.text);
    if (step === 'open') {
      throw new Error(`pack dialog already open; not sending /addsticker: ${openedText.slice(0, 200)}`);
    }
    let picture = opened;
    if (step === 'link') {
      const linked = await withRetry('addsticker-link', () => bot.say(tm.packUrl));
      const linkedText = String(linked.text || '').replace(/\s+/g, ' ').trim();
      console.log(dir, 'addsticker-link-reply', linkedText.slice(0, 400));
      picture = linked;
      step = afterAddsticker(linked.text);
    }
    if (!wantsPicture(picture.text) && step !== 'picture') {
      const shown = String(picture.text || '').replace(/\s+/g, ' ').trim();
      throw new Error(`bot has not asked for a picture after /addsticker: ${shown.slice(0, 200)}`);
    }
    tm.created = true;
    tm.status = 'uploading';
    tm.pendingFile = null;
    tm.botReply = String(picture.text || '').slice(0, 300);
    lastText = picture.text || lastText;
    savePack(p);
    log(m.title, '', 'добор в сохранённый набор', tm.packUrl);
  } else if (plan.action !== 'newpack') {
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
      if (reply.kind === 'stall') {
        await bot.recoverChat();
        reply = await bot.say(emojiAnswer('', img.emoji), { onWait, until: 'sticker' });
      }
      if (reply.kind === 'emoji') reply = await bot.say('🙂', { onWait, until: 'sticker' });
      if (reply.kind === 'stall') {
        await bot.recoverChat();
        reply = await bot.say('🙂', { onWait, until: 'sticker' });
      }
      if (reply.kind !== 'ready') throw new Error(`emoji: ${String(reply.text || '').slice(0, 200)}`);
      await note({ phase: 'ready', pack: m.title, index: plan.uploaded + 1, total: m.images.length, lastLine: reply.text });
      tm.uploaded += 1;
      lastText = reply.text;
    }
    savePack(p);
  } else if (mustOpenNewPack(tm)) {
    const before = await bot.recentIncoming(1);
    const beforeTail = latestIncomingText(before);
    if (nextCommand(beforeTail, '/newpack') !== '/newpack') {
      throw new Error(`refusing /newpack while a pack is still open: ${beforeTail.replace(/\s+/g, ' ').trim().slice(0, 200)}`);
    }
    await note({ phase: 'newpack', pack: m.title, lastLine: beforeTail });
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

  const urls = loadTelemostUrls();
  const useStaging = Boolean(urls.stagingEnabled && (bot.stagingUrl || urls.stagingUrl));
  const stagingUrl = bot.stagingUrl || urls.stagingUrl;
  const botUrl = bot.botUrl || urls.botUrl;
  const stagedOwn = new Map();
  let stagingFilled = tm.uploaded;

  async function fillStagingWindow() {
    if (!useStaging) return;
    const need = stagingFillTo(tm.uploaded, stagingFilled, m.images.length, urls.stagingWindow);
    if (!need.length) return;
    await bot.openChat(stagingUrl);
    for (const idx of need) {
      const item = m.images[idx];
      const path = join(PACKS, dir, item.file);
      console.log(dir, 'stage', item.file);
      const ownId = await bot.sendImageNoWait(path);
      stagedOwn.set(idx, ownId);
      stagingFilled = idx + 1;
    }
    await bot.openChat(botUrl);
  }

  async function deliverImage(file, index, onWait) {
    if (!useStaging) return bot.sendImage(file, { onWait });
    await fillStagingWindow();
    let ownId = stagedOwn.get(index);
    if (!ownId) {
      await bot.openChat(stagingUrl);
      ownId = await bot.sendImageNoWait(file);
      stagedOwn.set(index, ownId);
      stagingFilled = Math.max(stagingFilled, index + 1);
    }
    await bot.openChat(botUrl);
    const thread = await bot.chatRows();
    const baseline = (thread || []).filter((row) => row && !row.own).map(({ id, text, links }) => ({ id, text, links }));
    const ownBeforeIds = ownIds(thread);
    await bot.openChat(stagingUrl);
    console.log(dir, 'forward', m.images[index].file);
    await bot.forwardOwnToBot(ownId, botUrl);
    return bot.waitForReply(baseline, { until: 'sticker', ownBeforeIds, onWait });
  }

  for (let i = tm.uploaded; i < m.images.length; i++) {
    const img = m.images[i];
    const file = join(PACKS, dir, img.file);
    if (useStaging) await fillStagingWindow();
    console.log(dir, useStaging ? 'forward-send' : 'send', img.file);
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
    let stalls = 0;
    // One outbound action at a time: image, then optional emoji, then wait for ready.
    let outboundStep = 'image';
    let emojiAnswerText = '';
    tm.pendingFile = img.file;
    savePack(p);
    const recoverFromStall = async (reply, label) => {
      stalls += 1;
      log(m.title, img.file, `${label} ${stalls}`, String(reply.text || '').replace(/\s+/g, ' ').trim().slice(0, 180));
      await note({
        phase: 'waiting',
        pack: m.title,
        index: i + 1,
        total: m.images.length,
        seconds: Math.round(reply.seconds || 0),
        lastLine: waitLastLine(30, reply.text || 'нет ответа, перезагрузка'),
      });
      if (useStaging && outboundStep === 'image') stagedOwn.delete(i);
      await bot.openChat(botUrl);
      await bot.recoverChat();
    };
    while (!accepted) {
      let reply;
      if (outboundStep === 'image') {
        await bot.openChat(botUrl);
        reply = await deliverImage(file, i, onWait);
      } else {
        await bot.openChat(botUrl);
        const text = emojiAnswerText || emojiAnswer('', img.emoji);
        reply = await bot.say(text, { onWait, until: 'sticker' });
      }
      const shown = String(reply.text || '').replace(/\s+/g, ' ').trim();
      console.log(dir, 'bot', outboundStep, reply.kind, shown.slice(0, 180));
      if (reply.kind === 'stall' || afterSendReply(reply.kind) === 'recover') {
        await recoverFromStall(reply, outboundStep === 'image' ? 'зависание, перезагрузка' : 'зависание после эмодзи');
        continue;
      }
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
        if (useStaging && outboundStep === 'image') stagedOwn.delete(i);
        outboundStep = 'image';
        await sleep(1000);
        continue;
      }
      if (outboundStep === 'image' && reply.kind === 'emoji') {
        console.log(dir, 'emoji', img.file);
        await note({ phase: 'emoji', pack: m.title, index: i + 1, total: m.images.length, lastLine: shown });
        emojiAnswerText = emojiAnswer(reply.text, img.emoji);
        outboundStep = 'emoji';
        continue;
      }
      let done = reply;
      if (outboundStep === 'emoji' && reply.kind === 'emoji') {
        await bot.openChat(botUrl);
        done = await bot.say('🙂', { onWait, until: 'sticker' });
        if (done.kind === 'stall') {
          await recoverFromStall(done, 'зависание после эмодзи');
          continue;
        }
        if (done.kind === 'emoji') {
          const baseline = await bot.botRows();
          done = await bot.waitForReply(baseline, { onWait, until: 'sticker' });
        }
        if (done.kind === 'stall') {
          await recoverFromStall(done, 'зависание после эмодзи');
          continue;
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
          if (useStaging) stagedOwn.delete(i);
          outboundStep = 'image';
          await sleep(1000);
          continue;
        }
      }
      // Only a new «Стикер готов» for this send advances. Never race on an old line.
      if (done.kind !== 'ready') continue;
      lastText = done.text;
      await note({ phase: 'ready', pack: m.title, index: i + 1, total: m.images.length, lastLine: lastText });
      accepted = true;
      tm.pendingFile = null;
      stagedOwn.delete(i);
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
  await bot.openChat(botUrl);
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
  console.log(dir, 'pack-link-notified', url);
}

async function resolveSavedPackUrl(bot, text, links, dir) {
  let body = String(text || '');
  let hrefs = [...(links || [])];
  let url = extractPackUrl(body, hrefs);
  if (packSavedReply(body, hrefs).ok) return { text: body, links: hrefs, url };
  // Telemost often paints «сохранён и доступен по ссылке» before the <a> href
  // is in the DOM, and the idle command menu can sit above that bubble.
  for (let attempt = 0; attempt < 25 && SAVED.test(body) && !url; attempt++) {
    await sleep(200);
    const seen = await bot.recentIncoming(8);
    body = [body, seen.text].filter(Boolean).join('\n');
    hrefs = [...hrefs, ...(seen.links || [])];
    url = extractPackUrl(body, hrefs);
    console.log(dir, 'done-link-wait', attempt + 1, url ? 'ok' : 'pending');
  }
  return { text: body, links: hrefs, url };
}

async function cleanupStagingChats(bot, packTitle, dirSlug) {
  const urls = loadTelemostUrls();
  if (!urls.stagingEnabled || !urls.stagingUrl) return;
  const stagingUrl = bot.stagingUrl || urls.stagingUrl;
  const botUrl = bot.botUrl || urls.botUrl;
  try {
    await bot.openChat(stagingUrl);
    const stagingRemoved = await bot.clearChatResidue();
    await bot.openChat(botUrl);
    const botRemoved = await bot.clearChatResidue();
    console.log(dirSlug, 'cleanup', 'staging', stagingRemoved, 'bot', botRemoved);
    log(packTitle, '', 'очистка чатов', `staging ${stagingRemoved}, bot ${botRemoved}`);
  } catch (e) {
    console.log(dirSlug, 'cleanup-failed', e && e.message ? e.message : e);
    log(packTitle, '', 'очистка чатов', e && e.message ? e.message : 'failed');
  }
}

async function publishSavedPack(bot, p, dir, note = async () => {}) {
  const m = p.meta;
  const tm = m.telemost;
  await note({ phase: 'done', pack: m.title, lastLine: tm.botReply || '' });
  let doneText = '';
  let saved = { ok: false, reason: 'not-saved', url: '' };
  // Wait for «сохранён», not the first non-pending line (an older emoji ask
  // can ride along in the changed text and would stop the wait too early).
  for (let attempt = 1; attempt <= 3; attempt++) {
    const done = await bot.say('/done', { until: 'saved' });
    const recovered = await resolveSavedPackUrl(bot, done.text, done.links, dir);
    doneText = String(recovered.text || '').replace(/\s+/g, ' ').trim();
    console.log(dir, 'done-reply', attempt, doneText.slice(0, 400));
    saved = packSavedReply(recovered.text, recovered.links);
    if (saved.ok) break;
    // Still holding the draft: /done may have been ignored. Try again.
    if (finalizeDecision(recovered.text).action === 'done' || READY.test(recovered.text)) {
      console.log(dir, 'done-retry', saved.reason || 'not-saved');
      await sleep(500);
      continue;
    }
    break;
  }
  if (!saved.ok) {
    console.log(dir, 'draft-gone', saved.reason === 'missing-url' ? 'done saved without pack url' : 'done did not save the pack');
    return false;
  }
  tm.status = 'done';
  tm.packUrl = saved.url;
  tm.error = null;
  tm.uploaded = m.images.length;
  tm.pendingFile = null;
  tm.botReply = doneText.slice(0, 300);
  savePack(p);
  console.log(dir, 'pack-url', saved.url);
  await note({ phase: 'saved', pack: m.title, lastLine: doneText });
  await note({ phase: 'link', pack: m.title, lastLine: doneText, link: saved.url });
  console.log(dir, 'pack-link-notified', saved.url);
  await cleanupStagingChats(bot, m.title, dir);
  return true;
}

async function finalizePack(bot, dir, note = async () => {}, dirRef = null) {
  const p = loadPack(dir);
  const m = p.meta;
  if (dirRef) {
    dirRef.title = m.title;
    dirRef.queueRequestId = m.queueRequestId || '';
    dirRef.requesterChatId = m.requesterChatId || '';
  }
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

async function peekRestart(bot) {
  const history = await bot.surveyChat();
  const live = await bot.recentIncoming(4);
  const liveText = String(live.text || '').replace(/[ \t]+/g, ' ').trim().slice(0, 500);
  const liveMessages = liveText.split('\n').map((text) => ({ own: false, text }));
  const title = statusPackName(
    openPackTitle(history.messages) || openPackTitle(liveMessages) || typedPackTitle(history.messages),
  );
  const tailText = latestIncomingText(live);
  const choice = {
    unfinished: unfinishedPack(tailText),
    title,
    liveText,
    lastLine: screenLine(tailText),
  };
  mkdirSync(join(ROOT, 'logs'), { recursive: true });
  writeFileSync(join(ROOT, 'logs', 'restart-choice.json'), JSON.stringify(choice));
  console.log('restart-seen', JSON.stringify({ title: choice.title, lastLine: choice.lastLine, liveText: choice.liveText }));
}

function seenPackError(selected, title) {
  const shown = statusPackName(title) || 'без названия';
  const many = (selected.matches || []).map((name) => statusPackName(name)).filter(Boolean);
  if (many.length > 1) return `на экране «${shown}». несколько папок: ${many.join(', ')}`;
  return `на экране «${shown}»`;
}

async function restartRun(bot, note, dirRef) {
  const choice = JSON.parse(readFileSync(join(ROOT, 'logs', 'restart-choice.json'), 'utf8'));
  const selected = JSON.parse(readFileSync(join(ROOT, 'logs', 'restart-pack.json'), 'utf8'));
  if (!selected || selected.action === 'idle') {
    await note({ phase: 'error', pack: 'очередь', error: 'нет запроса в очереди' });
    return;
  }
  let seenTitle = statusPackName(selected.title || choice.title || '');
  if (dirRef) dirRef.title = seenTitle;
  const live = await bot.recentIncoming(2);
  const tailText = latestIncomingText(live);
  const open = choice.unfinished || unfinishedPack(tailText);
  let closedText = '';
  if (open) {
    const closed = await closeOpenBotPackBeforeNew(bot, note, {
      label: seenTitle || 'перезапуск',
      lastLine: screenLine(tailText) || choice.lastLine || '',
    });
    closedText = String(closed.closedText || '');
    if (closed.title) {
      seenTitle = closed.title;
      if (dirRef) dirRef.title = closed.title;
    }
  }
  if (selected.action === 'close') {
    console.log('restart-closed', JSON.stringify({ title: seenTitle, lastLine: screenLine(closedText) || choice.lastLine || '' }));
    await note({
      phase: 'done',
      pack: seenTitle || 'перезапуск',
      lastLine: screenLine(closedText) || choice.lastLine || '',
    });
    return;
  }
  if (selected.action === 'seen' || !selected.dir) {
    const line = screenLine(choice.liveText || live.text) || choice.lastLine || '';
    console.log('restart-seen', JSON.stringify({ title: seenTitle, lastLine: line, matches: selected.matches || [] }));
    // A clock or empty peek must not become the pack name or a fatal card.
    if (!statusPackName(seenTitle)) {
      await note({
        phase: 'done',
        pack: 'перезапуск',
        lastLine: line,
      });
      return;
    }
    await note({
      phase: 'error',
      pack: seenTitle,
      lastLine: line,
      error: seenPackError(selected, seenTitle),
    });
    return;
  }
  const pack = loadPack(selected.dir);
  if (dirRef) dirRef.title = pack.meta.title;
  await uploadPack(bot, selected.dir, { close: true, restart: true, note, dirRef });
}

// Upload / finalize / close use the pack list from the queue or CLI, not a
// hard-coded folder number.
export function dirsForRun(dirs, { finalize = false, close = false } = {}) {
  void finalize;
  void close;
  return [...dirs];
}

async function main() {
  const argv = process.argv.slice(2);
  const finalize = argv.includes('--finalize');
  const peek = argv.includes('--restart-peek');
  const restart = argv.includes('--restart');
  const drainOnly = argv.includes('--drain-queue-only');
  const drainQueue = queueDrainEnabled(argv);
  const close = argv.includes('--close') || restart;
  const wanted = argv.filter((arg) => !['--finalize', '--close', '--restart', '--restart-peek', '--drain-queue', '--drain-queue-only'].includes(arg));
  let dirs = readdirSync(PACKS).filter(d => /^\d\d-/.test(d)).sort().filter(d => !wanted.length || wanted.includes(d.slice(0, 2)) || wanted.includes(d));
  const skipped = dirs.filter((dir) => !dirsForRun([dir], { finalize, close }).length);
  if (skipped.length) console.log('skip', skipped.join(' '));
  dirs = dirsForRun(dirs, { finalize, close });
  const c = await connect();
  const urls = loadTelemostUrls();
  const bot = new Bot(c, urls);
  if (urls.stagingEnabled) console.log('staging', urls.stagingUrl, 'window', urls.stagingWindow);
  const dirRef = { dir: '', title: '' };
  const note = openAdminFeed(dirRef);
  if (peek) {
    try {
      await peekRestart(bot);
    } catch (e) {
      log('restart', '', 'остановлено', e.message);
      process.exitCode = 1;
    }
    c.close();
    return;
  }
  if (drainOnly) {
    try {
      dirRef.sessionDrain = true;
      await drainRemainingQueue({ bot, note, dirRef, uploadPack });
    } catch (e) {
      log('drain', '', 'остановлено', e.message);
      process.exitCode = 1;
    }
    c.close();
    return;
  }
  if (restart) {
    try {
      if (drainQueue) dirRef.sessionDrain = true;
      await restartRun(bot, note, dirRef);
      if (drainQueue) {
        await drainRemainingQueue({ bot, note, dirRef, uploadPack });
      }
    } catch (e) {
      log('restart', '', 'остановлено', e.message);
      await note({ phase: 'error', pack: dirRef.title || 'перезапуск', error: e.message });
      process.exitCode = 1;
    }
    c.close();
    return;
  }
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
  if (drainQueue) {
    try {
      dirRef.sessionDrain = true;
      await drainRemainingQueue({ bot, note, dirRef, uploadPack });
    } catch (e) {
      log('drain', '', 'остановлено', e.message);
      process.exitCode = 1;
    }
  }
  c.close();
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
