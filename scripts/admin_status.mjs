// Status cards for the admin chat. One pack run keeps one message. Every step
// edits it and names the sticker as «стикер N из TOTAL»: send, emoji,
// «Стикер готов», the wait, and a retry. If the edit is rejected, the old
// message is deleted and one replacement is sent. A failed run writes the
// error and the run URL into that same message.
import { readFileSync } from 'fs';
import { join } from 'path';
import { pathToFileURL } from 'url';
import { activeUploadJob, sortQueuedItems } from '../worker/src/logic.js';
import { readStepFailure } from '../vm/step_failure.mjs';
import { isStepTimeout } from './step_timeout.mjs';

export const ADMIN_CHAT_ID = '8502935020';

const PHASES = new Set(['start', 'newpack', 'buffering', 'sending', 'waiting', 'retry', 'emoji', 'ready', 'done', 'saved', 'link', 'error', 'failed']);

const LABEL = {
  start: 'старт',
  newpack: '/newpack',
  buffering: 'буфферизация',
  sending: 'отправка',
  waiting: 'жду бота',
  retry: 'повтор',
  emoji: 'эмодзи',
  ready: 'Стикер готов',
  done: '/done',
  saved: 'сохранён',
  link: 'ссылка',
  error: 'ошибка',
  failed: 'сбой Actions',
};

function num(value) {
  if (value == null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function oneLine(value) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, 300);
}

export function formatClock(now = new Date()) {
  return now.toISOString().slice(11, 16);
}

