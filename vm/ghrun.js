// Telegram /ghrun → arbitrary GitHub workflow_dispatch (Worker-safe).

import {
  assertRef,
  DEFAULT_REF,
  DEFAULT_REPO,
  dispatchUrl,
  githubHeaders,
  workflowRunsUrl,
} from "./dispatch.js";

/** Basename only — same rule as dispatchUrl (no path segments). */
export const WORKFLOW_BASENAME_RE = /^[A-Za-z0-9_.-]+\.ya?ml$/;

const INPUT_KEY_RE = /^[a-zA-Z0-9_-]{1,64}$/;
const INPUT_VALUE_MAX = 500;

export function parseWorkflowAllowlist(raw) {
  return String(raw || "")
    .split(/[\s,]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

export function normalizeWorkflowBasename(raw) {
  let name = String(raw || "").trim();
  if (!name) return { error: "empty" };
  if (name.includes("\\")) return { error: "path" };
  if (name.includes("..")) return { error: "path" };
  const lower = name.toLowerCase();
  if (lower.startsWith(".github/workflows/")) {
    name = name.slice(".github/workflows/".length);
  } else if (name.includes("/")) {
    return { error: "path" };
  }
  if (!WORKFLOW_BASENAME_RE.test(name)) return { error: "name" };
  return { workflow: name };
}

export function isWorkflowAllowed(workflow, allowlist) {
  const items = Array.isArray(allowlist) ? allowlist : parseWorkflowAllowlist(allowlist);
  if (!items.length) return true;
  const wf = String(workflow || "").trim();
  return items.some((item) => item === wf);
}

export function parseDispatchInputs(tokens) {
  const inputs = {};
  for (const token of tokens || []) {
    const piece = String(token || "").trim();
    if (!piece) continue;
    const eq = piece.indexOf("=");
    if (eq <= 0) return { error: "input", token: piece };
    const key = piece.slice(0, eq).trim();
    const value = piece.slice(eq + 1);
    if (!INPUT_KEY_RE.test(key)) return { error: "inputKey", token: piece };
    if (value.length > INPUT_VALUE_MAX) return { error: "inputLong", token: piece };
    inputs[key] = value;
  }
  return { inputs };
}

export function parseGhrunCommand(text) {
  const trimmed = String(text || "").trim();
  const match = trimmed.match(/^\/ghrun(?:@[A-Za-z0-9_]+)?(?:\s+([\s\S]*))?$/i);
  if (!match) return null;
  const rest = (match[1] || "").trim();
  if (!rest) return { error: "usage" };
  const parts = rest.split(/\s+/).filter(Boolean);
  if (!parts.length) return { error: "usage" };
  const wf = normalizeWorkflowBasename(parts[0]);
  if (wf.error) return { error: wf.error };
  const parsedInputs = parseDispatchInputs(parts.slice(1));
  if (parsedInputs.error) return { error: parsedInputs.error, token: parsedInputs.token };
  return { workflow: wf.workflow, inputs: parsedInputs.inputs };
}

export function buildGhrunDispatch({ repo, workflow, ref, inputs }) {
  const bodyInputs = inputs && typeof inputs === "object" && !Array.isArray(inputs) ? inputs : {};
  return {
    url: dispatchUrl(repo, workflow),
    body: {
      ref: assertRef(ref || DEFAULT_REF),
      inputs: bodyInputs,
    },
  };
}

export async function dispatchGhrunWorkflow(fetchImpl, { token, repo, workflow, ref, inputs }) {
  const built = buildGhrunDispatch({ repo, workflow, ref, inputs });
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

export async function findWorkflowRunUrl(fetchImpl, { token, repo, workflow, startedAt, sleep, attempts = 5 }) {
  const headers = githubHeaders(token);
  const listUrl = workflowRunsUrl(repo, workflow);
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

export function ghrunUsageText(error) {
  if (error === "usage" || error === "empty") {
    return (
      "Формат: /ghrun <workflow.yml> [ключ=значение …]\n\n" +
      "Пример: /ghrun setup-bot.yml\n" +
      "Пример: /ghrun check-cursor-api.yml\n" +
      "Пример: /ghrun project-prompt.yml prompt_id=tg-1 chat_id=8502935020"
    );
  }
  if (error === "path" || error === "name") {
    return "Укажите только имя файла из .github/workflows (например setup-bot.yml), без ../ и без полного пути.";
  }
  if (error === "denied") {
    return "Этот workflow не в списке GH_WORKFLOW_ALLOWLIST. Добавьте имя файла в wrangler.toml или снимите allowlist.";
  }
  if (error === "input" || error === "inputKey") {
    return "Не удалось разобрать параметр workflow. Каждый аргумент после имени файла — пара ключ=значение (латиница, цифры, _, -).";
  }
  if (error === "inputLong") {
    return `Значение параметра длиннее ${INPUT_VALUE_MAX} символов.`;
  }
  return "Не удалось разобрать команду /ghrun.";
}

export function ghrunStartingText(workflow) {
  return `⏳ Запускаю GitHub Actions (${workflow})…`;
}

export function ghrunAckText(workflow) {
  return `Запуск workflow «${workflow}» принят. Ссылка на run пришлю отдельным сообщением.`;
}

export function ghrunDispatchedText({ workflow, runUrl }) {
  if (runUrl) {
    return `✅ Workflow ${workflow} запущен.\n\n${runUrl}`;
  }
  return `✅ GitHub принял dispatch для ${workflow}. Ссылка на run может появиться с задержкой — смотрите Actions в репозитории.`;
}

export function ghrunDispatchFailText(workflow, status) {
  return `Не удалось запустить ${workflow}: GitHub ответил ${status}. Проверьте GH_DISPATCH_TOKEN, имя workflow и inputs.`;
}
