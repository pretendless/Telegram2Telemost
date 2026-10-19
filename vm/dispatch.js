// Telegram /login, /connect, /upload and /restart → GitHub workflow_dispatch.
// No Node builtins: the Cloudflare Worker in PR #2 can import this file.

export const DEFAULT_REPO = "pretendless/Telegram2Telemost";
export const DEFAULT_WORKFLOW = "telemost-session.yml";
export const DEFAULT_REF = "main";

export const ACCOUNT_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;

export function parseVmCommand(text) {
  const trimmed = String(text || "").trim();
  const match = trimmed.match(/^\/(login|connect)(?:@[A-Za-z0-9_]+)?(?:\s+([\s\S]*))?$/i);
  if (!match) return null;
  const rest = (match[2] || "").trim().split(/\s+/).filter(Boolean);
  if (rest.length > 1) return { error: "label" };
  const account = rest[0] || "default";
  if (!ACCOUNT_RE.test(account)) return { error: "label" };
  return { mode: "login", account, packs: "" };
}

export function allowedChat(chatId, allowlist) {
  const id = String(chatId ?? "");
  if (!/^-?[0-9]{1,16}$/.test(id)) return false;
  const items = String(allowlist || "")
    .split(/[\s,]+/)
    .filter(Boolean);
  return items.includes(id);
}

export function dispatchUrl(repo, workflow) {
  const parts = String(repo || "").split("/");
  if (parts.length !== 2) throw new Error("repo");
  const [owner, name] = parts;
  if (!/^[A-Za-z0-9_.-]+$/.test(owner) || !/^[A-Za-z0-9_.-]+$/.test(name)) throw new Error("repo");
  if (!/^[A-Za-z0-9_.-]+\.ya?ml$/.test(workflow || "")) throw new Error("workflow");
  return `https://api.github.com/repos/${owner}/${name}/actions/workflows/${workflow}/dispatches`;
}

export function assertRef(ref) {
  const value = String(ref || "");
  if (!/^[A-Za-z0-9._/-]{1,200}$/.test(value) || value.includes("..") || value.startsWith("-")) {
    throw new Error("ref");
  }
  return value;
}

export function buildDispatch({ repo, workflow, ref, mode, account, chatId, packs, dispatchReason }) {
  if (!ACCOUNT_RE.test(account)) throw new Error("account");
  if (mode !== "login" && mode !== "upload" && mode !== "restart") throw new Error("mode");
  const reason = dispatchReason == null ? "" : String(dispatchReason).replace(/[\r\n]+/g, " ").trim().slice(0, 200);
  return {
    url: dispatchUrl(repo, workflow),
    body: {
      ref: assertRef(ref),
      inputs: {
        mode,
        account,
        chat_id: chatId == null ? "" : String(chatId),
        packs: packs || "",
        dispatch_reason: reason,
      },
    },
  };
}

export function githubHeaders(token) {
  return {
    authorization: `Bearer ${token}`,
    accept: "application/vnd.github+json",
    "content-type": "application/json",
    "user-agent": "tg2tm-login",
    "x-github-api-version": "2022-11-28",
  };
}

export async function dispatchWorkflow(fetchImpl, { token, repo, workflow, ref, mode, account, chatId, packs, dispatchReason }) {
  const built = buildDispatch({ repo, workflow, ref, mode, account, chatId, packs, dispatchReason });
  const res = await fetchImpl(built.url, {
    method: "POST",
    headers: githubHeaders(token),
    body: JSON.stringify(built.body),
  });
  return { ok: res.status === 204, status: res.status };
}

const ACTIVE_RUN = new Set(["queued", "in_progress", "waiting", "requested", "pending"]);

export function activeWorkflowRuns(payload) {
  return ((payload && payload.workflow_runs) || []).filter((run) => run && ACTIVE_RUN.has(run.status) && /^[0-9]+$/.test(String(run.id)));
}

export function workflowRunsUrl(repo, workflow) {
  return dispatchUrl(repo, workflow).replace(/\/dispatches$/, "/runs?per_page=20");
}

export function cancelRunUrl(repo, runId) {
  if (!/^[0-9]{1,12}$/.test(String(runId))) throw new Error("run");
  const [owner, name] = String(repo || "").split("/");
  return `https://api.github.com/repos/${owner}/${name}/actions/runs/${runId}/cancel`;
}

async function readBody(response) {
  if (!response || typeof response.json !== "function") return {};
  try {
    return await response.json();
  } catch {
    return {};
  }
}

// Dispatch one restart from main, then cancel the runs that were already active.
// If GitHub refuses the dispatch, the current upload stays.
export async function restartWorkflow(fetchImpl, { token, repo, workflow, ref, chatId, sleep, now, dispatchReason } = {}) {
  const headers = githubHeaders(token);
  const listUrl = workflowRunsUrl(repo, workflow);
  const startedAt = typeof now === "function" ? now() : Date.now();
  const listed = async () => {
    const response = await fetchImpl(listUrl, { headers });
    const body = await readBody(response);
    return { status: response && response.status, runs: activeWorkflowRuns(body), all: body.workflow_runs || [] };
  };
  const page = await listed();
  if (page.status !== 200) return { ok: false, reason: "list", status: page.status };
  const previous = page.runs.map((run) => run.id);
  const dispatched = await dispatchWorkflow(fetchImpl, {
    token,
    repo,
    workflow,
    ref,
    mode: "restart",
    account: "default",
    chatId,
    packs: "",
    dispatchReason: dispatchReason || "админ: /restart",
  });
  if (!dispatched.ok) return { ok: false, reason: "dispatch", status: dispatched.status };
  for (const id of previous) {
    await fetchImpl(cancelRunUrl(repo, id), { method: "POST", headers });
  }
  let url = "";
  for (let attempt = 0; attempt < 5 && !url; attempt++) {
    if (sleep && attempt) await sleep(1000);
    const again = await listed();
    const fresh = (again.all || []).find((run) => Date.parse(run.created_at) >= startedAt - 15000 && run.html_url);
    if (fresh) url = fresh.html_url;
  }
  return { ok: true, url };
}