// github.server_url/owner/repo/actions/runs/id. RUN_URL wins. A bare GITHUB_RUN_ID
// still builds a link (this repo, github.com) so a pasted admin error can be opened.
export function actionsRunUrl(env = process.env) {
  const source = env || {};
  const existing = String(source.RUN_URL || source.GITHUB_RUN_URL || '').trim();
  if (/^https?:\/\//i.test(existing)) return existing;
  const id = String(source.GITHUB_RUN_ID || source.RUN_ID || '').trim();
  if (!/^[0-9]+$/.test(id)) return '';
  const server = String(source.GITHUB_SERVER_URL || 'https://github.com').replace(/\/+$/, '');
  const repo = String(source.GITHUB_REPOSITORY || '').trim() || 'pretendless/Telegram2Telemost';
  return `${server}/${repo}/actions/runs/${id}`;
}

export function adminChatIds(raw) {
  const ids = String(raw || ADMIN_CHAT_ID)
    .split(/[\s,]+/)
    .filter((id) => /^[0-9]{1,16}$/.test(id));
  return ids.length ? ids : [ADMIN_CHAT_ID];
}

// Menu scopes and command checks: every numeric id from each source, in order.
// An env list that still names only the original admin does not drop ids from wrangler.
export function adminMenuChatIds(...sources) {
  const joined = sources.map((value) => String(value ?? "").trim()).filter(Boolean).join(",");
  const seen = new Set();
  const unique = [];
  for (const id of adminChatIds(joined)) {
    if (seen.has(id)) continue;
    seen.add(id);
    unique.push(id);
  }
  return unique;
}

export function isAdminChat(chatId, raw) {
  return adminChatIds(raw).includes(String(chatId));
}

// Background notices: every id in LOGIN_CHAT_IDS, or the single dispatch chat
// when that list is empty. An empty list must not invent a second recipient.
export function adminNoticeChatIds(primary, raw) {
  const listed = String(raw ?? '').trim();
  if (listed) return adminChatIds(listed);
  const one = String(primary || '').trim();
  if (/^[0-9]{1,16}$/.test(one)) return [one];
  return [ADMIN_CHAT_ID];
}

function stickerMark(index, total) {
  const n = num(index);
  const all = num(total);
  if (n == null || all == null) return '';
  return `стикер ${n} из ${all}`;
}

export function formatAdminStatus(event, now = new Date()) {
  const phase = PHASES.has(event && event.phase) ? event.phase : 'error';
  let step = LABEL[phase];
  if (phase === 'waiting') step = `жду бота ${num(event.seconds) || 0} с`;
  if (phase === 'retry') step = `повтор ${num(event.attempt) || 0}`;
  if (phase === 'failed' && event.step) step = `сбой Actions | ${oneLine(event.step)}`;
  const head = [event.at || formatClock(now), `«${oneLine(event.pack) || 'пак'}»`];
  const sticker = stickerMark(event.index, event.total);
  if (sticker) head.push(sticker);
  head.push(step);
  const lines = [head.join(' | ')];
  const lastLine = oneLine(event.lastLine);
  if (lastLine) lines.push('бот: ' + lastLine);
  const error = oneLine(event.error);
  if (error) lines.push('ошибка: ' + error);
  const link = oneLine(event.link);
  if (link) lines.push(link);
  const runUrl = oneLine(event.runUrl);
  if (runUrl) lines.push(runUrl);
  const next = oneLine(event.next);
  if (next) lines.push('дальше: ' + next);
  const requester = String(event.requester || '');
  if (requester && requester !== ADMIN_CHAT_ID) lines.push('запрос: ' + requester);
  return lines.join('\n');
}

function cardKey(event) {
  return [
    event.phase || '',
    event.pack || '',
    num(event.index),
    num(event.total),
    num(event.seconds),
    num(event.attempt),
    oneLine(event.lastLine),
    oneLine(event.error),
    oneLine(event.link),
    oneLine(event.runUrl),
    oneLine(event.next),
    oneLine(event.step),
    String(event.requester || ''),
  ].join('\0');
}

// One pack keeps one card. Send, emoji, «Стикер готов», a wait, a retry,
// an error, and the saved link all edit that card. A different pack starts a new one.
export function adminDelivery(prev, next) {
  if (!prev) return { action: 'send' };
  if ((prev.pack || '') !== (next.pack || '')) return { action: 'send' };
  if (cardKey(prev) === cardKey(next)) return { action: 'skip' };
  return { action: 'edit' };
}

const LINE_FREE = 'линия свободна';
const LINE_BUSY = 'линия в процессе';

export function adminJobText(job) {
  if (!job || !job.running) return LINE_FREE;
  const index = num(job.index);
  const total = num(job.total);
  const sticker = stickerMark(index, total);
  if (job.pack && sticker) return `${LINE_BUSY} | «${oneLine(job.pack)}» | ${sticker}`;
  if (job.pack) return `${LINE_BUSY} | «${oneLine(job.pack)}»`;
  return LINE_BUSY;
}

function sessionCoversItem(session, item) {
  if (!session) return false;
  if (!session.at || !item || !item.createdAt) return Boolean(session.url);
  return String(session.at) >= String(item.createdAt);
}

function startingActionsText(title, session) {
  const name = oneLine(title) || '…';
  const head = `${LINE_BUSY}: запуск Actions, пак «${name}», стикеры ещё не пошли`;
  const url = session && /^https?:\/\//i.test(String(session.url || '').trim()) ? String(session.url).trim() : '';
  return url ? `${head}\n${url}` : head;
}

function sessionUrl(session) {
  const url = session && String(session.url || '').trim();
  return /^https?:\/\//i.test(url) ? url : '';
}

// Admin /status. «линия свободна» only with an empty queue and no live session.
// A running upload, an Actions start, or any other live session is «линия в процессе».
export function adminLiveStatusText({ queue, job, session } = {}) {
  if (job && job.running) {
    const index = num(job.index);
    const total = num(job.total);
    if (job.pack && index != null && total != null) return adminJobText(job);
    return startingActionsText(job.pack, session);
  }
  const next = sortQueuedItems((queue && queue.items) || [])[0];
  if (!next) {
    const url = sessionUrl(session);
    return url ? `${LINE_BUSY}\n${url}` : LINE_FREE;
  }
  if (sessionCoversItem(session, next)) return startingActionsText(next.title, session);
  const stickers = Number(next.stickers);
  const count = Number.isFinite(stickers) && stickers > 0 ? `, ${stickers} стикеров` : '';
  return `в очереди | «${oneLine(next.title)}»${count}`;
}

/** Queue uploading row + its pack: progress only (ignores orphan catalog keys in KV). */
export function currentAdminJob(queue, packProgress) {
  return activeUploadJob(queue, packProgress);
}

export function eventFromProgress(pack, prev) {
  const base = {
    pack: pack.title,
    index: pack.uploaded,
    total: pack.total,
    lastLine: pack.lastLine || '',
    error: pack.error || '',
    link: pack.url || '',
    requester: pack.requester || '',
    runUrl: pack.runUrl || '',
    seconds: pack.seconds,
    attempt: pack.attempt,
    at: pack.at || '',
    step: pack.step || '',
    next: pack.next || '',
  };
  if (pack.phase && PHASES.has(pack.phase)) return { ...base, phase: pack.phase };
  if (pack.status === 'error') return { ...base, phase: 'error' };
  if (pack.status === 'done' && pack.url) return { ...base, phase: 'link' };
  if (!prev) return { ...base, phase: 'start' };
  if (pack.status === 'done') return { ...base, phase: 'saved' };
  return { ...base, phase: 'sending' };
}

function messageIdOf(result) {
  if (result && typeof result === 'object' && result.message_id) return result.message_id;
  if (typeof result === 'number') return result;
  return null;
}

export async function deliverAdminStatus(io, chatId, prev, event, now) {
  const decision = adminDelivery(prev && prev.event, event);
  const text = formatAdminStatus(event, now);
  if (decision.action === 'skip') {
    return { action: 'skip', messageId: prev && prev.messageId, event: prev.event, text: prev && prev.text };
  }
  if (decision.action === 'edit' && prev && prev.messageId) {
    try {
      await io.edit(chatId, prev.messageId, text);
      return { action: 'edit', messageId: prev.messageId, event, text };
    } catch {
      try {
        await io.delete(chatId, prev.messageId);
      } catch {
        // The old card can stay if Telegram already dropped it. The replacement still goes out.
      }
      const messageId = messageIdOf(await io.send(chatId, text));
      return { action: 'replace', messageId, event, text };
    }
  }
  const messageId = messageIdOf(await io.send(chatId, text));
  return { action: 'send', messageId, event, text };
}

// A legacy admin-last.json has one messageId. That id belongs to the first
// admin only. Reusing it for every chat makes later edits hit one conversation.
export function loadAdminCursors(stored, ids) {
  const list = ids && ids.length ? ids.map(String) : [ADMIN_CHAT_ID];
  const map = {};
  const byChat = stored && stored.byChat;
  if (byChat && typeof byChat === 'object' && !Array.isArray(byChat)) {
    for (const [id, cursor] of Object.entries(byChat)) {
      if (/^[0-9]{1,16}$/.test(id) && cursor && typeof cursor === 'object') map[id] = cursor;
    }
  }
  const legacyId = list[0];
  if (stored && stored.messageId && legacyId && !map[legacyId]) {
    map[legacyId] = { messageId: stored.messageId, event: stored.event || null, text: stored.text };
  }
  return map;
}

export function serializeAdminCursors(byChat) {
  const ids = Object.keys(byChat || {});
  const first = ids.length ? byChat[ids[0]] : null;
  return {
    byChat: byChat || {},
    messageId: first && first.messageId ? first.messageId : undefined,
    event: first && first.event ? first.event : undefined,
    text: first && first.text ? first.text : undefined,
  };
}

export async function deliverAdminFeed(io, chatIds, prevByChat, event, now) {
  const ids = chatIds && chatIds.length ? chatIds.map(String) : [ADMIN_CHAT_ID];
  const byChat = { ...(prevByChat || {}) };
  const clock = now || new Date();
  let notified = 0;
  for (const chatId of ids) {
    try {
      const delivered = await deliverAdminStatus(io, chatId, byChat[chatId] || null, event, clock);
      byChat[chatId] = {
        messageId: delivered.messageId,
        event: delivered.event,
        text: delivered.text,
      };
      if (delivered.action !== 'skip') notified += 1;
    } catch {
      console.log('admin status skipped', chatId);
    }
  }
  const first = byChat[ids[0]] || null;
  return {
    action: notified ? 'fanout' : 'skip',
    byChat,
    notified,
    messageId: first && first.messageId,
    event: (first && first.event) || event,
    text: first && first.text,
  };
}

function withSticker(event, previous) {
  const prev = previous && previous.event;
  const phase = event && event.phase;
  // A new pack must not inherit the previous pack's last sticker count.
  const fresh = phase === 'start' || phase === 'newpack';
  const samePack = !fresh && Boolean(prev) && (prev.pack || '') === ((event && event.pack) || '');
  const explicit = num(event && event.index);
  const index = fresh ? (explicit != null ? explicit : 0) : (explicit != null ? explicit : (samePack ? prev.index : event && event.index));
  const total = num(event && event.total) != null ? event.total : (samePack ? prev.total : event && event.total);
  return { ...event, index, total };
}

function chatIdOk(value) {
  return /^[0-9]{1,16}$/.test(String(value || '').trim());
}

export function clearPackProgress(dirRef) {
  if (!dirRef || typeof dirRef !== 'object') return;
  dirRef.queueRequestId = '';
  dirRef.requesterChatId = '';
}

// The live claim wins when pack.json still names another request. A pack with
// no requester metadata clears the previous chat so it cannot leak forward.
// TELEGRAM_CHAT_ID is never a requester.
export function bindPackProgress(dirRef, meta) {
  if (!dirRef || typeof dirRef !== 'object') return { queueRequestId: '', requesterChatId: '' };
  const fileId = meta && meta.queueRequestId ? String(meta.queueRequestId).trim() : '';
  const fileChat = meta && meta.requesterChatId ? String(meta.requesterChatId).trim() : '';
  const liveId = dirRef.queueRequestId ? String(dirRef.queueRequestId).trim() : '';
  const liveChat = dirRef.requesterChatId ? String(dirRef.requesterChatId).trim() : '';
  const fileOk = Boolean(fileId) && chatIdOk(fileChat);
  const liveOk = Boolean(liveId) && chatIdOk(liveChat);
  let chosen = { queueRequestId: '', requesterChatId: '' };
  if (liveOk && fileOk && liveId !== fileId) chosen = { queueRequestId: liveId, requesterChatId: liveChat };
  else if (fileOk) chosen = { queueRequestId: fileId, requesterChatId: fileChat };
  dirRef.queueRequestId = chosen.queueRequestId;
  dirRef.requesterChatId = chosen.requesterChatId;
  return chosen;
}

export function progressFieldsForPack(dirRef) {
  const queueRequestId = dirRef && dirRef.queueRequestId ? String(dirRef.queueRequestId).trim() : '';
  const requesterChatId = dirRef && dirRef.requesterChatId ? String(dirRef.requesterChatId).trim() : '';
  if (!queueRequestId || !chatIdOk(requesterChatId)) {
    return { requester: null, requesterChatId: null, queueRequestId: null };
  }
  return { requester: requesterChatId, requesterChatId, queueRequestId };
}

export function createAdminFeed({ io, requester, writeState, onDelivered, now, env = process.env, adminIds } = {}) {
  const ids = adminNoticeChatIds('', adminIds != null ? adminIds : (env && env.LOGIN_CHAT_IDS) || '');
  let cursors = {};
  return async function notify(event) {
    const carried = withSticker(event, cursorFor(cursors, ids));
    const liveRequester = typeof requester === 'function' ? requester() : requester;
    let full = { ...carried, requester: carried.requester || liveRequester || '' };
    if ((full.phase === 'error' || full.phase === 'failed') && !oneLine(full.runUrl)) {
      const runUrl = actionsRunUrl(env);
      if (runUrl) full = { ...full, runUrl };
    }
    let delivery = { action: 'record', event: full, byChat: cursors };
    if (io) {
      delivery = await deliverAdminFeed(io, ids, cursors, full, now ? now() : new Date());
      cursors = delivery.byChat || cursors;
      if (writeState) writeState(serializeAdminCursors(cursors));
    } else if (writeState) {
      writeState(delivery);
    }
    if (onDelivered) {
      try {
        await onDelivered(full, delivery);
      } catch (err) {
        if (isStepTimeout(err)) throw err;
        console.log('progress skipped');
      }
    }
  };
}

function cursorFor(cursors, ids) {
  for (const id of ids) {
    if (cursors[id] && cursors[id].event) return cursors[id];
  }
  const any = Object.values(cursors).find((cursor) => cursor && cursor.event);
  return any || null;
}

export function telegramIo(fetchImpl, token) {
  const call = async (method, params) => {
    const response = await fetchImpl('https://api.telegram.org/bot' + token + '/' + method, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...params, disable_notification: method === 'sendMessage' ? true : undefined }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data.ok) throw new Error('admin status http ' + response.status);
    return data.result;
  };
  return {
    send: async (chatId, text) => call('sendMessage', { chat_id: chatId, text }),
    edit: async (chatId, messageId, text) => call('editMessageText', { chat_id: chatId, message_id: messageId, text }),
    delete: async (chatId, messageId) => call('deleteMessage', { chat_id: chatId, message_id: messageId }),
  };
}

