// @tg2tmbot on Cloudflare Workers: Telegram webhook plus the uploader progress endpoint.
import {
  ADMIN_CHAT_ID,
  adminChatIds,
  adminLiveStatusText,
  deliverAdminStatus,
  eventFromProgress,
  isAdminChat,
} from "../../scripts/admin_status.mjs";
import { handleRestart, handleVmCommand } from "../../vm/worker_login.js";
import { startPipelineIfIdle, startReplacementSession, telemostRunActive } from "../../vm/queue_runner.js";
import { finalizeSessionOnce } from "../../vm/session_end.js";
import { QUEUE_REASON, queuePipelineReason } from "../../vm/dispatch_reason.js";
import { LIVE_SESSION_KEY, defaultSessionReason, notifySessionStartOnce, readLiveSession } from "../../vm/session_notify.js";
import {
  CHANNEL_CHAT,
  INITIAL_SUBSCRIBER,
  MAX_STICKERS,
  NOT_A_PACK,
  adminQueueOverviewText,
  attachQueueNotifyMessage,
  commandOf,
  duplicateRequestReply,
  deliverUserRequestCard,
  formatUserRequestCard,
  findUploadingReleaseId,
  normalizeProgress,
  notificationSteps,
  QUEUE_KEY,
  acceptReply,
  aheadCount,
  awaitCreateKey,
  channelPack,
  claimNext,
  CREATE_PROMPT,
  CREATE_DONE_EMPTY,
  STOP_CLEARED,
  STOP_IDLE,
  createLinksPrompt,
  decodeAwaitCreate,
  encodeAwaitCreate,
  enqueueRequest,
  judgeCreateLinks,
  nameStepResult,
  NEED_CREATE,
  parseStickerSetNames,
  stickerSetName,
  STICKER_NOT_IN_PACK,
  addedSetsReply,
  collectSets,
  focusRequest,
  isPriorityChat,
  normalizeQueue,
  parsePackMessage,
  queueItemSlug,
  matchedProgressRequester,
  queueStatusText,
  stripGithubPointers,
  RETIRED_COMMAND,
  skipAllowedWhileActions,
  skipReply,
  skipUploadingQueue,
  releaseRequest,
  renderPackCheck,
  shouldSchedulePipelineAfterProgress,
  staticReply,
  telegramParseMode,
  terminalProgress,
  userRequestEvent,
  queueHasQueuedWork,
} from "./logic.js";
import { loadAdminQueueState, reconcileTerminalUploadingFromProgress } from "./queue_view.js";
import { applyProjectReply, handleProjectCommand, readProjectPrompt } from "./project_prompt.js";
import { handleGhrunCommand } from "./ghrun.js";
import { normalizeProjectReplyBody } from "../../vm/project_prompt.js";

export function botToken(env) {
  return env.TG2TMBOT_TOKEN || env.TELEGRAM_BOT_TOKEN || "";
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function timingSafeEqual(a, b) {
  const left = String(a);
  const right = String(b);
  const length = Math.max(left.length, right.length);
  let mismatch = left.length === right.length ? 0 : 1;
  for (let i = 0; i < length; i++) mismatch |= (left.charCodeAt(i) || 0) ^ (right.charCodeAt(i) || 0);
  return mismatch === 0;
}

function bearer(request) {
  const header = request.headers.get("authorization") || "";
  const match = header.match(/^Bearer\s+(\S+)\s*$/i);
  return match ? match[1] : "";
}

async function telegram(env, method, params) {
  const token = botToken(env);
  if (!token) throw new Error("no bot token");
  const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(params),
  });
  let body;
  try {
    body = await res.json();
  } catch {
    throw new Error(`telegram ${method} http ${res.status}`);
  }
  if (!body.ok) throw new Error(body.description || `telegram ${method}`);
  return body.result;
}

function outgoingText(text) {
  const value = String(text ?? "");
  const parseMode = telegramParseMode(value);
  if (parseMode) return { text: value, parse_mode: parseMode };
  return { text: value };
}

async function defaultSend(env, chatId, text) {
  const body = outgoingText(text);
  const payload = {
    chat_id: chatId,
    text: body.text,
    link_preview_options: { is_disabled: true },
  };
  if (body.parse_mode) payload.parse_mode = body.parse_mode;
  return telegram(env, "sendMessage", payload);
}

function adminIo(env, deps) {
  const send = deps.sendMessage || defaultSend;
  const edit = deps.editMessage || ((target, chatId, messageId, text) => telegram(target, "editMessageText", {
    chat_id: chatId,
    message_id: messageId,
    text,
  }));
  const remove = deps.deleteMessage || ((target, chatId, messageId) => telegram(target, "deleteMessage", {
    chat_id: chatId,
    message_id: messageId,
  }));
  return {
    send: (chatId, text) => send(env, chatId, text),
    edit: (chatId, messageId, text) => edit(env, chatId, messageId, text),
    delete: (chatId, messageId) => remove(env, chatId, messageId),
  };
}

