import { ADMIN_CHAT_ID, isAdminChat } from "../../scripts/admin_status.mjs";
import { DEFAULT_REF, DEFAULT_REPO } from "../../vm/dispatch.js";
import {
  dispatchGhrunWorkflow,
  findWorkflowRunUrl,
  ghrunAckText,
  ghrunDispatchFailText,
  ghrunDispatchedText,
  ghrunStartingText,
  ghrunUsageText,
  isWorkflowAllowed,
  parseGhrunCommand,
} from "../../vm/ghrun.js";

export async function finishGhrunDispatch(env, { workflow, inputs, chatId, deps = {} }) {
  const send = deps.send;
  const fetchImpl = deps.fetch || fetch;
  const repo = env.GH_REPO || DEFAULT_REPO;
  const ref = env.GH_GHRUN_REF || env.GHRUN_REF || DEFAULT_REF;
  const startedAt = typeof deps.now === "function" ? deps.now().getTime() : Date.now();
  let dispatched;
  try {
    dispatched = await dispatchGhrunWorkflow(fetchImpl, {
      token: env.GH_DISPATCH_TOKEN,
      repo,
      workflow,
      ref,
      inputs,
    });
  } catch (err) {
    console.error("ghrun dispatch failed", err && err.message);
    dispatched = { ok: false, status: 0 };
  }
  if (!dispatched.ok) {
    if (send) await send(env, chatId, ghrunDispatchFailText(workflow, dispatched.status || "error"));
    return { ok: false };
  }
  let runUrl = "";
  try {
    runUrl = await findWorkflowRunUrl(fetchImpl, {
      token: env.GH_DISPATCH_TOKEN,
      repo,
      workflow,
      startedAt,
      sleep: deps.sleep,
    });
  } catch (err) {
    console.error("ghrun run lookup failed", err && err.message);
  }
  if (send) await send(env, chatId, ghrunDispatchedText({ workflow, runUrl }));
  return { ok: true, runUrl };
}

export async function handleGhrunCommand(env, message, deps = {}) {
  const parsed = parseGhrunCommand(message && message.text);
  if (!parsed) return false;
  const send = deps.send;
  if (!send) throw new Error("send");
  const chatId = message.chat && message.chat.id;
  if (!isAdminChat(chatId, env.LOGIN_CHAT_IDS || ADMIN_CHAT_ID)) {
    await send(env, chatId, "Эта команда только для администратора.");
    return true;
  }
  if (parsed.error) {
    await send(env, chatId, ghrunUsageText(parsed.error));
    return true;
  }
  if (!env.GH_DISPATCH_TOKEN) {
    await send(env, chatId, "Запуск workflow не настроен: нет секрета GH_DISPATCH_TOKEN.");
    return true;
  }
  if (!isWorkflowAllowed(parsed.workflow, env.GH_WORKFLOW_ALLOWLIST)) {
    await send(env, chatId, ghrunUsageText("denied"));
    return true;
  }

  await send(env, chatId, ghrunAckText(parsed.workflow));
  await send(env, chatId, ghrunStartingText(parsed.workflow));

  const background = async () => {
    await finishGhrunDispatch(env, {
      workflow: parsed.workflow,
      inputs: parsed.inputs,
      chatId,
      deps: { ...deps, send },
    });
  };

  if (deps.waitUntil) {
    deps.waitUntil(background());
    return true;
  }
  await background();
  return true;
}
