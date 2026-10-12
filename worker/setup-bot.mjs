// Sets @tg2tmbot description, short description and command list.
// Token: TG2TMBOT_TOKEN or TELEGRAM_BOT_TOKEN. Nothing is printed.
import { ABOUT, BOT_NAME, COMMANDS, DESCRIPTION } from "./src/logic.js";

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
await call("setMyCommands", { commands: COMMANDS });
console.log("description, about text and commands set");
