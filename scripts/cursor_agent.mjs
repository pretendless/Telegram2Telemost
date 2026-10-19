// GitHub Actions: launch one Cursor Cloud Agent for a Telegram /project prompt and post a short reply.
// Never log CURSOR_API_KEY, Authorization, owner email, or response bodies.
import { pathToFileURL } from "node:url";
import {
  fetchPromptFromWorker,
  missingWorkerConfigError,
  postProjectReply,
  workerBaseFromProgressUrl,
} from "./project_prompt_run.mjs";

export const CURSOR_API_BASE = "https://api.cursor.com";
export const DEFAULT_REPO_URL = "https://github.com/pretendless/Telegram2Telemost";
export const DEFAULT_STARTING_REF = "main";
export const TERMINAL_RUN_STATUSES = Object.freeze(["FINISHED", "ERROR", "CANCELLED", "EXPIRED"]);
export const SUMMARY_MAX = 3900;
export const DEFAULT_POLL_INTERVAL_MS = 20_000;
export const DEFAULT_RATE_LIMIT_DELAY_MS = 30_000;
export const DEFAULT_POLL_BUDGET_MS = 40 * 60 * 1000;

export function isTerminalRunStatus(status) {
  return TERMINAL_RUN_STATUSES.includes(String(status || "").trim().toUpperCase());
}

export function clipTelegramSummary(text, max = SUMMARY_MAX) {
  const value = String(text || "").trim();
  if (value.length <= max) return value;
  return `${value.slice(0, Math.max(0, max - 1))}…`;
}

export function redactSecrets(text, secrets) {
  let out = String(text ?? "");
  const list = Array.isArray(secrets) ? secrets : [];
  for (const secret of list) {
    const value = String(secret ?? "");
    if (value.length < 8) continue;
    out = out.split(value).join("[redacted]");
  }
  return out;
}

export function composeAgentPrompt({ userPrompt, promptId, workerBase }) {
  const prompt = String(userPrompt || "").trim();
  const id = String(promptId || "").trim();
  const base = String(workerBase || "").replace(/\/$/, "");
  const lines = [
    "You are answering a Telegram /project request for https://github.com/pretendless/Telegram2Telemost.",
    "Write a short final reply (a few sentences). That text is copied into Telegram.",
    "Do not change repository files.",
    "Do not print API keys, bearer tokens, or Authorization headers.",
  ];
  if (id) lines.push(`Prompt id: ${id}`);
  if (base && id) {
    lines.push(
      `If the shell environment contains UPLOADER_SECRET, POST ${base}/project/reply`,
      `with header Authorization: Bearer $UPLOADER_SECRET and JSON {"id":"${id}","summary":"<short answer>"}.`,
      "Do not echo UPLOADER_SECRET. A GitHub Actions job also posts the result if you do not.",
    );
  }
  lines.push("", "User prompt:", prompt);
  return lines.join("\n");
}

/** OpenAPI CreateAgentRequest. `mode` is `plan` unless explicitly `agent`. */
export function buildCreateAgentRequest({
  text,
  repoUrl = DEFAULT_REPO_URL,
  startingRef = DEFAULT_STARTING_REF,
  mode = "plan",
  name,
} = {}) {
  const promptText = String(text || "").trim();
  if (!promptText) throw new Error("prompt text");
  const url = String(repoUrl || "").trim();
  const ref = String(startingRef || "").trim();
  if (!url || !ref) throw new Error("repo");
  const body = {
    prompt: { text: promptText },
    repos: [{ url, startingRef: ref }],
    autoCreatePR: false,
    workOnCurrentBranch: false,
    mode: mode === "agent" ? "agent" : "plan",
  };
  const display = String(name || "").trim();
  if (display) body.name = display.slice(0, 100);
  return body;
}

/** Session env for the agent. Drops empty values and names that start with CURSOR_. */
export function attachAgentEnvVars(request, envVars) {
  const source = envVars && typeof envVars === "object" ? envVars : {};
  const clean = {};
  for (const [key, value] of Object.entries(source)) {
    if (!key || key.startsWith("CURSOR_")) continue;
    const text = String(value ?? "");
    if (!text) continue;
    clean[key] = text;
  }
  if (Object.keys(clean).length === 0) return request;
  return { ...request, envVars: clean };
}

export function agentDisplayName(promptId) {
  const id = String(promptId || "").trim();
  return (id ? `tg ${id}` : "tg project").slice(0, 100);
}

