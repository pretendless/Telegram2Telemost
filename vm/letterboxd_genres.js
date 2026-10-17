// Telegram /letterboxd → wait for Letterboxd ZIP → GitHub Actions (Worker-safe).

import {
  assertRef,
  DEFAULT_REF,
  DEFAULT_REPO,
  dispatchUrl,
  githubHeaders,
  workflowRunsUrl,
} from "./dispatch.js";

export const LETTERBOXD_WORKFLOW = "letterboxd.yml";
/** @deprecated use LETTERBOXD_WORKFLOW */
export const LETTERBOXD_GENRES_WORKFLOW = LETTERBOXD_WORKFLOW;
export const AWAIT_LETTERBOXD_PREFIX = "await:letterboxd:";
/** @deprecated use AWAIT_LETTERBOXD_PREFIX */
export const AWAIT_GENRES_PREFIX = AWAIT_LETTERBOXD_PREFIX;
export const LETTERBOXD_JOB_PREFIX = "letterboxd:job:";
/** @deprecated use LETTERBOXD_JOB_PREFIX */
export const GENRES_JOB_PREFIX = LETTERBOXD_JOB_PREFIX;

const FILE_ID_RE = /^[A-Za-z0-9_-]{10,200}$/;

export function parseLetterboxdCommand(text) {
  const trimmed = String(text || "").trim();
  const match = trimmed.match(/^\/letterboxd(?:@[A-Za-z0-9_]+)?(?:\s+([\s\S]*))?$/i);
  if (!match) return null;
  const rest = (match[1] || "").trim();
  if (rest) return { error: "usage" };
  return { ok: true };
}

/** @deprecated use parseLetterboxdCommand */
export const parseGenresCommand = parseLetterboxdCommand;

export function awaitLetterboxdKey(chatId) {
  return `${AWAIT_LETTERBOXD_PREFIX}${chatId}`;
}

/** @deprecated use awaitLetterboxdKey */
export const awaitGenresKey = awaitLetterboxdKey;

export function letterboxdJobKey(jobId) {
  return `${LETTERBOXD_JOB_PREFIX}${jobId}`;
}

/** @deprecated use letterboxdJobKey */
export const genresJobKey = letterboxdJobKey;

export function encodeAwaitLetterboxd(state = {}) {
  return JSON.stringify({
    kind: "letterboxd",
    since: state.since || new Date().toISOString(),
  });
}

/** @deprecated use encodeAwaitLetterboxd */
export const encodeAwaitGenres = encodeAwaitLetterboxd;

export function decodeAwaitLetterboxd(raw) {
  if (raw == null || raw === "") return null;
  try {
    const parsed = JSON.parse(String(raw));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    // Accept legacy "genres" kind from older workers during rollout.
    if (parsed.kind !== "letterboxd" && parsed.kind !== "genres") return null;
    return { kind: "letterboxd", since: String(parsed.since || "") };
  } catch {
    return null;
  }
}

/** @deprecated use decodeAwaitLetterboxd */
export const decodeAwaitGenres = decodeAwaitLetterboxd;

export function newLetterboxdJobId(now = () => new Date()) {
  const stamp = now().toISOString().replace(/[:.]/g, "-");
  return `lb-${stamp}`.slice(0, 80);
}

/** @deprecated use newLetterboxdJobId */
export const newGenresJobId = newLetterboxdJobId;

export function isZipDocument(document) {
  if (!document || typeof document !== "object") return false;
  const name = String(document.file_name || document.fileName || "").toLowerCase();
  const mime = String(document.mime_type || document.mimeType || "").toLowerCase();
  if (name.endsWith(".zip")) return true;
  if (mime === "application/zip" || mime === "application/x-zip-compressed") return true;
  return false;
}

export function normalizeTelegramFileId(raw) {
  const id = String(raw || "").trim();
  if (!FILE_ID_RE.test(id)) return "";
  return id;
}

export function letterboxdPromptText() {
  return (
    "Пришлите ZIP экспорта Letterboxd одним документом.\n\n" +
    "Letterboxd → Settings → Import & Export → Export Your Data.\n" +
    "В архиве нужен diary.csv; watched.csv тоже учтём в каталожной статистике. Отмена — /stop."
  );
}

/** @deprecated use letterboxdPromptText */
export const genresPromptText = letterboxdPromptText;

export function letterboxdNeedZipText() {
  return "Нужен файл .zip экспорта Letterboxd (документ в чат). Отмена — /stop.";
}

/** @deprecated use letterboxdNeedZipText */
export const genresNeedZipText = letterboxdNeedZipText;

