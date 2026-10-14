// Telegram /project → GitHub cursor-agent workflow. No Node builtins (Worker-safe).

import {
  assertRef,
  DEFAULT_REF,
  DEFAULT_REPO,
  dispatchUrl,
  githubHeaders,
  workflowRunsUrl,
} from "./dispatch.js";

export const DEFAULT_PROJECT_PROMPT_WORKFLOW = "cursor-agent.yml";
export const OPTIONAL_PROJECT_ISSUE_WORKFLOW = "project-prompt.yml";
export const PROJECT_PROMPT_KV_PREFIX = "project:prompt:";

const PROMPT_MAX = 8000;

export function parseProjectCommand(text) {
  const trimmed = String(text || "").trim();
  const match = trimmed.match(/^\/project(?:@[A-Za-z0-9_]+)?(?:\s+([\s\S]*))?$/i);
  if (!match) return null;
  const prompt = (match[1] || "").trim();
  if (!prompt) return { error: "empty" };
  if (prompt.length > PROMPT_MAX) return { error: "long", max: PROMPT_MAX };
  return { prompt };
}

export function newPromptId(now = () => new Date()) {
  const stamp = now().toISOString().replace(/[:.]/g, "-");
  return `tg-${stamp}`.slice(0, 80);
}

export function projectPromptKey(id) {
  return `${PROJECT_PROMPT_KV_PREFIX}${id}`;
}

export function buildProjectPromptDispatch({ repo, workflow, ref, promptId, chatId }) {
  const id = String(promptId || "").trim();
  if (!id || id.length > 80) throw new Error("promptId");
  return {
    url: dispatchUrl(repo, workflow || DEFAULT_PROJECT_PROMPT_WORKFLOW),
    body: {
      ref: assertRef(ref || DEFAULT_REF),
      inputs: {
        prompt_id: id,
        chat_id: chatId == null ? "" : String(chatId),
      },
    },
  };
}

export async function dispatchProjectPrompt(fetchImpl, { token, repo, workflow, ref, promptId, chatId }) {
  const built = buildProjectPromptDispatch({ repo, workflow, ref, promptId, chatId });
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

/** Best-effort: find a project-prompt workflow run that started around dispatch time. */
export async function findProjectPromptRunUrl(
  fetchImpl,
  { token, repo, workflow, startedAt, sleep, attempts = 5 },
) {
  const headers = githubHeaders(token);
  const listUrl = workflowRunsUrl(repo, workflow || DEFAULT_PROJECT_PROMPT_WORKFLOW);
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

export function projectStartingText() {
  return "⏳ Запускаю GitHub Actions (cursor-agent)…";
}

/** Issue workflow when PROJECT_ALSO_CREATE_ISSUE is on. Empty means skip. */
export function optionalProjectIssueWorkflow(flag) {
  const raw = String(flag ?? "").trim().toLowerCase();
  if (raw === "1" || raw === "true" || raw === "yes" || raw === "on") return OPTIONAL_PROJECT_ISSUE_WORKFLOW;
  return "";
}

export function projectDispatchedText({ promptId, runUrl }) {
  if (runUrl) {
    return `✅ Очередь Project: workflow запущен.\n\n${runUrl}\n\nid: ${promptId}`;
  }
  return `✅ Запрос поставлен в очередь Project (GitHub dispatch ok).\n\nid: ${promptId}`;
}

export function projectFastAckSummary(prompt, max = 200) {
  const one = String(prompt || "").replace(/\s+/g, " ").trim();
  const head = one.slice(0, max);
  const tail = one.length > max ? "…" : "";
  return `Принято: ${head}${tail} Обработка в Project начата.`;
}

export function projectIssueTitle(prompt, max = 60) {
  const one = String(prompt || "").replace(/\s+/g, " ").trim();
  const head = one.slice(0, max);
  return `[TG Project] ${head}${one.length > max ? "…" : ""}`;
}

export function cursorAgentIssueHint(repo = DEFAULT_REPO) {
  const slug = String(repo || DEFAULT_REPO);
  return [
    "## Cursor Cloud Agent",
    "",
    "Основной путь — workflow `cursor-agent.yml` (его запускает `/project`).",
    "Этот issue — необязательный след: воркер создаёт его только если задан `PROJECT_ALSO_CREATE_ISSUE`.",
    "",
    `Репозиторий: https://github.com/${slug}`,
  ].join("\n");
}

export function projectUsageText(error) {
  if (error === "empty") {
    return "Формат: /project <вопрос или задача для Cursor Project>.\n\nПример: /project что сейчас делает агент с очередью?";
  }
  if (error === "long") {
    return `Слишком длинный текст (лимит ${PROMPT_MAX} символов). Сократите или разбейте на части.`;
  }
  return "Не удалось разобрать команду /project.";
}

export function projectAckText(promptId) {
  return (
    "Запрос к проекту принят. Краткий ответ пришлю сюда, когда обработка завершится.\n\n" +
    `id: ${promptId}`
  );
}

export function projectMirrorText(prompt) {
  const body = String(prompt || "").trim();
  const clipped = body.length > 3500 ? `${body.slice(0, 3500)}…` : body;
  return `📋 Для Cursor Project (копия из Telegram):\n\n${clipped}`;
}

export function projectDispatchFailText(status) {
  return `Не удалось запустить cursor-agent: GitHub ответил ${status}. Проверьте GH_DISPATCH_TOKEN и workflow cursor-agent.yml в main.`;
}

export function normalizeProjectReplyBody(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("body");
  const id = String(body.id || body.promptId || body.prompt_id || "").trim();
  if (!id) throw new Error("id");
  const summary = String(body.summary || body.text || body.message || "").trim();
  if (!summary) throw new Error("summary");
  if (summary.length > 4000) throw new Error("summary");
  const chatId = body.chatId != null ? String(body.chatId).trim() : body.chat_id != null ? String(body.chat_id).trim() : "";
  if (chatId && !/^-?[0-9]{1,16}$/.test(chatId)) throw new Error("chatId");
  const issueUrlRaw = body.issueUrl != null ? String(body.issueUrl).trim() : body.issue_url != null ? String(body.issue_url).trim() : "";
  const issueUrl = issueUrlRaw && issueUrlRaw.length <= 500 ? issueUrlRaw : null;
  return { id, summary, chatId: chatId || null, issueUrl };
}
