import { isAdminChat } from "../../scripts/admin_status.mjs";
import {
  DEFAULT_PROJECT_PROMPT_WORKFLOW,
  dispatchProjectPrompt,
  findProjectPromptRunUrl,
  newPromptId,
  parseProjectCommand,
  optionalProjectIssueWorkflow,
  projectAckText,
  projectDispatchFailText,
  projectDispatchedText,
  projectMirrorText,
  projectPromptKey,
  projectStartingText,
  projectUsageText,
} from "../../vm/project_prompt.js";
import { DEFAULT_REF, DEFAULT_REPO } from "../../vm/dispatch.js";

export async function storeProjectPrompt(kv, record) {
  await kv.put(projectPromptKey(record.id), JSON.stringify(record));
}

export async function readProjectPrompt(kv, id) {
  const raw = await kv.get(projectPromptKey(id));
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export async function finishProjectPromptDispatch(env, { record, chatId, deps = {} }) {
  const kv = env.BOT_KV;
  const send = deps.send;
  const fetchImpl = deps.fetch || fetch;
  const repo = env.GH_REPO || DEFAULT_REPO;
  const workflow = env.PROJECT_PROMPT_WORKFLOW || DEFAULT_PROJECT_PROMPT_WORKFLOW;
  const ref = env.PROJECT_PROMPT_REF || DEFAULT_REF;
  const startedAt = typeof deps.now === "function" ? deps.now().getTime() : Date.now();
  let dispatched;
  try {
    dispatched = await dispatchProjectPrompt(fetchImpl, {
      token: env.GH_DISPATCH_TOKEN,
      repo,
      workflow,
      ref,
      promptId: record.id,
      chatId,
    });
  } catch (err) {
    console.error("project dispatch failed", err && err.message);
    dispatched = { ok: false, status: 0 };
  }
  if (!dispatched.ok) {
    record.status = "error";
    record.error = `dispatch ${dispatched.status || "error"}`;
    await storeProjectPrompt(kv, record);
    if (send) await send(env, chatId, projectDispatchFailText(dispatched.status || "error"));
    return { ok: false };
  }
  const issueWorkflow = optionalProjectIssueWorkflow(env.PROJECT_ALSO_CREATE_ISSUE);
  if (issueWorkflow && issueWorkflow !== workflow) {
    try {
      const issue = await dispatchProjectPrompt(fetchImpl, {
        token: env.GH_DISPATCH_TOKEN,
        repo,
        workflow: issueWorkflow,
        ref,
        promptId: record.id,
        chatId,
      });
      if (!issue.ok) console.error("optional project issue dispatch", issue.status);
    } catch (err) {
      console.error("optional project issue dispatch", err && err.message);
    }
  }
  record.status = "dispatched";
  let runUrl = "";
  try {
    runUrl = await findProjectPromptRunUrl(fetchImpl, {
      token: env.GH_DISPATCH_TOKEN,
      repo,
      workflow,
      startedAt,
      sleep: deps.sleep,
    });
  } catch (err) {
    console.error("project run lookup failed", err && err.message);
  }
  if (runUrl) record.workflowRunUrl = runUrl;
  await storeProjectPrompt(kv, record);
  if (send) await send(env, chatId, projectDispatchedText({ promptId: record.id, runUrl }));
  return { ok: true, runUrl };
}

export async function handleProjectCommand(env, message, deps = {}) {
  const parsed = parseProjectCommand(message && message.text);
  if (!parsed) return false;
  const send = deps.send;
  if (!send) throw new Error("send");
  const chatId = message.chat && message.chat.id;
  if (!isAdminChat(chatId, env.LOGIN_CHAT_IDS)) {
    await send(env, chatId, "Эта команда только для администратора.");
    return true;
  }
  if (parsed.error) {
    await send(env, chatId, projectUsageText(parsed.error));
    return true;
  }
  if (!env.GH_DISPATCH_TOKEN) {
    await send(env, chatId, "Запрос к проекту не настроен: нет секрета GH_DISPATCH_TOKEN.");
    return true;
  }
  const kv = env.BOT_KV;
  if (!kv) {
    await send(env, chatId, "KV недоступен — запрос не сохранён.");
    return true;
  }
  const id = newPromptId(deps.now);
  const createdAt = typeof deps.now === "function" ? deps.now().toISOString() : new Date().toISOString();
  const record = {
    id,
    chatId: String(chatId),
    prompt: parsed.prompt,
    status: "pending",
    createdAt,
  };
  await send(env, chatId, projectAckText(id));
  await send(env, chatId, projectMirrorText(parsed.prompt));
  await send(env, chatId, projectStartingText());

  const background = async () => {
    await storeProjectPrompt(kv, record);
    await finishProjectPromptDispatch(env, { record, chatId, deps: { ...deps, send } });
  };

  if (deps.waitUntil) {
    deps.waitUntil(background());
    return true;
  }
  await background();
  return true;
}

export async function applyProjectReply(env, reply, deps = {}) {
  const kv = env.BOT_KV;
  if (!kv) return { ok: false, status: 503, error: "no kv" };
  const record = await readProjectPrompt(kv, reply.id);
  if (!record) return { ok: false, status: 404, error: "unknown prompt" };
  const chatId = Number(reply.chatId || record.chatId);
  if (!Number.isSafeInteger(chatId)) return { ok: false, status: 400, error: "chatId" };
  const send = deps.sendMessage || deps.send;
  if (!send) return { ok: false, status: 503, error: "no send" };
  const head = `Ответ по запросу ${record.id}:`;
  const text = `${head}\n\n${reply.summary}`;
  await send(env, chatId, text);
  record.status = "done";
  record.summary = reply.summary;
  record.completedAt = typeof deps.now === "function" ? deps.now().toISOString() : new Date().toISOString();
  if (reply.issueUrl) record.issueUrl = reply.issueUrl;
  await storeProjectPrompt(kv, record);
  return { ok: true, status: 200, chatId: String(chatId) };
}
