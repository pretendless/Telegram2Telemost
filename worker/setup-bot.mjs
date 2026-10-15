// Sets @tg2tmbot description, short description and command list.
// Token: TG2TMBOT_TOKEN or TELEGRAM_BOT_TOKEN.
// Admin menu: union of LOGIN_CHAT_IDS and worker/wrangler.toml (numeric chat ids only).
import { readFileSync } from "node:fs";
import { adminMenuChatIds } from "../scripts/admin_status.mjs";
import {
  ABOUT,
  ADMIN_COMMANDS,
  BOT_NAME,
  DESCRIPTION,
  USER_COMMANDS,
} from "./src/logic.js";
import { telegramFetch } from "./telegram_fetch.mjs";

function loginChatIdsFromWrangler() {
  const toml = readFileSync(new URL("./wrangler.toml", import.meta.url), "utf8");
  const match = toml.match(/^LOGIN_CHAT_IDS\s*=\s*"([^"]*)"/m);
  return match ? match[1] : "";
}

const token = process.env.TG2TMBOT_TOKEN || process.env.TELEGRAM_BOT_TOKEN;
if (!token) {
  console.error("Set TG2TMBOT_TOKEN or TELEGRAM_BOT_TOKEN.");
  process.exit(1);
}

async function call(method, params) {
  const res = await telegramFetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(params),
  });
  const body = await res.json();
  if (!body.ok) throw new Error(body.description || method);
}

await call("setMyName", { name: BOT_NAME });
await call("setMyDescription", { description: DESCRIPTION });
await call("setMyShortDescription", { short_description: ABOUT });
await call("setMyCommands", { commands: USER_COMMANDS });

const adminIds = adminMenuChatIds(process.env.LOGIN_CHAT_IDS, loginChatIdsFromWrangler());
for (const chatId of adminIds) {
  await call("setMyCommands", {
    commands: ADMIN_COMMANDS,
    scope: { type: "chat", chat_id: Number(chatId) },
  });
}

console.log(
  `description, about text and commands set (${USER_COMMANDS.length} default, admin menu for ${adminIds.length} chat(s))`,
);
