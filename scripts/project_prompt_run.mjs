// GitHub Actions: load /project prompt from Worker KV; fast TG ack; issue files for gh.
import { writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import {
  cursorAgentIssueHint,
  projectFastAckSummary,
  projectIssueTitle,
} from "../vm/project_prompt.js";

const progressUrl = String(process.env.TG2TM_PROGRESS_URL || "").trim();
const workerBase = progressUrl.replace(/\/progress\/?$/i, "");
const secret = process.env.UPLOADER_SECRET || "";
const promptId = String(process.env.PROMPT_ID || process.env.INPUT_PROMPT_ID || "").trim();
const chatId = String(process.env.CHAT_ID || process.env.INPUT_CHAT_ID || "").trim();
const runUrl = String(process.env.RUN_URL || "").trim();
const mode = String(process.env.PROJECT_PROMPT_MODE || "issue").trim().toLowerCase();
const repo = String(process.env.GITHUB_REPOSITORY || "pretendless/tg2tm").trim();

export function workerBaseFromProgressUrl(url) {
  return String(url || "").trim().replace(/\/progress\/?$/i, "");
}

export function missingWorkerConfigError({ progressUrl, secret, promptId }) {
  const url = String(progressUrl || "").trim();
  const bearer = String(secret || "").trim();
  const id = String(promptId || "").trim();
  if (!url) {
    return (
      "TG2TM_PROGRESS_URL is empty: set GitHub repo secret TG2TM_PROGRESS_URL to the worker progress endpoint " +
      "(for example https://tg2tmbot.prtndz.workers.dev/progress). " +
      "project-prompt uses the same base URL as telemost-session (script strips /progress for GET /project/prompt)."
    );
  }
  if (!bearer) return "UPLOADER_SECRET is empty: set GitHub repo secret UPLOADER_SECRET to match the worker.";
  if (!id) return "PROMPT_ID is empty: workflow must pass prompt_id from Worker KV.";
  return "";
}

export async function fetchPromptFromWorker({ workerBase: base, secret: bearer, promptId: id, progressUrl } = {}) {
  const cfgErr = missingWorkerConfigError({
    progressUrl: progressUrl ?? (base ? `${base}/progress` : ""),
    secret: bearer,
    promptId: id,
  });
  if (cfgErr) throw new Error(cfgErr);
  if (!base || !bearer || !id) {
    throw new Error("missing worker url, secret, or prompt id");
  }
  const url = `${base}/project/prompt?id=${encodeURIComponent(id)}`;
  const res = await fetch(url, {
    headers: { authorization: `Bearer ${bearer}`, "user-agent": "tg2tm-project-prompt" },
  });
  if (!res.ok) throw new Error(`worker prompt http ${res.status}`);
  const body = await res.json();
  if (!body.ok || !body.prompt) throw new Error("prompt missing in worker");
  return body;
}

export async function postProjectReply({ workerBase: base, secret: bearer, promptId: id, chatId: cid, summary, issueUrl }) {
  if (!base || !bearer || !id || !summary) {
    throw new Error("missing worker reply params");
  }
  const res = await fetch(`${base}/project/reply`, {
    method: "POST",
    headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json" },
    body: JSON.stringify({
      id,
      chatId: cid || undefined,
      summary,
      issueUrl: issueUrl || undefined,
    }),
  });
  if (!res.ok) throw new Error(`worker reply http ${res.status}`);
}

export function issueTitle(prompt) {
  return projectIssueTitle(prompt, 60);
}

export function issueBody({ prompt, promptId: id, chatId: cid, runUrl: workflowRun, issueUrl }) {
  const promptBlock = String(prompt || "").trim();
  return [
    "Запрос из Telegram `/project` (Telegram2Telemost).",
    "",
    `**prompt id:** \`${id}\``,
    cid ? `**admin chat:** \`${cid}\`` : "",
    workflowRun ? `**workflow run:** ${workflowRun}` : "",
    issueUrl ? `**issue:** ${issueUrl}` : "",
    "",
    "## PROMPT_FOR_PROJECT",
    "",
    "```text",
    promptBlock,
    "```",
    "",
    cursorAgentIssueHint(repo),
    "",
    "---",
    "",
    "Координатор Project или cloud agent обрабатывает текст и вызывает `POST /project/reply` с кратким ответом.",
  ]
    .filter(Boolean)
    .join("\n");
}

async function runFastAck(loaded) {
  const summary = projectFastAckSummary(loaded.prompt);
  await postProjectReply({
    workerBase,
    secret,
    promptId,
    chatId: chatId || loaded.chatId,
    summary,
  });
}

async function runIssueFiles(loaded) {
  const title = issueTitle(loaded.prompt);
  const body = issueBody({
    prompt: loaded.prompt,
    promptId,
    chatId: chatId || loaded.chatId,
    runUrl,
  });
  writeFileSync("project-prompt-title.txt", title, "utf8");
  writeFileSync("project-prompt-body.md", body, "utf8");
  writeFileSync("project-prompt-for-project.txt", String(loaded.prompt || "").trim(), "utf8");
}

export function issueLinkReplySummary(issueUrl) {
  return issueUrl
    ? `Issue для Project: ${issueUrl}\n\nТекст запроса — в issue (блок PROMPT_FOR_PROJECT). Краткий итог пришлёт бот после POST /project/reply.`
    : "Issue создан; ссылка недоступна в этом шаге.";
}

async function runIssueNotify() {
  const issueUrl = String(process.env.ISSUE_URL || "").trim();
  await postProjectReply({
    workerBase,
    secret,
    promptId,
    chatId,
    summary: issueLinkReplySummary(issueUrl),
    issueUrl: issueUrl || undefined,
  });
}

async function main() {
  if (mode === "issue-notify") {
    const notifyErr = missingWorkerConfigError({ progressUrl, secret, promptId });
    if (notifyErr) throw new Error(notifyErr);
    await runIssueNotify();
    return;
  }
  const loaded = await fetchPromptFromWorker({ workerBase, secret, promptId, progressUrl });
  if (mode === "fast-ack" || mode === "ack") {
    await runFastAck(loaded);
    return;
  }
  if (mode === "issue") {
    await runIssueFiles(loaded);
    return;
  }
  throw new Error(`unknown PROJECT_PROMPT_MODE: ${mode}`);
}

const isCli = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isCli) {
  await main();
}
