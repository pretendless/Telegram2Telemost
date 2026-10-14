// Telegram Bot API fetch with optional corporate HTTP proxy (PROXY_HOST).
import { fetch as undiciFetch, ProxyAgent } from "undici";

const HOST = /^(?:(?:https?|socks5h?):\/\/)?[A-Za-z0-9._-]+:[0-9]{2,5}$/;

/** @returns {string} Proxy URI for undici ProxyAgent, or "" when proxy is off. */
export function buildProxyUrl(env = process.env) {
  const host = String((env && env.PROXY_HOST) || "").trim();
  if (!host) return "";
  if (!HOST.test(host)) throw new Error("proxy host");
  const login = String((env && env.PROXY_LOGIN) || "").trim();
  const password = String((env && env.PROXY_PASSWORD) || "").trim();
  const base = /^[a-z][a-z0-9+.-]*:\/\//i.test(host) ? host : `http://${host}`;
  if (!login && !password) return base;
  const url = new URL(base);
  if (login) url.username = login;
  if (password) url.password = password;
  let out = url.toString();
  if (out.endsWith("/") && url.pathname === "/") out = out.slice(0, -1);
  return out;
}

let cachedProxyUrl = "";
/** @type {ProxyAgent | undefined} */
let proxyAgent;

function dispatcherFor(env) {
  const proxyUrl = buildProxyUrl(env);
  if (!proxyUrl) return undefined;
  if (proxyUrl !== cachedProxyUrl) {
    cachedProxyUrl = proxyUrl;
    proxyAgent = new ProxyAgent(proxyUrl);
  }
  return proxyAgent;
}

/** fetch() to api.telegram.org; uses PROXY_HOST when set, else global fetch. */
export function telegramFetch(url, init = {}, env = process.env) {
  const dispatcher = dispatcherFor(env);
  if (!dispatcher) return globalThis.fetch(url, init);
  return undiciFetch(url, { ...init, dispatcher });
}
