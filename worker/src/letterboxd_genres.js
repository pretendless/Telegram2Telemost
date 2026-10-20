import { ADMIN_CHAT_ID, isAdminChat } from "../../scripts/admin_status.mjs";
import {
  DEFAULT_REF,
  DEFAULT_REPO,
  awaitLetterboxdKey,
  decodeAwaitLetterboxd,
  dispatchLetterboxdWorkflow,
  encodeAwaitLetterboxd,
  findLetterboxdRunUrl,
  advanceLetterboxdWizard,
  letterboxdAckText,
  letterboxdDispatchFailText,
  letterboxdDispatchedText,
  letterboxdInvalidZipText,
  letterboxdJobKey,
  letterboxdModePrompt,
  letterboxdNeedZipText,
  letterboxdPromptText,
  letterboxdStartingText,
  letterboxdUsageText,
  isZipDocument,
  LETTERBOXD_WORKFLOW,
  newLetterboxdJobId,
  normalizeTelegramFileId,
  parseLetterboxdCallback,
  parseLetterboxdCommand,
} from "../../vm/letterboxd_genres.js";
import { awaitCreateKey } from "./logic.js";

export async function finishLetterboxdDispatch(env, { jobId, chatId, fileId, options, deps = {} }) {
  const send = deps.send;
  const fetchImpl = deps.fetch || fetch;
  const repo = env.GH_REPO || DEFAULT_REPO;
  const workflow = env.LETTERBOXD_WORKFLOW || env.LETTERBOXD_GENRES_WORKFLOW || LETTERBOXD_WORKFLOW;
  const ref = env.LETTERBOXD_REF || env.LETTERBOXD_GENRES_REF || env.GH_GHRUN_REF || DEFAULT_REF;
  const startedAt = typeof deps.now === "function" ? deps.now().getTime() : Date.now();
  let dispatched;
  try {
    dispatched = await dispatchLetterboxdWorkflow(fetchImpl, {
      token: env.GH_DISPATCH_TOKEN,
      repo,
      workflow,
      ref,
      jobId,
      chatId,
      fileId,
      options,
    });
  } catch (err) {
    console.error("letterboxd dispatch failed", err && err.message);
    dispatched = { ok: false, status: 0 };
  }
  if (!dispatched.ok) {
    if (send) await send(env, chatId, letterboxdDispatchFailText(dispatched.status || "error"));
    return { ok: false };
  }
  let runUrl = "";
  try {
    runUrl = await findLetterboxdRunUrl(fetchImpl, {
      token: env.GH_DISPATCH_TOKEN,
      repo,
      workflow,
      startedAt,
      sleep: deps.sleep,
    });
  } catch (err) {
    console.error("letterboxd run lookup failed", err && err.message);
  }
  if (send) {
    const admin = isAdminChat(chatId, env.LOGIN_CHAT_IDS || ADMIN_CHAT_ID);
    await send(env, chatId, letterboxdDispatchedText({ jobId, runUrl: admin ? runUrl : "" }));
  }
  return { ok: true, runUrl };
}

/** @deprecated use finishLetterboxdDispatch */
export const finishGenresDispatch = finishLetterboxdDispatch;

export async function handleLetterboxdCommand(env, message, deps = {}) {
  const parsed = parseLetterboxdCommand(message && message.text);
  if (!parsed) return false;
  const send = deps.send;
  if (!send) throw new Error("send");
  const chatId = message.chat && message.chat.id;
  if (parsed.error) {
    await send(env, chatId, letterboxdUsageText());
    return true;
  }
  const kv = env.BOT_KV;
  if (!kv) {
    await send(env, chatId, "KV недоступен — не могу ждать ZIP.");
    return true;
  }
  await kv.delete(awaitCreateKey(chatId));
  await kv.put(awaitLetterboxdKey(chatId), encodeAwaitLetterboxd({ since: new Date().toISOString() }));
  await send(env, chatId, letterboxdPromptText());
  return true;
}

/** @deprecated use handleLetterboxdCommand */
export const handleGenresCommand = handleLetterboxdCommand;

export async function handleLetterboxdDocument(env, message, deps = {}) {
  const send = deps.send;
  if (!send) throw new Error("send");
  const chatId = message.chat && message.chat.id;
  const kv = env.BOT_KV;
  if (!kv) return false;
  const awaiting = decodeAwaitLetterboxd(await kv.get(awaitLetterboxdKey(chatId)));
  if (!awaiting) return false;

  const document = message.document;
  if (!isZipDocument(document)) {
    await send(env, chatId, letterboxdInvalidZipText());
    return true;
  }
  const fileId = normalizeTelegramFileId(document.file_id || document.fileId);
  if (!fileId) {
    await send(env, chatId, letterboxdNeedZipText());
    return true;
  }
  if (!env.GH_DISPATCH_TOKEN) {
    await send(env, chatId, "Запуск не настроен: нет секрета GH_DISPATCH_TOKEN.");
    return true;
  }

  await kv.put(
    awaitLetterboxdKey(chatId),
    encodeAwaitLetterboxd({
      since: awaiting.since,
      step: "mode",
      fileId,
    }),
  );
  const prompt = letterboxdModePrompt();
  await send(env, chatId, prompt.text, { reply_markup: prompt.reply_markup });
  return true;
}