export function readCreateAgentIds(body) {
  const agent = body && body.agent;
  const run = body && body.run;
  const agentId = agent && agent.id ? String(agent.id) : "";
  const runId = run && run.id ? String(run.id) : "";
  if (!agentId || !runId) throw new Error("create response missing ids");
  const agentUrl = agent.url ? String(agent.url) : `https://cursor.com/agents/${agentId}`;
  return { agentId, runId, agentUrl };
}

export function isAuthFailureStatus(status) {
  return status === 401 || status === 403;
}

export function authFailureSummary(status) {
  if (status === 401) {
    return "Cursor API не принял ключ (HTTP 401). Проверьте секрет CURSOR_API_KEY в GitHub Actions.";
  }
  if (status === 403) {
    return "Cursor API запретил запрос (HTTP 403). Нужен оплаченный план Cursor и доступ к репозиторию.";
  }
  if (status === 0) {
    return "Секрет CURSOR_API_KEY не задан в GitHub Actions.";
  }
  return `Cursor API ответил HTTP ${status}. Запуск Cloud Agent не начат.`;
}

export function summaryForTerminalRun({ status, result, agentUrl } = {}) {
  const st = String(status || "").trim().toUpperCase();
  const link = agentUrl ? String(agentUrl).trim() : "";
  const suffix = link ? `\n${link}` : "";
  if (st === "FINISHED") {
    const text = String(result || "").trim();
    if (text) return clipTelegramSummary(text);
    return clipTelegramSummary(`Cloud Agent завершил run без текста.${suffix}`);
  }
  if (st === "ERROR") return clipTelegramSummary(`Cloud Agent завершился с ошибкой.${suffix}`);
  if (st === "CANCELLED") return clipTelegramSummary(`Cloud Agent отменён.${suffix}`);
  if (st === "EXPIRED") return clipTelegramSummary(`Cloud Agent истёк по времени.${suffix}`);
  return clipTelegramSummary(`Cloud Agent остановился со статусом ${st || "unknown"}.${suffix}`);
}

export function stillRunningSummary(agentUrl) {
  const link = agentUrl ? `\n${agentUrl}` : "";
  return clipTelegramSummary(`Cloud Agent ещё выполняется. Итог придёт сюда, когда run завершится.${link}`);
}

export function pollGaveUpSummary({ sawRun, lastHttp, agentUrl } = {}) {
  if (sawRun) return stillRunningSummary(agentUrl);
  const code = lastHttp ? `HTTP ${lastHttp}` : "нет ответа";
  const link = agentUrl ? `\n${agentUrl}` : "";
  return clipTelegramSummary(`Не удалось прочитать статус Cloud Agent (${code}).${link}`);
}

/** Skip a second Telegram message when the agent already called /project/reply. */
export function shouldPostPolledSummary(promptStatus) {
  return String(promptStatus || "").trim().toLowerCase() !== "done";
}

export function nextPollDelayMs(
  httpStatus,
  { intervalMs = DEFAULT_POLL_INTERVAL_MS, rateLimitMs = DEFAULT_RATE_LIMIT_DELAY_MS } = {},
) {
  if (httpStatus === 429) return rateLimitMs;
  return intervalMs;
}

export function runPollUrl(agentId, runId) {
  return `${CURSOR_API_BASE}/v1/agents/${encodeURIComponent(agentId)}/runs/${encodeURIComponent(runId)}`;
}

function cursorHeaders(apiKey) {
  return {
    Authorization: `Bearer ${apiKey}`,
    Accept: "application/json",
  };
}

