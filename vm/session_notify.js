// Admin notice when a Telemost Actions run starts. Dedupe by run id in KV.
import { ADMIN_CHAT_ID } from "../scripts/admin_status.mjs";

export const SESSION_NOTIFY_PREFIX = "meta:session-notify:";

export function defaultSessionReason(mode) {
  const name = String(mode || "").trim().toLowerCase();
  if (name === "login") return "вход в Яндекс (/login или /connect)";
  if (name === "upload") return "ручная загрузка (/upload)";
  if (name === "finalize") return "завершение пака (finalize)";
  if (name === "restart") return "перезапуск Telemost (restart)";
  return name ? `режим ${name}` : "запуск workflow";
}

export function formatSessionStartMessage(url, reason) {
  const link = String(url || "").trim();
  const why = String(reason || "").trim() || "запуск workflow";
  const lines = ["Новый запуск Actions (Telemost).", "", `Причина: ${why}`];
  if (link) lines.push(link);
  return lines.join("\n");
}

export function sessionNotifyKey(runId) {
  const id = String(runId || "").trim();
  if (!/^[0-9]{1,16}$/.test(id)) return null;
  return `${SESSION_NOTIFY_PREFIX}${id}`;
}

export async function notifySessionStartOnce(kv, send, adminChatId, { runId, url, reason }) {
  const key = sessionNotifyKey(runId);
  if (!key || !kv || typeof send !== "function") return { sent: false, reason: "bad-input" };
  if (await kv.get(key)) return { sent: false, reason: "duplicate" };
  const chatId = String(adminChatId || ADMIN_CHAT_ID);
  await send(chatId, formatSessionStartMessage(url, reason));
  await kv.put(key, new Date().toISOString());
  return { sent: true, reason: "ok" };
}

export function progressBaseUrl(progressUrl) {
  return String(progressUrl || "").replace(/\/progress\/?$/i, "");
}
