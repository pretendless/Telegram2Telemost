// Workflow and container inputs. Rejects anything that could change a shell command.
import { pathToFileURL } from "node:url";
import { ACCOUNT_RE } from "./dispatch.js";

export function checkInputs(env) {
  const mode = env.MODE || "login";
  if (mode !== "login" && mode !== "upload" && mode !== "finalize" && mode !== "restart" && mode !== "restart-peek") return { ok: false, error: "mode" };
  const account = String(env.ACCOUNT || "default").trim();
  if (!ACCOUNT_RE.test(account)) return { ok: false, error: "account" };
  const chat = String(env.CHAT_ID || env.TELEGRAM_CHAT_ID || "").trim();
  if (chat && !/^-?[0-9]{1,16}$/.test(chat)) return { ok: false, error: "chat_id" };
  if (env.REQUIRE_CHAT === "1" && !chat) return { ok: false, error: "chat_id" };
  const packs = String(env.PACKS || "")
    .trim()
    .replace(/\s+/g, " ");
  if (packs && !/^[0-9]{2}(?: [0-9]{2})*$/.test(packs)) return { ok: false, error: "packs" };
  if ((mode === "upload" || mode === "finalize") && !packs) return { ok: false, error: "packs" };
  return { ok: true, mode, account, chat_id: chat, packs };
}

function main() {
  const result = checkInputs(process.env);
  if (!result.ok) {
    console.error(`bad input: ${result.error}`);
    process.exit(1);
  }
  if (process.argv.includes("--github-output")) {
    process.stdout.write(
      `mode=${result.mode}\naccount=${result.account}\nchat_id=${result.chat_id}\npacks=${result.packs}\n`,
    );
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