export function letterboxdInvalidZipText() {
  return "Это не ZIP Letterboxd. Пришлите файл .zip из Settings → Export. Отмена — /stop.";
}

/** @deprecated use letterboxdInvalidZipText */
export const genresInvalidZipText = letterboxdInvalidZipText;

export function letterboxdAckText(jobId) {
  return (
    "ZIP принят. Строю графики Letterboxd через GitHub Actions — пришлю PNG в этот чат " +
    "(календарь, доп. статистика, жанры).\n\n" +
    `id: ${jobId}`
  );
}

/** @deprecated use letterboxdAckText */
export const genresAckText = letterboxdAckText;

export function letterboxdStartingText() {
  return "⏳ Запускаю letterboxd…";
}

/** @deprecated use letterboxdStartingText */
export const genresStartingText = letterboxdStartingText;

export function letterboxdDispatchedText({ jobId, runUrl }) {
  if (runUrl) {
    return `✅ Запуск принят.\n\n${runUrl}\n\nid: ${jobId}`;
  }
  return `✅ Запуск принят. Графики придут отдельными сообщениями.\n\nid: ${jobId}`;
}

/** @deprecated use letterboxdDispatchedText */
export const genresDispatchedText = letterboxdDispatchedText;

export function letterboxdDispatchFailText(status) {
  return `Не удалось запустить letterboxd: GitHub ответил ${status}. Проверьте GH_DISPATCH_TOKEN и workflow letterboxd.yml в main.`;
}

/** @deprecated use letterboxdDispatchFailText */
export const genresDispatchFailText = letterboxdDispatchFailText;

export function letterboxdUsageText() {
  return "Команда без аргументов: /letterboxd — затем пришлите ZIP экспорта Letterboxd.";
}

/** @deprecated use letterboxdUsageText */
export const genresUsageText = letterboxdUsageText;

export function letterboxdStopClearedHead() {
  return "Ввод прерван, ожидание ZIP Letterboxd сброшено.";
}

/** @deprecated use letterboxdStopClearedHead */
export const genresStopClearedHead = letterboxdStopClearedHead;

export function buildLetterboxdDispatch({ repo, workflow, ref, jobId, chatId, fileId }) {
  const id = String(jobId || "").trim();
  const chat = String(chatId ?? "").trim();
  const file = normalizeTelegramFileId(fileId);
  if (!id || id.length > 80) throw new Error("jobId");
  if (!chat || !/^-?[0-9]{1,16}$/.test(chat)) throw new Error("chatId");
  if (!file) throw new Error("fileId");
  return {
    url: dispatchUrl(repo, workflow || LETTERBOXD_WORKFLOW),
    body: {
      ref: assertRef(ref || DEFAULT_REF),
      inputs: {
        job_id: id,
        chat_id: chat,
        file_id: file,
      },
    },
  };
}

/** @deprecated use buildLetterboxdDispatch */
export const buildGenresDispatch = buildLetterboxdDispatch;

export async function dispatchLetterboxdWorkflow(fetchImpl, { token, repo, workflow, ref, jobId, chatId, fileId }) {
  const built = buildLetterboxdDispatch({ repo, workflow, ref, jobId, chatId, fileId });
  const res = await fetchImpl(built.url, {
    method: "POST",
    headers: githubHeaders(token),
    body: JSON.stringify(built.body),
  });
  return { ok: res.status === 204, status: res.status };
}

/** @deprecated use dispatchLetterboxdWorkflow */
export const dispatchGenresWorkflow = dispatchLetterboxdWorkflow;

async function readJsonBody(response) {
  if (!response || typeof response.json !== "function") return {};
  try {
    return await response.json();
  } catch {
    return {};
  }
}

export async function findLetterboxdRunUrl(
  fetchImpl,
  { token, repo, workflow, startedAt, sleep, attempts = 5 },
) {
  const headers = githubHeaders(token);
  const listUrl = workflowRunsUrl(repo, workflow || LETTERBOXD_WORKFLOW);
  const since = typeof startedAt === "number" ? startedAt : Date.now();
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (sleep && attempt) await sleep(800);
    const res = await fetchImpl(listUrl, { headers });
    if (res.status !== 200) continue;
    const body = await readJsonBody(res);
    const runs = (body.workflow_runs || []).filter((run) => run && run.html_url);
    const fresh = runs.find((run) => Date.parse(run.created_at) >= since - 20_000);
    if (fresh) return fresh.html_url;
  }
  return "";
}

/** @deprecated use findLetterboxdRunUrl */
export const findGenresRunUrl = findLetterboxdRunUrl;

export { DEFAULT_REF, DEFAULT_REPO };