async function defaultStickerCount(env, name) {
  const set = await telegram(env, "getStickerSet", { name });
  return (set.stickers || []).length;
}

async function ensureSeed(kv) {
  if (await kv.get("meta:seeded")) return;
  await kv.put(`sub:${INITIAL_SUBSCRIBER}`, "1");
  await kv.put("meta:seeded", "1");
}

function parseStored(raw) {
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

// Same slug is the key. A repeat with the same status and uploaded count is not a new write.
// A new link or error still counts: those are what the done notice waits for.
function sameVisibleProgress(prev, pack) {
  if (!prev) return false;
  return (
    prev.status === pack.status &&
    prev.uploaded === pack.uploaded &&
    prev.total === pack.total &&
    prev.title === pack.title &&
    prev.url === pack.url &&
    (prev.error || null) === (pack.error || null)
  );
}

async function readPackProgress(kv, item) {
  if (!item) return null;
  const raw = await kv.get(`pack:${queueItemSlug(item)}`);
  return parseStored(raw);
}

function adminCursors(prev, primaryId) {
  const map = {};
  const stored = prev && prev.adminByChat;
  if (stored && typeof stored === "object" && !Array.isArray(stored)) {
    for (const [id, cursor] of Object.entries(stored)) {
      if (/^[0-9]{1,16}$/.test(id) && cursor && typeof cursor === "object") map[id] = cursor;
    }
  }
  if (prev && prev.admin && typeof prev.admin === "object" && primaryId && !Object.keys(map).length) {
    map[String(primaryId)] = prev.admin;
  }
  return map;
}

// Every admin chat gets every pack. adminDelivered means the uploader already
// wrote the card to ADMIN_CHAT_ID; the other admin chats still need a copy.
async function deliverAdminProgress(env, pack, prev, deps) {
  const ids = adminChatIds(env.LOGIN_CHAT_IDS || ADMIN_CHAT_ID);
  const cursors = adminCursors(prev, ids[0]);
  let notified = 0;
  if (!botToken(env)) {
    return { admin: cursors[ids[0]] || null, adminByChat: cursors, notified };
  }
  const io = adminIo(env, deps);
  for (const chatId of ids) {
    if (pack.adminDelivered && String(chatId) === String(ADMIN_CHAT_ID)) continue;
    const event = eventFromProgress(pack, cursors[chatId] && cursors[chatId].event);
    try {
      const delivered = await deliverAdminStatus(io, chatId, cursors[chatId] || null, event);
      if (delivered.action !== "skip") {
        cursors[chatId] = {
          messageId: delivered.messageId,
          event: delivered.event,
          text: delivered.text,
        };
        notified++;
      }
    } catch {
      console.log("admin status skipped");
    }
  }
  return { admin: cursors[ids[0]] || cursors[ADMIN_CHAT_ID] || null, adminByChat: cursors, notified };
}

async function deliverRequesterCard(env, pack, prev, deps) {
  const queue = await readQueue(env.BOT_KV);
  const match = matchedProgressRequester(pack, queue);
  if (!match) return null;
  const item = match.item;
  const chatId = Number(match.chatId);
  const io = adminIo(env, deps);
  const event = userRequestEvent({ item, pack, queue });
  let cursor = prev && prev.userCard ? prev.userCard : null;
  if (item && item.notifyMessageId && !cursor) {
    cursor = {
      messageId: item.notifyMessageId,
      event: userRequestEvent({ item, pack: null, queue }),
      text: formatUserRequestCard(userRequestEvent({ item, pack: null, queue })),
    };
  }
  try {
    const delivered = await deliverUserRequestCard(io, chatId, cursor, event);
    if (delivered.action !== "skip") {
      return { messageId: delivered.messageId, event: delivered.event, text: delivered.text };
    }
    return cursor;
  } catch {
    console.log("user request card skipped");
    return cursor;
  }
}

async function applyProgress(env, pack, deps) {
  const send = deps.sendMessage || deps;
  const kv = env.BOT_KV;
  const packKey = `pack:${pack.slug}`;
  const prev = parseStored(await kv.get(packKey));
  // Older rows kept the notification cursor in state:<slug>. Read that once, then fold it into the pack.
  let notice = prev && prev.notice ? prev.notice : null;
  if (prev && !prev.notice) notice = parseStored(await kv.get(`state:${pack.slug}`));
  let steps = notificationSteps(notice, pack);
  // Only the public post needs the queue row. Uploading ticks stay on the pack key.
  if (steps.some((step) => step.kind === "channel")) {
    const queue = await readQueue(kv);
    steps = notificationSteps(notice, channelPack(pack, queue));
  }
  const waitingForUrl = pack.status === "done" && !pack.url;
  const terminal = terminalProgress(pack);
  if (terminal) await finishQueueItem(env, pack, prev, deps);
  if (sameVisibleProgress(prev, pack) && steps.length === 0) {
    return { ok: true, status: 200, notified: 0, posted: false, waitingForUrl };
  }

  const needsToken = steps.some((step) => step.kind === "channel") && !botToken(env);
  let admin = prev && prev.admin ? prev.admin : null;
  let adminByChat = adminCursors(prev, adminChatIds(env.LOGIN_CHAT_IDS || ADMIN_CHAT_ID)[0]);
  let userCard = prev && prev.userCard ? prev.userCard : null;
  let notified = 0;
  let posted = false;
  const writePack = (cursor) =>
    kv.put(
      packKey,
      JSON.stringify({ ...pack, progressAt: new Date().toISOString(), notice: cursor, admin, userCard, adminByChat }),
    );
  if (needsToken) {
    await writePack(notice);
    return { ok: false, status: 503, error: "no bot token", notified: 0, posted: false, waitingForUrl };
  }

  // Subscriber-kind steps still advance the cursor (and the public channel post).
  // They are not sent to the subscriber list: that leaked every pack title.
  let cursor = notice;
  for (const step of steps) {
    if (step.kind === "channel") {
      try {
        await send(env, CHANNEL_CHAT, step.text);
        posted = true;
      } catch (err) {
        console.error("channel post failed", pack.slug, err && err.message);
        await writePack(cursor);
        return { ok: false, status: 502, error: "channel post failed", notified, posted: false };
      }
    }
    cursor = step.state;
  }
  const adminDelivery = await deliverAdminProgress(env, pack, prev, deps);
  admin = adminDelivery.admin;
  adminByChat = adminDelivery.adminByChat;
  notified += adminDelivery.notified;
  try {
    const deliveredUser = await deliverRequesterCard(env, pack, prev, deps);
    if (deliveredUser) userCard = deliveredUser;
  } catch {
    console.log("user request card skipped");
  }
  await writePack(cursor);
  return { ok: true, status: 200, notified, posted, waitingForUrl };
}

async function readQueue(kv) {
  return normalizeQueue(parseStored(await kv.get(QUEUE_KEY)));
}

async function writeQueue(kv, queue) {
  await kv.put(QUEUE_KEY, JSON.stringify(queue));
}

async function packProgressByUploadingId(kv, queue) {
  const packByItemId = {};
  for (const item of queue.items) {
    if (item.status !== "uploading") continue;
    packByItemId[item.id] = await readPackProgress(kv, item);
  }
  return packByItemId;
}

async function reconcileTerminalUploadingQueue(kv, queue) {
  const packByItemId = await packProgressByUploadingId(kv, queue);
  return reconcileTerminalUploadingFromProgress(queue, packByItemId);
}

function schedulePipelineAfterTerminalReconcile(env, queue, reconcile, deps) {
  if (reconcile && reconcile.changed && (reconcile.finished || []).length) {
    schedulePipeline(env, queue, deps, { dispatchReason: QUEUE_REASON.afterFinish });
  }
}

function schedulePipeline(env, queue, deps, { dispatchReason, force = false } = {}) {
  const run = async () => {
    try {
      let q = queue;
      if (env.BOT_KV) {
        const reconciled = await reconcileTerminalUploadingQueue(env.BOT_KV, q);
        if (reconciled.changed) {
          await writeQueue(env.BOT_KV, reconciled.queue);
          q = reconciled.queue;
        }
      }
      await startPipelineIfIdle(deps.fetch || fetch, env, q, { dispatchReason, force });
    } catch (err) {
      console.error("pipeline start failed", err && err.message);
    }
  };
  if (deps.waitUntil) deps.waitUntil(run());
  else run();
}

async function finishQueueItem(env, pack, prev, deps) {
  if (!terminalProgress(pack)) return null;
  let queue = await readQueue(env.BOT_KV);
  const id = findUploadingReleaseId(queue, pack);
  if (!id) return queue;
  const row = queue.items.find((item) => item.id === id);
  if (!row) return queue;
  if (row.status === "done" || row.status === "error") return queue;
  if (prev && terminalProgress(prev) && row.status !== "uploading" && row.status !== "queued") return queue;
  const status = pack.status === "error" ? "error" : "done";
  const released = releaseRequest(queue, id, status);
  if (!released.changed) return queue;
  await writeQueue(env.BOT_KV, released.queue);
  if (shouldSchedulePipelineAfterProgress(pack)) {
    schedulePipeline(env, released.queue, deps, {
      dispatchReason: queuePipelineReason(QUEUE_REASON.afterFinish, released.queue),
    });
  }
  return released.queue;
}

async function handleProjectPromptGet(request, env) {
  const secret = env.UPLOADER_SECRET || "";
  if (!secret || !timingSafeEqual(bearer(request), secret)) return new Response("unauthorized", { status: 401 });
  const id = new URL(request.url).searchParams.get("id") || "";
  if (!id) return json({ ok: false, error: "id" }, 400);
  const record = await readProjectPrompt(env.BOT_KV, id);
  if (!record) return json({ ok: false, error: "not found" }, 404);
  return json({
    ok: true,
    id: record.id,
    chatId: record.chatId,
    prompt: record.prompt,
    status: record.status,
    createdAt: record.createdAt,
    issueUrl: record.issueUrl || null,
  });
}

async function handleProjectReply(request, env, deps) {
  const secret = env.UPLOADER_SECRET || "";
  if (!secret || !timingSafeEqual(bearer(request), secret)) return new Response("unauthorized", { status: 401 });
  const raw = await request.text();
  if (raw.length > 16384) return new Response("too big", { status: 413 });
  let body;
  try {
    body = JSON.parse(raw);
  } catch {
    return json({ ok: false, error: "bad json" }, 400);
  }
  let reply;
  try {
    reply = normalizeProjectReplyBody(body);
  } catch (err) {
    return json({ ok: false, error: err.message }, 400);
  }
  const sendMessage = deps.sendMessage || defaultSend;
  const result = await applyProjectReply(env, reply, { sendMessage, ...deps });
  return json({ ok: result.ok, error: result.error, chatId: result.chatId }, result.status);
}

async function handleSessionEnded(request, env, deps) {
  const secret = env.UPLOADER_SECRET || "";
  if (!secret || !timingSafeEqual(bearer(request), secret)) return new Response("unauthorized", { status: 401 });
  const raw = await request.text();
  if (raw.length > 4096) return new Response("too big", { status: 413 });
  let body;
  try {
    body = JSON.parse(raw || "{}");
  } catch {
    return json({ ok: false, error: "bad json" }, 400);
  }
  const runId = String(body.runId || body.run_id || "").trim();
  const runUrl = String(body.runUrl || body.url || "").trim();
  const queue = await readQueue(env.BOT_KV);
  const send = deps.sendMessage || defaultSend;
  const adminId = adminChatIds(env.LOGIN_CHAT_IDS || ADMIN_CHAT_ID)[0];
  const result = await finalizeSessionOnce(env.BOT_KV, {
    runId,
    runUrl,
    queue,
    notify: (text) => send(env, adminId, text),
    dispatch: () => startReplacementSession(deps.fetch || fetch, env, queue, {
      exceptRunId: runId,
      dispatchReason: queuePipelineReason(QUEUE_REASON.afterDrainSession, queue, { preferQueued: true }),
    }),
  });
  return json({
    ok: Boolean(result.ok),
    duplicate: Boolean(result.duplicate),
    decision: result.decision,
    dispatched: Boolean(result.dispatched),
  });
}

async function handleDrainComplete(request, env, deps) {
  const secret = env.UPLOADER_SECRET || "";
  if (!secret || !timingSafeEqual(bearer(request), secret)) return new Response("unauthorized", { status: 401 });
  const queue = await readQueue(env.BOT_KV);
  const queued = queueHasQueuedWork(queue);
  if (queued) {
    schedulePipeline(env, queue, deps, {
      dispatchReason: queuePipelineReason(QUEUE_REASON.afterDrainSession, queue, { preferQueued: true }),
    });
  }
  return json({ ok: true, queued });
}

function stickerLinks(names) {
  return names.map((name) => `https://t.me/addstickers/${name}`);
}

async function handleClaim(request, env) {
  const secret = env.UPLOADER_SECRET || "";
  if (!secret || !timingSafeEqual(bearer(request), secret)) return new Response("unauthorized", { status: 401 });
  const raw = await request.text();
  let body = {};
  if (raw) {
    if (raw.length > 4096) return new Response("too big", { status: 413 });
    try {
      body = JSON.parse(raw);
    } catch {
      return json({ ok: false, error: "bad json" }, 400);
    }
  }
  let queue = await readQueue(env.BOT_KV);
  let changed = false;
  const focus = body && body.focus;
  if (focus) {
    const focused = focusRequest(queue, String(focus));
    if (focused.changed) await writeQueue(env.BOT_KV, focused.queue);
    const item = focused.item;
    return json({
      ok: true,
      claimed: item
        ? {
            id: item.id,
            chatId: item.chatId,
            title: item.title,
            links: item.links,
            priority: item.priority,
            createdAt: item.createdAt,
            status: item.status,
            stickers: item.stickers,
          }
        : null,
    });
  }
  const release = body && body.release;
  if (release && release.id) {
    const released = releaseRequest(queue, String(release.id), release.status);
    queue = released.queue;
    changed = released.changed;
  }
  // Releasing does not start the next pack. The uploader claims only when it is free.
  const claimed = release ? { queue, claimed: null, changed: false, busy: false } : claimNext(queue);
  if (!release && claimed.changed) {
    queue = claimed.queue;
    changed = true;
  }
  if (changed) await writeQueue(env.BOT_KV, queue);
  const item = claimed.claimed;
  return json({
    ok: true,
    claimed: item
      ? {
          id: item.id,
          chatId: item.chatId,
          title: item.title,
          links: item.links,
          priority: item.priority,
          createdAt: item.createdAt,
          status: item.status,
          stickers: item.stickers,
        }
      : null,
    active: Boolean(claimed.busy),
    queued: queue.items.filter((entry) => entry.status === "queued").length,
  });
}

async function handlePlan(request, env) {
  const secret = env.UPLOADER_SECRET || "";
  if (!secret || !timingSafeEqual(bearer(request), secret)) return new Response("unauthorized", { status: 401 });
  const queue = await readQueue(env.BOT_KV);
  const active = queue.items.filter((item) => item.status === "queued" || item.status === "uploading");
  const items = [];
  for (const item of active) {
    const pack = await readPackProgress(env.BOT_KV, item);
    const uploaded = pack && Number.isFinite(Number(pack.uploaded)) ? Number(pack.uploaded) : 0;
    items.push({
      id: item.id,
      chatId: item.chatId,
      title: item.title,
      links: item.links,
      priority: item.priority,
      createdAt: item.createdAt,
      status: item.status,
      stickers: item.stickers,
      uploaded,
    });
  }
  return json({ ok: true, items });
}

async function handleSessionStarted(request, env, deps) {
  const secret = env.UPLOADER_SECRET || "";
  if (!secret || !timingSafeEqual(bearer(request), secret)) return new Response("unauthorized", { status: 401 });
  const raw = await request.text();
  if (raw.length > 4096) return new Response("too big", { status: 413 });
  let body;
  try {
    body = JSON.parse(raw);
  } catch {
    return json({ ok: false, error: "bad json" }, 400);
  }
  const runId = String(body.runId || body.run_id || "").trim();
  const url = String(body.url || body.runUrl || "").trim();
  const reason = String(body.reason || "").trim() || defaultSessionReason(body.mode);
  const send = deps.sendMessage || defaultSend;
  const adminId = adminChatIds(env.LOGIN_CHAT_IDS || ADMIN_CHAT_ID)[0];
  const result = await notifySessionStartOnce(env.BOT_KV, (target, text) => send(env, target, text), adminId, {
    runId,
    url,
    reason,
  });
  return json({ ok: true, sent: result.sent, duplicate: result.reason === "duplicate" });
}

async function handleProgress(request, env, deps) {
  const secret = env.UPLOADER_SECRET || "";
  if (!secret || !timingSafeEqual(bearer(request), secret)) return new Response("unauthorized", { status: 401 });
  const raw = await request.text();
  if (raw.length > 16384) return new Response("too big", { status: 413 });
  let body;
  try {
    body = JSON.parse(raw);
  } catch {
    return json({ ok: false, error: "bad json" }, 400);
  }
  let pack;
  try {
    pack = normalizeProgress(body);
  } catch (err) {
    return json({ ok: false, error: err.message }, 400);
  }
  const sendMessage = deps.sendMessage || defaultSend;
  const result = await applyProgress(env, pack, {
    sendMessage,
    editMessage: deps.editMessage,
    deleteMessage: deps.deleteMessage,
    waitUntil: deps.waitUntil,
    fetch: deps.fetch,
  });
  return json(
    {
      ok: result.ok,
      slug: pack.slug,
      notified: result.notified,
      posted: result.posted,
      waitingForUrl: Boolean(result.waitingForUrl),
      error: result.error,
    },
    result.status,
  );
}

async function acceptCountedRequest(env, chatId, { title, names, rows, total }, deps) {
  const queue = await readQueue(env.BOT_KV);
  const priority = isPriorityChat(queue, chatId);
  const stored = enqueueRequest(queue, {
    chatId,
    title,
    links: stickerLinks(names),
    priority,
    createdAt: new Date().toISOString(),
    stickers: total,
  });
  if (stored.created) await writeQueue(env.BOT_KV, stored.queue);
  const queueAfter = stored.created ? stored.queue : queue;
  let out;
  if (stored.duplicate === "done") {
    out = `${duplicateRequestReply({
      title,
      duplicate: stored.duplicate,
      priority,
      links: stickerLinks(names),
    })}\n\n${CREATE_PROMPT}`;
    await env.BOT_KV.put(awaitCreateKey(chatId), encodeAwaitCreate({ step: "name" }));
  } else if (stored.duplicate) {
    out = duplicateRequestReply({
      title,
      duplicate: stored.duplicate,
      priority,
    });
  } else {
    const item = stored.item;
    const ahead = item ? aheadCount(stored.created ? stored.queue : queue, item) : 0;
    out = acceptReply({ title, links: stickerLinks(names), rows, total, priority, ahead });
  }
  let userCardAfterAccept = null;
  if (stored.created && stored.item) {
    userCardAfterAccept = { item: stored.item, queue: stored.queue };
    await env.BOT_KV.delete(awaitCreateKey(chatId));
  }
  if (stored.duplicate !== "done") {
    schedulePipeline(env, queueAfter, deps, { dispatchReason: QUEUE_REASON.newRequest });
  }
  return { out, userCardAfterAccept };
}

async function answer(env, update, send, stickerCount, deps = {}) {
  const message = update && update.message;
  if (!message) return;
  const text = typeof message.text === "string" ? message.text : "";
  const sticker = message.sticker && typeof message.sticker === "object" ? message.sticker : null;
  if (!text && !sticker) return;
  const chatId = message.chat && message.chat.id;
  if (!Number.isSafeInteger(chatId) && typeof chatId !== "number") return;
  await ensureSeed(env.BOT_KV);
  const cmd = text ? commandOf(text) : "";
  const known = staticReply(cmd);
  let out;
  let userCardAfterAccept = null;
  // /create restarts at the name. /stop clears a half-finished dialog and does not touch the queue.
  // Other commands leave await:<chatId> as it is.
  if (known) {
    if (known.subscribe === true) await env.BOT_KV.put(`sub:${chatId}`, "1");
    out = known.text;
  } else if (cmd === "/create") {
    await env.BOT_KV.put(awaitCreateKey(chatId), encodeAwaitCreate({ step: "name" }));
    out = CREATE_PROMPT;
  } else if (cmd === "/done") {
    const awaiting = decodeAwaitCreate(await env.BOT_KV.get(awaitCreateKey(chatId)));
    if (!awaiting || awaiting.step !== "links") {
      out = "Сейчас нечего ставить в очередь. /create — начать, затем стикеры или ссылки, и /done.";
    } else if (!awaiting.sets.length) {
      out = CREATE_DONE_EMPTY;
    } else {
      const names = awaiting.sets.map((row) => row.name);
      const rows = awaiting.sets.map((row) => `• ${row.name} — ${row.count}`);
      const total = awaiting.sets.reduce((sum, row) => sum + row.count, 0);
      const accepted = await acceptCountedRequest(
        env,
        chatId,
        { title: awaiting.title, names, rows, total },
        deps,
      );
      out = accepted.out;
      userCardAfterAccept = accepted.userCardAfterAccept;
    }
  } else if (cmd === "/stop") {
    const pending = decodeAwaitCreate(await env.BOT_KV.get(awaitCreateKey(chatId)));
    if (pending) await env.BOT_KV.delete(awaitCreateKey(chatId));
    out = pending ? STOP_CLEARED : STOP_IDLE;
  } else if (cmd === "/queue") {
    if (!isAdminChat(chatId, env.LOGIN_CHAT_IDS || ADMIN_CHAT_ID)) {
      out = "Эта команда только для администратора.";
    } else {
      const { queue, activePack, reconcile } = await loadAdminQueueState(env.BOT_KV);
      schedulePipelineAfterTerminalReconcile(env, queue, reconcile, deps);
      out = adminQueueOverviewText(queue, activePack);
    }
  } else if (cmd === "/unstick" || cmd === "/upload") {
    out = RETIRED_COMMAND;
  } else if (cmd === "/skip") {
    if (!isAdminChat(chatId, env.LOGIN_CHAT_IDS || ADMIN_CHAT_ID)) {
      out = "Эта команда только для администратора.";
    } else {
      const fetchImpl = deps.fetch || fetch;
      const queue = await readQueue(env.BOT_KV);
      const uploading = queue.items.find((item) => item.status === "uploading");
      const pack = uploading ? await readPackProgress(env.BOT_KV, uploading) : null;
      const session = readLiveSession(await env.BOT_KV.get(LIVE_SESSION_KEY));
      const actionsRunning = await telemostRunActive(fetchImpl, env);
      const now = typeof deps.now === "function" ? deps.now() : Date.now();
      const decision =
        uploading && actionsRunning
          ? skipAllowedWhileActions({ item: uploading, pack, session, now })
          : { allow: true, reason: uploading ? "idle" : "none" };
      if (uploading && actionsRunning && !decision.allow) {
        out =
          decision.reason === "progress"
            ? "Сейчас идёт загрузка стикеров — /skip не выполняю."
            : skipReply({ reason: "none", skipped: [], actionsRunning: true });
      } else {
        const why =
          decision.reason === "finished"
            ? "пак уже был готов, строка зависла"
            : decision.reason === "hung"
              ? "загрузка зависла, стикеры не идут"
              : "пропущено";
        const skipped = skipUploadingQueue(queue, why);
        if (skipped.changed) {
          await writeQueue(env.BOT_KV, skipped.queue);
          if (actionsRunning) await env.BOT_KV.delete(LIVE_SESSION_KEY);
          schedulePipeline(env, skipped.queue, deps, {
            dispatchReason: QUEUE_REASON.afterSkip,
            force: Boolean(actionsRunning),
          });
        }
        out = skipReply({
          reason: skipped.reason,
          skipped: skipped.skipped,
          actionsRunning: false,
        });
      }
    }
  } else if (cmd === "/status") {
    if (isAdminChat(chatId, env.LOGIN_CHAT_IDS || ADMIN_CHAT_ID)) {
      const { queue, job, reconcile } = await loadAdminQueueState(env.BOT_KV);
      schedulePipelineAfterTerminalReconcile(env, queue, reconcile, deps);
      const session = readLiveSession(await env.BOT_KV.get(LIVE_SESSION_KEY));
      out = adminLiveStatusText({ queue, job, session });
    } else {
      const queue = await readQueue(env.BOT_KV);
      out =
        queueStatusText(queue, chatId) ||
        "Линия свободна. Активных запросов нет. Новый перенос — /create, затем сообщение с паком (/format).";
    }
  } else if (cmd === "/restart") {
    await handleRestart(env, message, {
      send,
      fetch: deps.fetch,
      sleep: deps.sleep,
      getQueue: async () => {
        let queue = await readQueue(env.BOT_KV);
        const reconciled = await reconcileTerminalUploadingQueue(env.BOT_KV, queue);
        if (reconciled.changed) {
          await writeQueue(env.BOT_KV, reconciled.queue);
          return reconciled.queue;
        }
        return queue;
      },
    });
    return;
  } else if (cmd === "/login" || cmd === "/connect") {
    await handleVmCommand(env, message, { send, fetch: deps.fetch });
    return;
  } else if (cmd === "/project") {
    await handleProjectCommand(env, message, {
      send,
      fetch: deps.fetch,
      now: deps.now,
      waitUntil: deps.waitUntil,
      sleep: deps.sleep,
    });
    return;
  } else if (cmd === "/ghrun") {
    await handleGhrunCommand(env, message, {
      send,
      fetch: deps.fetch,
      now: deps.now,
      waitUntil: deps.waitUntil,
      sleep: deps.sleep,
    });
    return;
  } else if (cmd) {
    return;
  } else {
    const admin = isAdminChat(chatId, env.LOGIN_CHAT_IDS || ADMIN_CHAT_ID);
    const awaiting = decodeAwaitCreate(await env.BOT_KV.get(awaitCreateKey(chatId)));
    if (awaiting && awaiting.step === "name") {
      const named = nameStepResult(text);
      if (!named.ok) {
        out = named.text;
      } else {
        await env.BOT_KV.put(awaitCreateKey(chatId), encodeAwaitCreate({ step: "links", title: named.title }));
        out = createLinksPrompt(named.title);
      }
    } else if (awaiting && awaiting.step === "links") {
      const fromSticker = sticker ? stickerSetName(sticker) : null;
      if (sticker && !fromSticker) {
        const total = (awaiting.sets || []).reduce((sum, row) => sum + row.count, 0);
        out = `${STICKER_NOT_IN_PACK}\n\nВсего ${total} из ${MAX_STICKERS}. Название «${awaiting.title}» сохранено.`;
      } else {
        const names = fromSticker ? [fromSticker] : parseStickerSetNames(text);
        const lookups = [];
        for (const name of names) {
          try {
            const count = await stickerCount(env, name);
            lookups.push({ name, count });
          } catch {
            lookups.push({ name, missing: true });
          }
        }
        if (!names.length) {
          out = `${CREATE_DONE_EMPTY}\n\nНазвание «${awaiting.title}» сохранено.`;
        } else {
          const collected = collectSets(awaiting.sets, lookups);
          await env.BOT_KV.put(
            awaitCreateKey(chatId),
            encodeAwaitCreate({ step: "links", title: awaiting.title, sets: collected.sets }),
          );
          out = addedSetsReply(collected);
        }
      }
    } else if (!admin) {
      out = NEED_CREATE;
    } else {
      const parsed = parsePackMessage(text);
      if (!parsed.ok) {
        out = NOT_A_PACK;
      } else {
        const rows = [];
        let total = 0;
        for (const name of parsed.names) {
          try {
            const count = await stickerCount(env, name);
            total += count;
            rows.push(`• ${name} — ${count}`);
          } catch {
            rows.push(`• ${name} — набор не найден`);
          }
        }
        const missing = rows.some((row) => row.includes("не найден"));
        if (missing || total > MAX_STICKERS || total === 0) {
          out = renderPackCheck(parsed.title, rows, total);
        } else {
          const accepted = await acceptCountedRequest(
            env,
            chatId,
            { title: parsed.title, names: parsed.names, rows, total },
            deps,
          );
          out = accepted.out;
          userCardAfterAccept = accepted.userCardAfterAccept;
        }
      }
    }
  }
  if (out) {
    const viewerIsAdmin = isAdminChat(chatId, env.LOGIN_CHAT_IDS || ADMIN_CHAT_ID);
    await send(env, chatId, viewerIsAdmin ? out : stripGithubPointers(out));
  }
  if (userCardAfterAccept) {
    try {
      const cardText = formatUserRequestCard(
        userRequestEvent({ item: userCardAfterAccept.item, pack: null, queue: userCardAfterAccept.queue }),
      );
      const card = await send(env, chatId, cardText);
      const messageId = card && card.message_id;
      if (messageId) {
        const attached = attachQueueNotifyMessage(userCardAfterAccept.queue, userCardAfterAccept.item.id, messageId);
        if (attached.changed) await writeQueue(env.BOT_KV, attached.queue);
      }
    } catch {
      console.log("user queue card skipped");
    }
  }
}

async function handleTelegram(request, env, send, stickerCount, deps) {
  const secret = env.WEBHOOK_SECRET || "";
  const got = request.headers.get("X-Telegram-Bot-Api-Secret-Token") || "";
  if (!secret || !timingSafeEqual(got, secret)) return new Response("unauthorized", { status: 401 });
  let update;
  try {
    update = await request.json();
  } catch {
    return new Response("bad json", { status: 400 });
  }
  try {
    await answer(env, update, send, stickerCount, deps);
  } catch (err) {
    console.error("reply failed", err && err.message);
  }
  return new Response("ok");
}

export async function handle(request, env, deps = {}) {
  const send = deps.sendMessage || defaultSend;
  const stickerCount = deps.stickerCount || defaultStickerCount;
  const url = new URL(request.url);
  // Probes must not read or list KV. The free daily quota is mostly spent by /progress.
  if (request.method === "GET" && (url.pathname === "/" || url.pathname === "/health")) return json({ ok: true });
  if (request.method === "POST" && url.pathname === "/progress") {
    return handleProgress(request, env, deps);
  }
  if (request.method === "POST" && url.pathname === "/session-started") {
    return handleSessionStarted(request, env, deps);
  }
  if (request.method === "POST" && url.pathname === "/queue/claim") return handleClaim(request, env);
  if (request.method === "GET" && url.pathname === "/queue/plan") return handlePlan(request, env);
  if (request.method === "POST" && url.pathname === "/queue/drain-complete") {
    return handleDrainComplete(request, env, deps);
  }
  if (request.method === "POST" && url.pathname === "/session-ended") {
    return handleSessionEnded(request, env, deps);
  }
  if (request.method === "GET" && url.pathname === "/project/prompt") {
    return handleProjectPromptGet(request, env);
  }
  if (request.method === "POST" && url.pathname === "/project/reply") {
    return handleProjectReply(request, env, deps);
  }
  if (request.method === "POST" && url.pathname === "/telegram") return handleTelegram(request, env, send, stickerCount, deps);
  return new Response("not found", { status: 404 });
}

export default {
  fetch(request, env, ctx) {
    const waitUntil = ctx && typeof ctx.waitUntil === "function" ? (promise) => ctx.waitUntil(promise) : null;
    return handle(request, env, waitUntil ? { waitUntil } : {});
  },
};
