import { ADMIN_CHAT_ID, isAdminChat } from "../../scripts/admin_status.mjs";
import {
  DEFAULT_REF,
  DEFAULT_REPO,
  awaitGenresKey,
  decodeAwaitGenres,
  dispatchGenresWorkflow,
  encodeAwaitGenres,
  findGenresRunUrl,
  genresAckText,
  genresDispatchFailText,
  genresDispatchedText,
  genresInvalidZipText,
  genresJobKey,
  genresNeedZipText,
  genresPromptText,
  genresStartingText,
  genresUsageText,
  isZipDocument,
  LETTERBOXD_GENRES_WORKFLOW,
  newGenresJobId,
  normalizeTelegramFileId,
  parseGenresCommand,
} from "../../vm/letterboxd_genres.js";
import { awaitCreateKey } from "./logic.js";

export async function finishGenresDispatch(env, { jobId, chatId, fileId, deps = {} }) {
  const send = deps.send;
  const fetchImpl = deps.fetch || fetch;
  const repo = env.GH_REPO || DEFAULT_REPO;
  const workflow = env.LETTERBOXD_GENRES_WORKFLOW || LETTERBOXD_GENRES_WORKFLOW;
  const ref = env.LETTERBOXD_GENRES_REF || env.GH_GHRUN_REF || DEFAULT_REF;
  const startedAt = typeof deps.now === "function" ? deps.now().getTime() : Date.now();
  let dispatched;
  try {
    dispatched = await dispatchGenresWorkflow(fetchImpl, {
      token: env.GH_DISPATCH_TOKEN,
      repo,
      workflow,
      ref,
      jobId,
      chatId,
      fileId,
    });
  } catch (err) {
    console.error("genres dispatch failed", err && err.message);
    dispatched = { ok: false, status: 0 };
  }
  if (!dispatched.ok) {
    if (send) await send(env, chatId, genresDispatchFailText(dispatched.status || "error"));
    return { ok: false };
  }
  let runUrl = "";
  try {
    runUrl = await findGenresRunUrl(fetchImpl, {
      token: env.GH_DISPATCH_TOKEN,
      repo,
      workflow,
      startedAt,
      sleep: deps.sleep,
    });
  } catch (err) {
    console.error("genres run lookup failed", err && err.message);
  }
  if (send) {
    // Run URL only to admins; regular users get a short ack without github.com.
    const admin = isAdminChat(chatId, env.LOGIN_CHAT_IDS || ADMIN_CHAT_ID);
    await send(env, chatId, genresDispatchedText({ jobId, runUrl: admin ? runUrl : "" }));
  }
  return { ok: true, runUrl };
}

export async function handleGenresCommand(env, message, deps = {}) {
  const parsed = parseGenresCommand(message && message.text);
  if (!parsed) return false;
  const send = deps.send;
  if (!send) throw new Error("send");
  const chatId = message.chat && message.chat.id;
  if (parsed.error) {
    await send(env, chatId, genresUsageText());
    return true;
  }
  const kv = env.BOT_KV;
  if (!kv) {
    await send(env, chatId, "KV недоступен — не могу ждать ZIP.");
    return true;
  }
  // Clear unfinished /create so /stop and document handling stay unambiguous.
  await kv.delete(awaitCreateKey(chatId));
  await kv.put(awaitGenresKey(chatId), encodeAwaitGenres({ since: new Date().toISOString() }));
  await send(env, chatId, genresPromptText());
  return true;
}

export async function handleGenresDocument(env, message, deps = {}) {
  const send = deps.send;
  if (!send) throw new Error("send");
  const chatId = message.chat && message.chat.id;
  const kv = env.BOT_KV;
  if (!kv) return false;
  const awaiting = decodeAwaitGenres(await kv.get(awaitGenresKey(chatId)));
  if (!awaiting) return false;

  const document = message.document;
  if (!isZipDocument(document)) {
    await send(env, chatId, genresInvalidZipText());
    return true;
  }
  const fileId = normalizeTelegramFileId(document.file_id || document.fileId);
  if (!fileId) {
    await send(env, chatId, genresNeedZipText());
    return true;
  }
  if (!env.GH_DISPATCH_TOKEN) {
    await send(env, chatId, "Запуск не настроен: нет секрета GH_DISPATCH_TOKEN.");
    return true;
  }

  const jobId = newGenresJobId(deps.now);
  const createdAt = typeof deps.now === "function" ? deps.now().toISOString() : new Date().toISOString();
  await kv.put(
    genresJobKey(jobId),
    JSON.stringify({
      id: jobId,
      chatId: String(chatId),
      fileId,
      status: "pending",
      createdAt,
    }),
  );
  await kv.delete(awaitGenresKey(chatId));

  await send(env, chatId, genresAckText(jobId));
  await send(env, chatId, genresStartingText());

  const background = async () => {
    await finishGenresDispatch(env, {
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

export async function clearGenresAwait(kv, chatId) {
  if (!kv) return false;
  const key = awaitGenresKey(chatId);
  const pending = decodeAwaitGenres(await kv.get(key));
  if (!pending) return false;
  await kv.delete(key);
  return true;
}
