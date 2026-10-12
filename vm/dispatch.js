// Telegram /login, /connect and /upload → GitHub workflow_dispatch.
// No Node builtins: the Cloudflare Worker in PR #2 can import this file.

export const DEFAULT_REPO = "pretendless/tg2tm";
export const DEFAULT_WORKFLOW = "telemost-session.yml";
export const DEFAULT_REF = "main";

export const ACCOUNT_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;

export function parseVmCommand(text) {
  const trimmed = String(text || "").trim();
  const match = trimmed.match(/^\/(login|connect|upload)(?:@[A-Za-z0-9_]+)?(?:\s+([\s\S]*))?$/i);
  if (!match) return null;
  const name = match[1].toLowerCase();
  const rest = (match[2] || "").trim().split(/\s+/).filter(Boolean);
  if (name === "login") {
    if (rest.length > 1) return { error: "label" };
    const account = rest[0] || "default";
    if (!ACCOUNT_RE.test(account)) return { error: "label" };
    return { mode: "login", account, packs: "" };
  }
  if (name === "connect") {
    if (rest.length !== 1 || !ACCOUNT_RE.test(rest[0])) return { error: "label" };
    return { mode: "login", account: rest[0], packs: "" };
  }
  if (rest.length < 2) return { error: "upload" };
  const account = rest[0];
  const packs = rest.slice(1);
  if (!ACCOUNT_RE.test(account)) return { error: "label" };
  if (!packs.every((pack) => /^[0-9]{2}$/.test(pack))) return { error: "packs" };
  return { mode: "upload", account, packs: packs.join(" ") };
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

export function buildDispatch({ repo, workflow, ref, mode, account, chatId, packs }) {
  if (!ACCOUNT_RE.test(account)) throw new Error("account");
  if (mode !== "login" && mode !== "upload") throw new Error("mode");
  return {
    url: dispatchUrl(repo, workflow),
    body: {
      ref: assertRef(ref),
      inputs: {
        mode,
        account,
        chat_id: chatId == null ? "" : String(chatId),
        packs: packs || "",
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

export async function dispatchWorkflow(fetchImpl, { token, repo, workflow, ref, mode, account, chatId, packs }) {
  const built = buildDispatch({ repo, workflow, ref, mode, account, chatId, packs });
  const res = await fetchImpl(built.url, {
    method: "POST",
    headers: githubHeaders(token),
    body: JSON.stringify(built.body),
  });
  return { ok: res.status === 204, status: res.status };
}
