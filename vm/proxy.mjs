// A proxy is optional. Telemost is reached directly unless PROXY_HOST is set.
// Login and password are never required.
import { pathToFileURL } from "node:url";

const HOST = /^(?:(?:https?|socks5h?):\/\/)?[A-Za-z0-9._-]+:[0-9]{2,5}$/;

export function proxyFlag(env) {
  const host = String((env && env.PROXY_HOST) || "").trim();
  if (!host) return "";
  if (!HOST.test(host)) throw new Error("proxy host");
  return "--proxy-server=" + host;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.stdout.write(proxyFlag(process.env));
}
