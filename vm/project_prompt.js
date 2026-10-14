// Telegram /project → GitHub project-prompt workflow. No Node builtins (Worker-safe).

import { assertRef, DEFAULT_REF, DEFAULT_REPO, dispatchUrl, githubHeaders } from "./dispatch.js";

export const DEFAULT_PROJECT_PROMPT_WORKFLOW = "project-prompt.yml";
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
  return `Не удалось запустить project-prompt: GitHub ответил ${status}. Проверьте GH_DISPATCH_TOKEN и workflow project-prompt.yml в main.`;
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
