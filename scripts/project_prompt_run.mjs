// GitHub Actions: load /project prompt from Worker KV and prepare issue title/body files.
import { writeFileSync } from "node:fs";

const progressUrl = String(process.env.TG2TM_PROGRESS_URL || "").trim();
const workerBase = progressUrl.replace(/\/progress\/?$/i, "");
const secret = process.env.UPLOADER_SECRET || "";
const promptId = String(process.env.PROMPT_ID || process.env.INPUT_PROMPT_ID || "").trim();
const chatId = String(process.env.CHAT_ID || process.env.INPUT_CHAT_ID || "").trim();
const runUrl = String(process.env.RUN_URL || "").trim();

async function fetchPrompt() {
  if (!workerBase || !secret || !promptId) {
    throw new Error("missing worker url, secret, or prompt id");
  }
  const url = `${workerBase}/project/prompt?id=${encodeURIComponent(promptId)}`;
  const res = await fetch(url, {
    headers: { authorization: `Bearer ${secret}`, "user-agent": "tg2tm-project-prompt" },
  });
  if (!res.ok) throw new Error(`worker prompt http ${res.status}`);
  const body = await res.json();
  if (!body.ok || !body.prompt) throw new Error("prompt missing in worker");
  return body;
}

function issueTitle(prompt) {
  const one = String(prompt || "").replace(/\s+/g, " ").trim();
  const head = one.slice(0, 72);
  return `[TG /project] ${head}${one.length > 72 ? "…" : ""}`;
}

function issueBody({ prompt, promptId, chatId, runUrl }) {
  return [
    "Запрос из Telegram `/project` (Telegram2Telemost).",
    "",
    `**prompt id:** \`${promptId}\``,
    chatId ? `**admin chat:** \`${chatId}\`` : "",
    runUrl ? `**workflow run:** ${runUrl}` : "",
    "",
    "## Текст",
    "",
    prompt,
    "",
    "---",
    "",
    "Cursor Project не имеет публичного API из воркера: координатор Project или cloud agent обрабатывает текст и вызывает `POST /project/reply` с кратким ответом (см. docs в Project store).",
  ]
    .filter(Boolean)
    .join("\n");
}

async function main() {
  const loaded = await fetchPrompt();
  const title = issueTitle(loaded.prompt);
  const body = issueBody({
    prompt: loaded.prompt,
    promptId,
    chatId: chatId || loaded.chatId,
    runUrl,
  });
  writeFileSync("project-prompt-title.txt", title, "utf8");
  writeFileSync("project-prompt-body.md", body, "utf8");
}

await main();
