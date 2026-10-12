// One-time browser link. Only https, never with a user or a password in the URL.

export function safePublicUrl(raw) {
  let url;
  try {
    url = new URL(String(raw || "").trim());
  } catch {
    return "";
  }
  if (url.protocol !== "https:" || url.username || url.password) return "";
  if (!/^[a-z0-9.-]+$/i.test(url.hostname) || url.hostname.length > 200) return "";
  return url.origin;
}

export function tunnelUrlFromLog(text) {
  const match = String(text || "").match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/i);
  return match ? safePublicUrl(match[0]) : "";
}

export function vncPage(origin) {
  const base = safePublicUrl(origin);
  if (!base) return "";
  return `${base}/vnc.html?autoconnect=1&resize=scale`;
}
