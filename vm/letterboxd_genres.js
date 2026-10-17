// Telegram /genres → wait for Letterboxd ZIP → GitHub Actions (Worker-safe).

import {
  assertRef,
  DEFAULT_REF,
  DEFAULT_REPO,
  dispatchUrl,
  githubHeaders,
  workflowRunsUrl,
} from "./dispatch.js";

export const LETTERBOXD_GENRES_WORKFLOW = "letterboxd-genres.yml";
export const AWAIT_GENRES_PREFIX = "await:genres:";
export const GENRES_JOB_PREFIX = "genres:job:";

const FILE_ID_RE = /^[A-Za-z0-9_-]{10,200}$/;

export function parseGenresCommand(text) {
  const trimmed = String(text || "").trim();
  const match = trimmed.match(/^\/genres(?:@[A-Za-z0-9_]+)?(?:\s+([\s\S]*))?$/i);
  if (!match) return null;
  const rest = (match[1] || "").trim();
  if (rest) return { error: "usage" };
  return { ok: true };
}

export function awaitGenresKey(chatId) {
  return `${AWAIT_GENRES_PREFIX}${chatId}`;
}

export function genresJobKey(jobId) {
  return `${GENRES_JOB_PREFIX}${jobId}`;
}

export function encodeAwaitGenres(state = {}) {
  return JSON.stringify({
    kind: "genres",
    since: state.since || new Date().toISOString(),
  });
}

export function decodeAwaitGenres(raw) {
  if (raw == null || raw === "") return null;
  try {
    const parsed = JSON.parse(String(raw));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    if (parsed.kind !== "genres") return null;
    return { kind: "genres", since: String(parsed.since || "") };
  } catch {
    return null;
  }
}

export function newGenresJobId(now = () => new Date()) {
  const stamp = now().toISOString().replace(/[:.]/g, "-");
  return `lb-${stamp}`.slice(0, 80);
}

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

export function genresPromptText() {
  return (
    "Пришлите ZIP экспорта Letterboxd одним документом.\n\n" +
    "Letterboxd → Settings → Import & Export → Export Your Data.\n" +
    "В архиве нужен diary.csv. Отмена — /stop."
  );
}

export function genresNeedZipText() {
  return "Нужен файл .zip экспорта Letterboxd (документ в чат). Отмена — /stop.";
}

export function genresInvalidZipText() {
  return "Это не ZIP Letterboxd. Пришлите файл .zip из Settings → Export. Отмена — /stop.";
}

export function genresAckText(jobId) {
  return (
    "ZIP принят. Строю графики Letterboxd через GitHub Actions — пришлю PNG в этот чат " +
    "(жанры + просмотры по дням/месяцам/годам).\n\n" +
    `id: ${jobId}`
  );
}

export function genresStartingText() {
  return "⏳ Запускаю letterboxd-genres…";
}

export function genresDispatchedText({ jobId, runUrl }) {
  if (runUrl) {
    return `✅ Запуск принят.\n\n${runUrl}\n\nid: ${jobId}`;
  }
  return `✅ Запуск принят. Графики придут отдельными сообщениями.\n\nid: ${jobId}`;
}

export function genresDispatchFailText(status) {
  return `Не удалось запустить letterboxd-genres: GitHub ответил ${status}. Проверьте GH_DISPATCH_TOKEN и workflow в main.`;
}

export function genresUsageText() {
  return "Команда без аргументов: /genres — затем пришлите ZIP экспорта Letterboxd.";
}

export function genresStopClearedHead() {
  return "Ввод прерван, ожидание ZIP Letterboxd сброшено.";
}

export function buildGenresDispatch({ repo, workflow, ref, jobId, chatId, fileId }) {
  const id = String(jobId || "").trim();
  const chat = String(chatId ?? "").trim();
  const file = normalizeTelegramFileId(fileId);
  if (!id || id.length > 80) throw new Error("jobId");
  if (!chat || !/^-?[0-9]{1,16}$/.test(chat)) throw new Error("chatId");
  if (!file) throw new Error("fileId");
  return {
    url: dispatchUrl(repo, workflow || LETTERBOXD_GENRES_WORKFLOW),
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

export async function dispatchGenresWorkflow(fetchImpl, { token, repo, workflow, ref, jobId, chatId, fileId }) {
  const built = buildGenresDispatch({ repo, workflow, ref, jobId, chatId, fileId });
  const res = await fetchImpl(built.url, {
    method: "POST",
    headers: githubHeaders(token),
    body: JSON.stringify(built.body),
  });
  return { ok: res.status === 204, status: res.status };
}

async function readJsonBody(response) {
  if (!response || typeof response.json !== "function") return {};
  try {
    return await response.json();
  } catch {
    return {};
  }
}

export async function findGenresRunUrl(
  fetchImpl,
  { token, repo, workflow, startedAt, sleep, attempts = 5 },
) {
  const headers = githubHeaders(token);
  const listUrl = workflowRunsUrl(repo, workflow || LETTERBOXD_GENRES_WORKFLOW);
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

export { DEFAULT_REF, DEFAULT_REPO };
