// GitHub Actions: read-only Cursor API check. Never prints the key, Authorization, email, or body.
import { pathToFileURL } from "node:url";

export const ME_URL = "https://api.cursor.com/v1/me";
export const AGENTS_URL = "https://api.cursor.com/v1/agents?limit=1";

export function describeMeCheck(status, body) {
  const hasApiKeyName = Boolean(
    body &&
      typeof body === "object" &&
      !Array.isArray(body) &&
      typeof body.apiKeyName === "string" &&
      body.apiKeyName.length > 0,
  );
  return `GET /v1/me status=${Number(status)} apiKeyName=${hasApiKeyName ? "present" : "absent"}`;
}

export function describeAgentsCheck(status, body) {
  const hasItems = Boolean(body && typeof body === "object" && !Array.isArray(body) && Array.isArray(body.items));
  return `GET /v1/agents?limit=1 status=${Number(status)} items=${hasItems ? "present" : "absent"}`;
}

async function readJsonQuiet(response) {
  if (!response || typeof response.json !== "function") return null;
  try {
    return await response.json();
  } catch {
    return null;
  }
}

async function getCheck(url, apiKey) {
  const response = await fetch(url, {
    method: "GET",
    redirect: "manual",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      Accept: "application/json",
    },
  });
  const body = await readJsonQuiet(response);
  return { status: response.status, body };
}

async function main() {
  const apiKey = String(process.env.CURSOR_API_KEY || "");
  if (!apiKey) {
    console.log("CURSOR_API_KEY is unset");
    process.exitCode = 1;
    return;
  }
  const me = await getCheck(ME_URL, apiKey);
  console.log(describeMeCheck(me.status, me.body));
  const agents = await getCheck(AGENTS_URL, apiKey);
  console.log(describeAgentsCheck(agents.status, agents.body));
  if (me.status !== 200 || agents.status !== 200) process.exitCode = 1;
}

const isCli = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isCli) {
  await main();
}
