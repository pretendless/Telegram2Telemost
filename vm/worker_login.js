// Hook for the Cloudflare Worker (PR #2, worker/src/index.js).
// Import from worker/src/index.js:
//   import { handleVmCommand } from "../../vm/worker_login.js";
// In answer(), before the unknown-command return:
//   } else if (cmd === "/login" || cmd === "/connect") {
//     await handleVmCommand(env, message, { send });
//     return;
//   } else if (cmd) {
//     return;
//   }
// Secrets read from env: GH_DISPATCH_TOKEN, LOGIN_CHAT_IDS.
// Optional: GH_REPO, TELEMOST_WORKFLOW, TELEMOST_VM_REF.

import { ADMIN_CHAT_ID, isAdminChat } from "../scripts/admin_status.mjs";
import {
  DEFAULT_REF,
  DEFAULT_REPO,
  DEFAULT_WORKFLOW,
  allowedChat,
  dispatchWorkflow,
  parseVmCommand,
  restartWorkflow,
} from "./dispatch.js";
import { adminRestartReason } from "./dispatch_reason.js";

export function usageText() {
  return "Метка аккаунта: латиница, цифры и дефис, до 32 символов. Пример: /login work";
}

export function startedText(parsed) {
  return `Запускаю браузер для аккаунта «${parsed.account}». QR-код Яндекса придёт в этот чат. Если кода не будет, пришлю ссылку на экран. Ссылка на Actions — отдельным сообщением.`;
}

export function githubFailText(status) {
  return `Не удалось запустить браузер: GitHub ответил ${status}. Workflow telemost-session.yml должен лежать в ветке по умолчанию.`;
}

export function restartReply({ ok, url, reason, status }) {
  if (ok && url) {
    return "Останавливаю текущую загрузку и запускаю одну новую с main. Если в Телемосте открыт набор, он будет закрыт через /done и начат заново со своего первого стикера. Если диалог пуст — следующий запрос из очереди. Ссылка на Actions — отдельным сообщением.";
  }
  if (ok) return "Запуск принят. Ссылка на Actions придёт отдельным сообщением. Второй запуск не создаю.";
  if (reason === "still-running") {
    return "Текущий запуск ещё не остановился. Новый не стартую, чтобы не открыть второй браузер. Пришлите /restart ещё раз через минуту.";
  }
  return `Не удалось перезапустить: GitHub ответил ${status || reason || "error"}.`;
}

export async function handleRestart(env, message, deps = {}) {
  const send = deps.send;
  if (!send) throw new Error("send");
  const chatId = message && message.chat && message.chat.id;
  if (!isAdminChat(chatId, (env && env.LOGIN_CHAT_IDS) || ADMIN_CHAT_ID)) {
    await send(env, chatId, "Эта команда только для администратора.");
    return true;
  }
  if (!env || !env.GH_DISPATCH_TOKEN) {
    await send(env, chatId, "Перезапуск не настроен: нет секрета GH_DISPATCH_TOKEN.");
    return true;
  }
  const fetchImpl = deps.fetch || fetch;
  let queue = { priority: [], items: [] };
  if (typeof deps.getQueue === "function") {
    try {
      queue = await deps.getQueue();
    } catch {
      queue = { priority: [], items: [] };
    }
  }
  let result;
  try {
    result = await restartWorkflow(fetchImpl, {
      token: env.GH_DISPATCH_TOKEN,
      repo: env.GH_REPO || DEFAULT_REPO,
      workflow: env.TELEMOST_WORKFLOW || DEFAULT_WORKFLOW,
      ref: DEFAULT_REF,
      chatId,
      sleep: deps.sleep,
      dispatchReason: adminRestartReason(queue),
    });
  } catch (err) {
    console.error("restart failed", err && err.message);
    result = { ok: false, reason: "error" };
  }
  const text = restartReply(result);
  if (text.includes(String(env.GH_DISPATCH_TOKEN))) {
    await send(env, chatId, "Не удалось перезапустить.");
    return true;
  }
  await send(env, chatId, text);
  return true;
}

export async function handleVmCommand(env, message, deps = {}) {
  const parsed = parseVmCommand(message && message.text);
  if (!parsed) return false;
  const send = deps.send;
  if (!send) throw new Error("send");
  const chatId = message.chat && message.chat.id;
  if (!allowedChat(chatId, env && env.LOGIN_CHAT_IDS)) {
    await send(env, chatId, "Эта команда только для владельца.");
    return true;
  }
  if (parsed.error) {
    await send(env, chatId, usageText(parsed.error));
    return true;
  }
  if (!env.GH_DISPATCH_TOKEN) {
    await send(env, chatId, "Вход не настроен: нет секрета GH_DISPATCH_TOKEN.");
    return true;
  }
  const fetchImpl = deps.fetch || fetch;
  let result;
  try {
    const dispatchReason = "админ: /login";
    result = await dispatchWorkflow(fetchImpl, {
      token: env.GH_DISPATCH_TOKEN,
      repo: env.GH_REPO || DEFAULT_REPO,
      workflow: env.TELEMOST_WORKFLOW || DEFAULT_WORKFLOW,
      ref: env.TELEMOST_VM_REF || DEFAULT_REF,
      mode: parsed.mode,
      account: parsed.account,
      chatId,
      packs: parsed.packs,
      dispatchReason,
    });
  } catch (err) {
    console.error("dispatch failed", err && err.message);
    await send(env, chatId, githubFailText("error"));
    return true;
  }
  await send(env, chatId, result.ok ? startedText(parsed) : githubFailText(result.status));
  return true;
}
