// Admin notice when a Telemost Actions run starts. Dedupe by run id in KV.
import { ADMIN_CHAT_ID, adminChatIds } from "../scripts/admin_status.mjs";

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
  if (name === "login") return "вход в Яндекс (/login)";
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

function notifyTargets(value) {
  if (Array.isArray(value)) {
    const ids = value.map((id) => String(id).trim()).filter((id) => /^[0-9]{1,16}$/.test(id));
    return ids.length ? [...new Set(ids)] : [ADMIN_CHAT_ID];
  }
  return adminChatIds(value);
}

// A legacy KV value is an ISO timestamp from the single-admin sender.
// Treat that as "every admin for this run was already told" so a retry does not
// duplicate the original chat. A JSON list is the set already notified.
function notifiedChats(raw, ids) {
  if (!raw) return new Set();
  try {
    const parsed = JSON.parse(raw);
    if (parsed && Array.isArray(parsed.chats)) return new Set(parsed.chats.map(String));
  } catch {
    // timestamp string
  }
  return new Set(ids);
}

export async function notifySessionStartOnce(kv, send, adminChatId, { runId, url, reason }) {
  const key = sessionNotifyKey(runId);
  if (!key || !kv || typeof send !== "function") return { sent: false, reason: "bad-input" };
  const ids = notifyTargets(adminChatId);
  const existing = await kv.get(key);
  const already = notifiedChats(existing, ids);
  const pending = ids.filter((id) => !already.has(id));
  if (existing && !pending.length) return { sent: false, reason: "duplicate" };
  const text = formatSessionStartMessage(url, reason);
  const sentTo = new Set(already);
  let fresh = 0;
  for (const chatId of pending) {
    try {
      await send(chatId, text);
      sentTo.add(chatId);
      fresh += 1;
    } catch {
      console.log("session notify skipped", chatId);
    }
  }
  if (!fresh && !sentTo.size) return { sent: false, reason: "send-failed" };
  const at = new Date().toISOString();
  await kv.put(key, JSON.stringify({ at, chats: [...sentTo] }));
  await kv.put(LIVE_SESSION_KEY, encodeLiveSession({ runId, url, at }));
  return { sent: fresh > 0, reason: fresh ? "ok" : "duplicate", chats: [...sentTo] };
}

export function progressBaseUrl(progressUrl) {
  return String(progressUrl || "").replace(/\/progress\/?$/i, "");
}
