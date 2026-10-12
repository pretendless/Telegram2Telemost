// Encrypted per-account Yandex cookie jar. Ciphertext may sit in a GitHub
// Actions artifact; the passphrase never does.
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";

export const MAGIC = Buffer.from("TG2TM1");
const SCRYPT = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

export function assertPassphrase(key) {
  if (typeof key !== "string") return false;
  const trimmed = key.trim();
  if (trimmed.length < 32 || trimmed.length > 512) return false;
  if (/^(secret|password|change-?me|telemost)$/i.test(trimmed)) return false;
  return true;
}

export function yandexHost(domain) {
  const host = String(domain || "")
    .replace(/^\./, "")
    .toLowerCase();
  if (!/^[a-z0-9.-]+$/.test(host)) return false;
  return (
    host === "yandex.ru" ||
    host.endsWith(".yandex.ru") ||
    host === "yandex.com" ||
    host.endsWith(".yandex.com") ||
    host === "yandex.net" ||
    host.endsWith(".yandex.net") ||
    host === "ya.ru" ||
    host.endsWith(".ya.ru")
  );
}

export function filterYandexCookies(cookies) {
  return (cookies || [])
    .filter((cookie) => cookie && yandexHost(cookie.domain) && cookie.name && cookie.value != null)
    .map((cookie) => ({
      name: String(cookie.name).slice(0, 200),
      value: String(cookie.value),
      domain: String(cookie.domain).slice(0, 200),
      path: String(cookie.path || "/").slice(0, 200),
      secure: Boolean(cookie.secure),
      httpOnly: Boolean(cookie.httpOnly),
      sameSite: ["Strict", "Lax", "None"].includes(cookie.sameSite) ? cookie.sameSite : "Lax",
      expires: Number.isFinite(Number(cookie.expires)) ? Number(cookie.expires) : -1,
    }))
    .filter((cookie) => cookie.value.length > 0 && cookie.value.length < 8000);
}

export function cookieNames(cookies) {
  return filterYandexCookies(cookies)
    .map((cookie) => cookie.name)
    .sort();
}

export function isLoggedIn(cookies) {
  const kept = filterYandexCookies(cookies);
  const session = kept.find((cookie) => cookie.name === "Session_id" && cookie.value.length >= 16);
  return Boolean(session) && kept.some((cookie) => cookie.name === "sessionid2");
}

export function cdpCookie(cookie) {
  const out = {
    name: cookie.name,
    value: cookie.value,
    domain: cookie.domain,
    path: cookie.path || "/",
    secure: Boolean(cookie.secure),
    httpOnly: Boolean(cookie.httpOnly),
    sameSite: cookie.sameSite || "Lax",
  };
  if (cookie.expires > 0) out.expires = cookie.expires;
  return out;
}

export function safeOrigin(origin) {
  let url;
  try {
    url = new URL(origin);
  } catch {
    return "";
  }
  if (url.protocol !== "https:" || url.username || url.password) return "";
  if (!yandexHost(url.hostname)) return "";
  return url.origin;
}

function derive(passphrase, salt) {
  return scryptSync(passphrase, salt, 32, SCRYPT);
}

export function encryptSession(bundle, passphrase) {
  if (!assertPassphrase(passphrase)) throw new Error("session key");
  if (!bundle || bundle.v !== 1 || !Array.isArray(bundle.cookies)) throw new Error("bundle");
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", derive(passphrase, salt), iv);
  const enc = Buffer.concat([cipher.update(JSON.stringify(bundle), "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([MAGIC, salt, iv, tag, enc]);
}

export function decryptSession(bytes, passphrase) {
  if (!assertPassphrase(passphrase)) throw new Error("session key");
  const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  if (buf.length < MAGIC.length + 16 + 12 + 16 + 1 || !buf.subarray(0, MAGIC.length).equals(MAGIC)) {
    throw new Error("not a session file");
  }
  const salt = buf.subarray(6, 22);
  const iv = buf.subarray(22, 34);
  const tag = buf.subarray(34, 50);
  const enc = buf.subarray(50);
  const decipher = createDecipheriv("aes-256-gcm", derive(passphrase, salt), iv);
  decipher.setAuthTag(tag);
  let plain;
  try {
    plain = Buffer.concat([decipher.update(enc), decipher.final()]);
  } catch {
    throw new Error("session key does not match");
  }
  let bundle;
  try {
    bundle = JSON.parse(plain.toString("utf8"));
  } catch {
    throw new Error("bad session");
  }
  if (!bundle || bundle.v !== 1 || !Array.isArray(bundle.cookies)) throw new Error("bad session");
  bundle.cookies = filterYandexCookies(bundle.cookies);
  return bundle;
}
