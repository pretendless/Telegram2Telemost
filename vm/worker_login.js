// Hook for the Cloudflare Worker (PR #2, worker/src/index.js).
// Import from worker/src/index.js:
//   import { handleVmCommand } from "../../vm/worker_login.js";
// In answer(), before the unknown-command return:
//   } else if (cmd === "/login" || cmd === "/connect" || cmd === "/upload") {
//     await handleVmCommand(env, message, { send });
//     return;
//   } else if (cmd) {
//     return;
//   }
// Secrets read from env: GH_DISPATCH_TOKEN, LOGIN_CHAT_IDS.
// Optional: GH_REPO, TELEMOST_WORKFLOW, TELEMOST_VM_REF.

import {
  DEFAULT_REF,
  DEFAULT_REPO,
  DEFAULT_WORKFLOW,
  allowedChat,
  dispatchWorkflow,
  parseVmCommand,
} from "./dispatch.js";

export function usageText(error) {
  if (error === "upload" || error === "packs") {
    return "Формат: /upload <метка> <номера паков>. Пример: /upload work 03 04";
  }
  return "Метка аккаунта: латиница, цифры и дефис, до 32 символов. Пример: /connect work";
}

export function startedText(parsed) {
  if (parsed.mode === "upload") {
    return `Запускаю загрузку (${parsed.packs}) аккаунтом «${parsed.account}». Нужна уже сохранённая сессия.`;
  }
  return `Запускаю браузер для аккаунта «${parsed.account}». QR-код Яндекса придёт в этот чат. Если кода не будет, пришлю ссылку на экран.`;
}

export function githubFailText(status) {
  return `Не удалось запустить браузер: GitHub ответил ${status}. Workflow telemost-session.yml должен лежать в ветке по умолчанию.`;
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
    result = await dispatchWorkflow(fetchImpl, {
      token: env.GH_DISPATCH_TOKEN,
      repo: env.GH_REPO || DEFAULT_REPO,
      workflow: env.TELEMOST_WORKFLOW || DEFAULT_WORKFLOW,
      ref: env.TELEMOST_VM_REF || DEFAULT_REF,
      mode: parsed.mode,
      account: parsed.account,
      chatId,
      packs: parsed.packs,
    });
  } catch (err) {
    console.error("dispatch failed", err && err.message);
    await send(env, chatId, githubFailText("error"));
    return true;
  }
  await send(env, chatId, result.ok ? startedText(parsed) : githubFailText(result.status));
  return true;
}