async function beginLetterboxdJob(env, chatId, fileId, options, deps) {
  const send = deps.send;
  const kv = env.BOT_KV;
  const jobId = newLetterboxdJobId(deps.now);
  const createdAt = typeof deps.now === "function" ? deps.now().toISOString() : new Date().toISOString();
  await kv.put(
    letterboxdJobKey(jobId),
    JSON.stringify({
      id: jobId,
      chatId: String(chatId),
      fileId,
      status: "pending",
      createdAt,
      options,
    }),
  );
  await kv.delete(awaitLetterboxdKey(chatId));
  await send(env, chatId, letterboxdAckText(jobId, options));
  await send(env, chatId, letterboxdStartingText());
  const background = async () => {
    await finishLetterboxdDispatch(env, {
      jobId,
      chatId,
      fileId,
      options,
      deps: { ...deps, send },
    });
  };
  if (deps.waitUntil) deps.waitUntil(background());
  else await background();
}

async function applyLetterboxdWizard(env, chatId, outcome, deps) {
  const kv = env.BOT_KV;
  const send = deps.send;
  if (outcome.state && !outcome.clear) {
    await kv.put(awaitLetterboxdKey(chatId), encodeAwaitLetterboxd(outcome.state));
  }
  for (const msg of outcome.messages || []) {
    await send(env, chatId, msg.text, msg.reply_markup ? { reply_markup: msg.reply_markup } : undefined);
  }
  if (outcome.dispatch) {
    await beginLetterboxdJob(env, chatId, outcome.dispatch.fileId, outcome.dispatch.options, deps);
  } else if (outcome.clear) {
    await kv.delete(awaitLetterboxdKey(chatId));
  }
}

export async function handleLetterboxdText(env, message, deps = {}) {
  const send = deps.send;
  if (!send) throw new Error("send");
  const chatId = message.chat && message.chat.id;
  const kv = env.BOT_KV;
  if (!kv) return false;
  const state = decodeAwaitLetterboxd(await kv.get(awaitLetterboxdKey(chatId)));
  if (!state || state.step === "zip") return false;
  const now = typeof deps.now === "function" ? deps.now() : new Date();
  const outcome = advanceLetterboxdWizard(state, { kind: "text", text: message.text }, now);
  await applyLetterboxdWizard(env, chatId, outcome, deps);
  return true;
}

async function replyCallback(answer, env, id, text) {
  if (!answer) return;
  try {
    await answer(env, id, text || "");
  } catch (err) {
    console.error("answerCallbackQuery", err && err.message);
  }
}

export async function handleLetterboxdCallback(env, callback, deps = {}) {
  const answer = deps.answerCallback;
  const callbackId = callback && callback.id;
  const parsed = parseLetterboxdCallback(callback && callback.data);
  const message = callback && callback.message;
  const chatId = message && message.chat && message.chat.id;
  if (!parsed || chatId == null) {
    await replyCallback(answer, env, callbackId, "");
    return false;
  }
  const kv = env.BOT_KV;
  const state = kv ? decodeAwaitLetterboxd(await kv.get(awaitLetterboxdKey(chatId))) : null;
  if (!state) {
    await replyCallback(answer, env, callbackId, "Ожидание Letterboxd уже сброшено.");
    return true;
  }
  if (parsed.step !== state.step) {
    await replyCallback(answer, env, callbackId, "Этот шаг уже пройден.");
    return true;
  }
  // Stop the button spinner before the next question or the GitHub dispatch.
  await replyCallback(answer, env, callbackId, "");
  if (deps.clearKeyboard && message.message_id) {
    await deps.clearKeyboard(env, chatId, message.message_id);
  }
  const now = typeof deps.now === "function" ? deps.now() : new Date();
  const outcome = advanceLetterboxdWizard(state, { kind: "callback", ...parsed }, now);
  await applyLetterboxdWizard(env, chatId, outcome, deps);
  return true;
}

/** @deprecated use handleLetterboxdDocument */
export const handleGenresDocument = handleLetterboxdDocument;

export async function clearLetterboxdAwait(kv, chatId) {
  if (!kv) return false;
  const key = awaitLetterboxdKey(chatId);
  const pending = decodeAwaitLetterboxd(await kv.get(key));
  if (!pending) return false;
  await kv.delete(key);
  return true;
}

/** @deprecated use clearLetterboxdAwait */
export const clearGenresAwait = clearLetterboxdAwait;