export async function postProgress(fetchImpl, url, secret, body, opts = {}) {
  if (!url || !secret || !fetchImpl) return;
  const response = await fetchImpl(url, {
    method: 'POST',
    headers: {
      authorization: 'Bearer ' + secret,
      'content-type': 'application/json',
      'user-agent': 'tg2tm-upload',
    },
    body: JSON.stringify({ ...body, adminDelivered: Boolean(body && body.adminDelivered) }),
    signal: opts && opts.signal,
  });
  if (!response.ok) throw new Error('progress http ' + response.status);
}

function readState(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

function readPackTitle(path) {
  try {
    const data = JSON.parse(readFileSync(path, 'utf8'));
    return oneLine(data && data.title);
  } catch {
    return '';
  }
}

function notClockName(value) {
  const named = oneLine(value);
  return /^\d{1,2}:\d{2}$/.test(named) ? '' : named;
}

// A restart has no pack number. Use the title the run already found, or
// «перезапуск» so the failure card does not say «пак». A Telemost clock
// stamp such as 11:57 is not a pack title.
export function failurePackName({ pack = '', packs = '', mode = '', title = '' } = {}) {
  const named = notClockName(pack) || notClockName(title);
  if (named) return named;
  if (mode === 'restart' || mode === 'restart-peek') return 'перезапуск';
  return notClockName(packs);
}

function titleFromRestartLogs(dir) {
  return readPackTitle(join(dir, 'restart-pack.json')) || readPackTitle(join(dir, 'restart-choice.json'));
}

function readRestartPack(dir) {
  try {
    return JSON.parse(readFileSync(join(dir, 'restart-pack.json'), 'utf8'));
  } catch {
    return {};
  }
}

// Prepare stopped without an upload (usually action=idle). Say why, and what
// to do next, so /restart is never a silent green Actions run.
export function restartNoUploadCopy({ reason = '', lastLine = '', title = '' } = {}) {
  const pack = failurePackName({ mode: 'restart', title });
  if (reason === 'no-uploader-secret' || reason === 'no-progress-url') {
    return {
      pack,
      lastLine,
      error: 'очередь недоступна: нет UPLOADER_SECRET или TG2TM_PROGRESS_URL',
      next: 'проверьте секреты Actions и повторите /restart',
    };
  }
  return {
    pack,
    lastLine,
    error: 'нечего загружать: диалог свободен, очередь пуста',
    next: 'пришлите пак боту, затем /restart',
  };
}

function progressSlug(stored, runId, prefix) {
  const slug = stored && typeof stored.slug === 'string' ? stored.slug.trim() : '';
  if (/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(slug)) return slug;
  const id = String(runId || '').replace(/[^0-9]/g, '');
  const built = `${prefix}-${id || 'notice'}`.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 48);
  return /^[A-Za-z0-9]/.test(built) ? built : 'run-notice';
}