async function readJsonQuiet(response) {
  if (!response || typeof response.json !== "function") return null;
  try {
    return await response.json();
  } catch {
    return null;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function hasApiKeyName(body) {
  return Boolean(body && typeof body === "object" && !Array.isArray(body) && typeof body.apiKeyName === "string" && body.apiKeyName);
}

async function main() {
  const progressUrl = String(process.env.TG2TM_PROGRESS_URL || "").trim();
  const uploaderSecret = String(process.env.UPLOADER_SECRET || "");
  const promptId = String(process.env.PROMPT_ID || "").trim();
  const chatId = String(process.env.CHAT_ID || "").trim();
  const apiKey = String(process.env.CURSOR_API_KEY || "");
  const cfgErr = missingWorkerConfigError({ progressUrl, secret: uploaderSecret, promptId });
  if (cfgErr) throw new Error(cfgErr);
  const workerBase = workerBaseFromProgressUrl(progressUrl);
  const secrets = [apiKey, uploaderSecret];

  const reply = async (summary) => {
    const text = redactSecrets(clipTelegramSummary(summary), secrets);
    await postProjectReply({
      workerBase,
      secret: uploaderSecret,
      promptId,
      chatId,
      summary: text,
    });
  };

  if (!apiKey) {
    console.log("CURSOR_API_KEY is unset");
    await reply(authFailureSummary(0));
    process.exitCode = 1;
    return;
  }

  const loaded = await fetchPromptFromWorker({ workerBase, secret: uploaderSecret, promptId, progressUrl });
  const me = await fetch(`${CURSOR_API_BASE}/v1/me`, {
    method: "GET",
    redirect: "manual",
    headers: cursorHeaders(apiKey),
  });
  const meBody = await readJsonQuiet(me);
  console.log(`GET /v1/me status=${me.status} apiKeyName=${hasApiKeyName(meBody) ? "present" : "absent"}`);
  if (me.status !== 200) {
    await reply(authFailureSummary(me.status));
    process.exitCode = 1;
    return;
  }

  const prompt = composeAgentPrompt({
    userPrompt: loaded.prompt,
    promptId,
    workerBase,
  });
  const request = attachAgentEnvVars(
    buildCreateAgentRequest({
      text: prompt,
      repoUrl: process.env.CURSOR_REPO_URL || DEFAULT_REPO_URL,
      startingRef: process.env.CURSOR_STARTING_REF || DEFAULT_STARTING_REF,
      mode: process.env.CURSOR_AGENT_MODE || "plan",
      name: agentDisplayName(promptId),
    }),
    {
      UPLOADER_SECRET: uploaderSecret,
      TG2TM_WORKER_BASE: workerBase,
    },
  );
  const created = await fetch(`${CURSOR_API_BASE}/v1/agents`, {
    method: "POST",
    redirect: "manual",
    headers: { ...cursorHeaders(apiKey), "Content-Type": "application/json" },
    body: JSON.stringify(request),
  });
  const createdBody = await readJsonQuiet(created);
  console.log(`POST /v1/agents status=${created.status}`);
  if (created.status !== 201) {
    await reply(authFailureSummary(created.status));
    process.exitCode = 1;
    return;
  }

  let ids;
  try {
    ids = readCreateAgentIds(createdBody);
  } catch {
    await reply("Cursor API не вернул id агента. Запуск не отслеживается.");
    process.exitCode = 1;
    return;
  }
  console.log(`agent=${ids.agentId} run=${ids.runId}`);

  const budget = Number(process.env.CURSOR_POLL_BUDGET_MS || DEFAULT_POLL_BUDGET_MS);
  const started = Date.now();
  let sawRun = false;
  let lastHttp = 0;
  while (Date.now() - started < budget) {
    const res = await fetch(runPollUrl(ids.agentId, ids.runId), {
      method: "GET",
      redirect: "manual",
      headers: cursorHeaders(apiKey),
    });
    const body = await readJsonQuiet(res);
    const runStatus = body && body.status ? String(body.status) : "";
    lastHttp = res.status;
    if (res.status === 200) sawRun = true;
    console.log(`GET run status_http=${res.status} run=${runStatus || "unknown"}`);
    if (isAuthFailureStatus(res.status)) {
      await reply(authFailureSummary(res.status));
      process.exitCode = 1;
      return;
    }
    if (res.status === 200 && isTerminalRunStatus(runStatus)) {
      let promptStatus = "";
      try {
        const again = await fetchPromptFromWorker({ workerBase, secret: uploaderSecret, promptId, progressUrl });
        promptStatus = again && again.status;
      } catch (err) {
        console.log(`prompt status refresh failed: ${err && err.message ? err.message : "error"}`);
      }
      if (shouldPostPolledSummary(promptStatus)) {
        await reply(summaryForTerminalRun({ status: runStatus, result: body && body.result, agentUrl: ids.agentUrl }));
      } else {
        console.log("prompt already done; skip duplicate Telegram reply");
      }
      if (runStatus !== "FINISHED") process.exitCode = 1;
      return;
    }
    const wait = nextPollDelayMs(res.status);
    if (Date.now() - started + wait >= budget) break;
    await sleep(wait);
  }

  await reply(pollGaveUpSummary({ sawRun, lastHttp, agentUrl: ids.agentUrl }));
  process.exitCode = 1;
}

const isCli = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isCli) {
  await main();
}
