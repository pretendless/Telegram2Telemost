// Status cards for the admin chat. One pack run keeps one message. Every step
// edits it and names the sticker as «стикер N из TOTAL»: send, emoji,
// «Стикер готов», the wait, and a retry. If the edit is rejected, the old
// message is deleted and one replacement is sent. A failed run writes the
// error and the run URL into that same message.
import { readFileSync } from 'fs';
import { join } from 'path';
import { pathToFileURL } from 'url';
import { activeUploadJob, sortQueuedItems } from '../worker/src/logic.js';
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
  const repo = String(source.GITHUB_REPOSITORY || '').trim() || 'pretendless/tg2tm';
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

export function adminJobText(job) {
  if (!job || !job.running) return 'простаивает';
  const index = num(job.index);
  const total = num(job.total);
  const sticker = stickerMark(index, total);
  if (job.pack && sticker) return `идёт | «${oneLine(job.pack)}» | ${sticker}`;
  if (job.pack) return `идёт | «${oneLine(job.pack)}»`;
  return 'идёт';
}

function sessionCoversItem(session, item) {
  if (!session) return false;
  if (!session.at || !item || !item.createdAt) return Boolean(session.url);
  return String(session.at) >= String(item.createdAt);
}

function startingActionsText(title, session) {
  const name = oneLine(title) || '…';
  const head = `запуск Actions, пак «${name}», стикеры ещё не пошли`;
  const url = session && /^https?:\/\//i.test(String(session.url || '').trim()) ? String(session.url).trim() : '';
  return url ? `${head}\n${url}` : head;
}

// Admin /status: name the step. Bare «простаивает» only when nothing is queued or uploading.
export function adminLiveStatusText({ queue, job, session } = {}) {
  if (job && job.running) {
    const index = num(job.index);
    const total = num(job.total);
    if (job.pack && index != null && total != null) return adminJobText(job);
    return startingActionsText(job.pack, session);
  }
  const next = sortQueuedItems((queue && queue.items) || [])[0];
  if (!next) return 'простаивает';
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

export function createAdminFeed({ io, requester, writeState, onDelivered, now, env = process.env } = {}) {
  let cursor = null;
  return async function notify(event) {
    const carried = withSticker(event, cursor);
    const liveRequester = typeof requester === 'function' ? requester() : requester;
    let full = { ...carried, requester: carried.requester || liveRequester || '' };
    if ((full.phase === 'error' || full.phase === 'failed') && !oneLine(full.runUrl)) {
      const runUrl = actionsRunUrl(env);
      if (runUrl) full = { ...full, runUrl };
    }
    let delivery = { action: 'record', event: full };
    if (io) {
      try {
        delivery = await deliverAdminStatus(io, ADMIN_CHAT_ID, cursor, full, now ? now() : new Date());
        if (delivery.action !== 'skip') cursor = delivery;
        if (writeState) writeState(cursor || delivery);
      } catch {
        console.log('admin status skipped');
      }
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
    body: JSON.stringify({ ...body, adminDelivered: true }),
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

export async function reportRestartNoUpload({
  fetchImpl = globalThis.fetch,
  token = process.env.TG2TMBOT_TOKEN || '',
  statePath = process.env.ADMIN_STATE_PATH || 'logs/admin-last.json',
  logsDir = process.env.RESTART_LOG_DIR || 'logs',
  requester = process.env.TELEGRAM_CHAT_ID || '',
  runUrl = process.env.RUN_URL || '',
  reason = process.env.RESTART_REASON || '',
} = {}) {
  if (!token) {
    console.log('admin status skipped');
    return;
  }
  const packMeta = readRestartPack(logsDir);
  const copy = restartNoUploadCopy({
    reason: reason || packMeta.reason || 'empty-queue',
    lastLine: packMeta.lastLine || '',
    title: packMeta.title || titleFromRestartLogs(logsDir),
  });
  const io = telegramIo(fetchImpl, token);
  const stored = readState(statePath);
  const prev = stored && stored.messageId ? { messageId: stored.messageId, event: stored.event } : null;
  try {
    await deliverAdminStatus(io, ADMIN_CHAT_ID, prev, {
      phase: 'error',
      pack: copy.pack,
      lastLine: copy.lastLine,
      error: copy.error,
      next: copy.next,
      runUrl,
      requester,
      at: formatClock(),
    });
  } catch {
    console.log('admin status skipped');
  }
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
} = {}) {
  if (!token) {
    console.log('admin status skipped');
    return;
  }
  const stored = readState(statePath);
  const event = (stored && stored.event) || {};
  const already = event.phase === 'error' || event.phase === 'failed';
  const urlLanded = Boolean(runUrl) && oneLine(event.runUrl) === oneLine(runUrl);
  if (already && (!runUrl || urlLanded || !(stored && stored.messageId))) {
    console.log('admin status already sent');
    return;
  }
  const step = LABEL[event.phase] || event.phase || '';
  const io = telegramIo(fetchImpl, token);
  const prev = stored && stored.messageId ? { messageId: stored.messageId, event } : null;
  try {
    await deliverAdminStatus(io, ADMIN_CHAT_ID, prev, {
      phase: 'failed',
      pack: failurePackName({ pack: event.pack, packs, mode, title: titleFromRestartLogs(logsDir) }),
      index: event.index,
      total: event.total,
      lastLine: event.lastLine || '',
      error: event.error || 'Actions завершились с ошибкой',
      step,
      runUrl,
      requester,
      at: formatClock(),
    });
  } catch {
    console.log('admin status skipped');
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.includes('--run-failed')) await reportRunFailed();
  if (process.argv.includes('--restart-no-upload')) await reportRestartNoUpload();
}