function countOrZero(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.floor(n);
}

async function tryPostAdminProgress(fetchImpl, body, env = process.env) {
  const url = (env && env.TG2TM_PROGRESS_URL) || '';
  const secret = (env && env.UPLOADER_SECRET) || '';
  if (!url || !secret || !fetchImpl || !body) return false;
  try {
    await postProgress(fetchImpl, url, secret, { ...body, adminDelivered: false });
    return true;
  } catch (err) {
    console.log('admin progress post failed', err && err.message ? err.message : err);
    return false;
  }
}

function failureSettled(event, cursor, runUrl) {
  const already = event && (event.phase === 'error' || event.phase === 'failed');
  if (!already) return false;
  const urlLanded = Boolean(runUrl) && oneLine(event.runUrl) === oneLine(runUrl);
  if (runUrl && !urlLanded && cursor && cursor.messageId) return false;
  return true;
}

// Legacy state without byChat describes only the original admin card.
function pendingFailureChats(stored, ids, runUrl) {
  const cursors = loadAdminCursors(stored, ids);
  const legacyEvent = (stored && stored.event) || {};
  const hasByChat = Boolean(stored && stored.byChat && typeof stored.byChat === 'object' && !Array.isArray(stored.byChat));
  const pending = ids.filter((id, index) => {
    const cursor = cursors[id];
    const event = (cursor && cursor.event) || (!hasByChat && index === 0 ? legacyEvent : null);
    if (!event || !event.phase) return true;
    return !failureSettled(event, cursor, runUrl);
  });
  return { cursors, pending };
}

