// Admin notice when a Telemost Actions run starts. Dedupe by run id in KV.
import { ADMIN_CHAT_ID } from "../scripts/admin_status.mjs";

export const SESSION_NOTIFY_PREFIX = "meta:session-notify:";
export const LIVE_SESSION_KEY = "meta:telemost-session";

export function encodeLiveSession({ runId, url, at }) {
  const link = String(url || "").trim();
  return JSON.stringify({
    runId: String(runId || "").trim(),
    url: /^https?:\/\//i.test(link) ? link.slice(0, 300) : "",
    at: String(at || new Date().toISOString()),
  });
}

export function readLiveSession(raw) {
  if (!raw) return null;
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const url = typeof parsed.url === "string" && /^https?:\/\//i.test(parsed.url) ? parsed.url : "";
  return { runId: String(parsed.runId || ""), url, at: typeof parsed.at === "string" ? parsed.at : "" };
}

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
  const at = new Date().toISOString();
  await send(chatId, formatSessionStartMessage(url, reason));
  await kv.put(key, at);
  await kv.put(LIVE_SESSION_KEY, encodeLiveSession({ runId, url, at }));
  return { sent: true, reason: "ok" };
}

export function progressBaseUrl(progressUrl) {
  return String(progressUrl || "").replace(/\/progress\/?$/i, "");
}
