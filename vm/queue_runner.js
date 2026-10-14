// Keep the Telemost workflow fed from the KV queue without admin /restart.
import { ADMIN_CHAT_ID } from "../scripts/admin_status.mjs";
import {
  DEFAULT_REF,
  DEFAULT_REPO,
  DEFAULT_WORKFLOW,
  activeWorkflowRuns,
  dispatchWorkflow,
  workflowRunsUrl,
  githubHeaders,
} from "./dispatch.js";
import { shouldStartPipeline } from "../worker/src/logic.js";
import { QUEUE_REASON, queuePipelineReason } from "./dispatch_reason.js";

async function readRuns(fetchImpl, listUrl, headers) {
  const response = await fetchImpl(listUrl, { headers });
  let body = {};
  try {
    body = await response.json();
  } catch {
    body = {};
  }
  return { status: response.status, runs: activeWorkflowRuns(body) };
}

export async function telemostRunActive(fetchImpl, env) {
  const token = env && env.GH_DISPATCH_TOKEN;
  if (!token) return false;
  const listUrl = workflowRunsUrl(env.GH_REPO || DEFAULT_REPO, env.TELEMOST_WORKFLOW || DEFAULT_WORKFLOW);
  const page = await readRuns(fetchImpl, listUrl, githubHeaders(token));
  return page.status === 200 && page.runs.length > 0;
}

export async function startPipelineIfIdle(fetchImpl, env, queue, { dispatchReason } = {}) {
  if (!shouldStartPipeline(queue, false)) return { started: false, reason: "empty" };
  const token = env && env.GH_DISPATCH_TOKEN;
  if (!token) return { started: false, reason: "no-token" };
  const listUrl = workflowRunsUrl(env.GH_REPO || DEFAULT_REPO, env.TELEMOST_WORKFLOW || DEFAULT_WORKFLOW);
  const page = await readRuns(fetchImpl, listUrl, githubHeaders(token));
  if (page.status !== 200) return { started: false, reason: "list", status: page.status };
  if (!shouldStartPipeline(queue, page.runs.length > 0)) {
    return { started: false, reason: page.runs.length ? "busy" : "empty" };
  }
  const chatId = String(env.TELEMOST_ADMIN_CHAT_ID || ADMIN_CHAT_ID);
  const reason = queuePipelineReason(dispatchReason || QUEUE_REASON.autostart, queue, {
    preferQueued: true,
  });
  const dispatched = await dispatchWorkflow(fetchImpl, {
    token,
    repo: env.GH_REPO || DEFAULT_REPO,
    workflow: env.TELEMOST_WORKFLOW || DEFAULT_WORKFLOW,
    ref: DEFAULT_REF,
    mode: "restart",
    account: "default",
    chatId,
    packs: "",
    dispatchReason: reason,
  });
  return { started: dispatched.ok, reason: dispatched.ok ? "dispatched" : "dispatch", status: dispatched.status };
}