export async function reportRestartNoUpload({
  fetchImpl = globalThis.fetch,
  token = process.env.TG2TMBOT_TOKEN || '',
  statePath = process.env.ADMIN_STATE_PATH || 'logs/admin-last.json',
  logsDir = process.env.RESTART_LOG_DIR || 'logs',
  requester = process.env.TELEGRAM_CHAT_ID || '',
  runUrl = process.env.RUN_URL || '',
  reason = process.env.RESTART_REASON || '',
  runId = process.env.GITHUB_RUN_ID || '',
  adminIds = process.env.LOGIN_CHAT_IDS || '',
  env = process.env,
} = {}) {
  const packMeta = readRestartPack(logsDir);
  const copy = restartNoUploadCopy({
    reason: reason || packMeta.reason || 'empty-queue',
    lastLine: packMeta.lastLine || '',
    title: packMeta.title || titleFromRestartLogs(logsDir),
  });
  const stored = readState(statePath);
  const ids = adminNoticeChatIds('', adminIds);
  const posted = await tryPostAdminProgress(fetchImpl, {
    slug: progressSlug(stored, runId, 'restart'),
    title: copy.pack || 'перезапуск',
    status: 'error',
    uploaded: 0,
    total: 0,
    error: copy.error,
    lastLine: copy.lastLine,
    next: copy.next,
    runUrl,
    phase: 'error',
    requester,
  }, env);
  if (posted) return;
  if (!token) {
    console.log('admin status skipped');
    return;
  }
  const io = telegramIo(fetchImpl, token);
  const cursors = loadAdminCursors(stored, ids);
  await deliverAdminFeed(io, ids, cursors, {
    phase: 'error',
    pack: copy.pack,
    lastLine: copy.lastLine,
    error: copy.error,
    next: copy.next,
    runUrl,
    requester,
    at: formatClock(),
  });
}

