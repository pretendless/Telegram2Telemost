import { ADMIN_CHAT_ID, isAdminChat } from "../../scripts/admin_status.mjs";
import {
  DEFAULT_REF,
  DEFAULT_REPO,
  awaitLetterboxdKey,
  decodeAwaitLetterboxd,
  dispatchLetterboxdWorkflow,
  encodeAwaitLetterboxd,
  findLetterboxdRunUrl,
  letterboxdAckText,
  letterboxdDispatchFailText,
  letterboxdDispatchedText,
  letterboxdInvalidZipText,
  letterboxdJobKey,
  letterboxdNeedZipText,
  letterboxdPromptText,
  letterboxdStartingText,
  letterboxdUsageText,
  isZipDocument,
  LETTERBOXD_WORKFLOW,
  newLetterboxdJobId,
  normalizeTelegramFileId,
  parseLetterboxdCommand,
} from "../../vm/letterboxd_genres.js";
import { awaitCreateKey } from "./logic.js";

export async function finishLetterboxdDispatch(env, { jobId, chatId, fileId, deps = {} }) {
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
    }),
  );
  await kv.delete(awaitLetterboxdKey(chatId));

  await send(env, chatId, letterboxdAckText(jobId));
  await send(env, chatId, letterboxdStartingText());

  const background = async () => {
    await finishLetterboxdDispatch(env, {
      jobId,
      chatId,
      fileId,
      deps: { ...deps, send },
    });
  };

  if (deps.waitUntil) {
    deps.waitUntil(background());
    return true;
  }
  await background();
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
