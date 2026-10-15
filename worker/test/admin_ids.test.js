import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { adminMenuChatIds } from "../../scripts/admin_status.mjs";

const EXISTING_ADMIN = "8502935020";
const ADDED_ADMIN = "5513343655";

function loginChatIdsFromWrangler(toml) {
  const match = String(toml).match(/^LOGIN_CHAT_IDS\s*=\s*"([^"]*)"/m);
  return match ? match[1] : "";
}

test("wrangler.toml and setup-bot list both admin chat ids", () => {
  const toml = readFileSync(new URL("../wrangler.toml", import.meta.url), "utf8");
  const workflow = readFileSync(new URL("../../.github/workflows/setup-bot.yml", import.meta.url), "utf8");
  const configured = loginChatIdsFromWrangler(toml);
  assert.deepEqual(adminMenuChatIds(configured), [EXISTING_ADMIN, ADDED_ADMIN]);
  assert.match(workflow, /8502935020,5513343655/);
  assert.deepEqual(adminMenuChatIds(EXISTING_ADMIN, configured), [EXISTING_ADMIN, ADDED_ADMIN]);
  assert.equal(adminMenuChatIds(configured).includes("424242"), false);
  assert.equal(adminMenuChatIds("not-a-chat-id", configured).includes("not-a-chat-id"), false);
});