export async function reportRunFailed({
  fetchImpl = globalThis.fetch,
  token = process.env.TG2TMBOT_TOKEN || '',
  statePath = process.env.ADMIN_STATE_PATH || 'logs/admin-last.json',
  packs = process.env.PACKS || '',
  mode = process.env.MODE || '',
  logsDir = process.env.RESTART_LOG_DIR || 'logs',
  requester = process.env.TELEGRAM_CHAT_ID || '',
  runUrl = process.env.RUN_URL || '',
  runId = process.env.GITHUB_RUN_ID || '',
  adminIds = process.env.LOGIN_CHAT_IDS || '',
  env = process.env,
} = {}) {
  const stored = readState(statePath);
  const event = (stored && stored.event) || {};
  const ids = adminNoticeChatIds('', adminIds);
  const noted = readStepFailure(logsDir, runId);
  const step = noted.step || LABEL[event.phase] || event.phase || '';
  const pack = failurePackName({ pack: event.pack, packs, mode, title: titleFromRestartLogs(logsDir) });
  const error = event.error || noted.error || 'Actions завершились с ошибкой';
  const posted = await tryPostAdminProgress(fetchImpl, {
    slug: progressSlug(stored, runId, 'run'),
    title: pack || 'пак',
    status: 'error',
    uploaded: countOrZero(event.index),
    total: countOrZero(event.total),
    error,
    lastLine: event.lastLine || '',
    runUrl,
    phase: 'failed',
    step,
    requester,
  }, env);
  if (posted) return;
  if (!token) {
    console.log('admin status skipped');
    return;
  }
  const { cursors, pending } = pendingFailureChats(stored, ids, runUrl);
  if (!pending.length) {
    console.log('admin status already sent');
    return;
  }
  const io = telegramIo(fetchImpl, token);
  await deliverAdminFeed(io, pending, cursors, {
    phase: 'failed',
    pack,
    index: event.index,
    total: event.total,
    lastLine: event.lastLine || '',
    error,
    step,
    runUrl,
    requester,
    at: formatClock(),
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.includes('--run-failed')) await reportRunFailed();
  if (process.argv.includes('--restart-no-upload')) await reportRestartNoUpload();
}
