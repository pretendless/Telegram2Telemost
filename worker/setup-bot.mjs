// Sets @tg2tmbot description, short description and command list.
// Token: TG2TMBOT_TOKEN or TELEGRAM_BOT_TOKEN. Optional LOGIN_CHAT_IDS (comma-separated) for admin menu scope.
import { adminChatIds } from "../scripts/admin_status.mjs";
import {
  ABOUT,
  ADMIN_COMMANDS,
  BOT_NAME,
  DESCRIPTION,
  INITIAL_SUBSCRIBER,
  USER_COMMANDS,
} from "./src/logic.js";

const token = process.env.TG2TMBOT_TOKEN || process.env.TELEGRAM_BOT_TOKEN;
if (!token) {
  console.error("Set TG2TMBOT_TOKEN or TELEGRAM_BOT_TOKEN.");
  process.exit(1);
}

async function call(method, params) {
  const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
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

const adminIds = adminChatIds(process.env.LOGIN_CHAT_IDS || String(INITIAL_SUBSCRIBER));
for (const chatId of adminIds) {
  await call("setMyCommands", {
    commands: ADMIN_COMMANDS,
    scope: { type: "chat", chat_id: Number(chatId) },
  });
}

console.log(
  `description, about text and commands set (${USER_COMMANDS.length} default, admin menu for ${adminIds.length} chat(s))`,
);
