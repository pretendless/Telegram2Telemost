// @tg2tmbot on Cloudflare Workers: Telegram webhook plus the uploader progress endpoint.
import { handleVmCommand } from "../../vm/worker_login.js";
import {
  CHANNEL_CHAT,
  INITIAL_SUBSCRIBER,
  NOT_A_PACK,
  commandOf,
  normalizeProgress,
  notificationSteps,
  parsePackMessage,
  renderPackCheck,
  staticReply,
  statusText,
} from "./logic.js";

export function botToken(env) {
  return env.TG2TMBOT_TOKEN || env.TELEGRAM_BOT_TOKEN || "";
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function timingSafeEqual(a, b) {
  const left = String(a);
  const right = String(b);
  const length = Math.max(left.length, right.length);
  let mismatch = left.length === right.length ? 0 : 1;
  for (let i = 0; i < length; i++) mismatch |= (left.charCodeAt(i) || 0) ^ (right.charCodeAt(i) || 0);
  return mismatch === 0;
}

function bearer(request) {
  const header = request.headers.get("authorization") || "";
  const match = header.match(/^Bearer\s+(\S+)\s*$/i);
  return match ? match[1] : "";
}

async function telegram(env, method, params) {
  const token = botToken(env);
  if (!token) throw new Error("no bot token");
  const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(params),
  });
  let body;
  try {
    body = await res.json();
  } catch {
    throw new Error(`telegram ${method} http ${res.status}`);
  }
  if (!body.ok) throw new Error(body.description || `telegram ${method}`);
  return body.result;
}

async function defaultSend(env, chatId, text) {
  await telegram(env, "sendMessage", {
    chat_id: chatId,
    text,
    link_preview_options: { is_disabled: true },
  });
}

async function defaultStickerCount(env, name) {
  const set = await telegram(env, "getStickerSet", { name });
  return (set.stickers || []).length;
}

async function ensureSeed(kv) {
  if (await kv.get("meta:seeded")) return;
  await kv.put(`sub:${INITIAL_SUBSCRIBER}`, "1");
  await kv.put("meta:seeded", "1");
}

async function listByPrefix(kv, prefix) {
  const names = [];
  let cursor;
  do {
    const page = await kv.list({ prefix, cursor });
    for (const key of page.keys) names.push(key.name);
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  return names;
}

async function listSubscribers(kv) {
  await ensureSeed(kv);
  const ids = [];
  for (const name of await listByPrefix(kv, "sub:")) {
    const id = Number(name.slice(4));
    if (Number.isSafeInteger(id)) ids.push(id);
  }
  return ids;
}

async function listPacks(kv) {
  const packs = [];
  for (const name of await listByPrefix(kv, "pack:")) {
    const raw = await kv.get(name);
    if (!raw) continue;
    try {
      packs.push(JSON.parse(raw));
    } catch {
      // skip a corrupt row
    }
  }
  return packs;
}

async function fanout(send, env, chatIds, text) {
  if (!chatIds.length) return "empty";
  let ok = 0;
  for (const chatId of chatIds) {
    try {
      await send(env, chatId, text);
      ok++;
    } catch (err) {
      console.error("notify failed", String(chatId), err && err.message);
    }
  }
  return ok > 0 ? "ok" : "fail";
}

async function applyProgress(env, pack, send) {
  const subs = await listSubscribers(env.BOT_KV);
  const prevRaw = await env.BOT_KV.get(`state:${pack.slug}`);
  let prev = null;
  if (prevRaw) {
    try {
      prev = JSON.parse(prevRaw);
    } catch {
      prev = null;
    }
  }
  const steps = notificationSteps(prev, pack);
  const needsToken = steps.length > 0 && !botToken(env);
  if (needsToken) {
    await env.BOT_KV.put(`pack:${pack.slug}`, JSON.stringify(pack));
    return { ok: false, status: 503, error: "no bot token", notified: 0, posted: false };
  }

  let notified = 0;
  let posted = false;
  for (const step of steps) {
    if (step.kind === "channel") {
      try {
        await send(env, CHANNEL_CHAT, step.text);
        posted = true;
      } catch (err) {
        console.error("channel post failed", pack.slug, err && err.message);
        await env.BOT_KV.put(`pack:${pack.slug}`, JSON.stringify(pack));
        return { ok: false, status: 502, error: "channel post failed", notified, posted: false };
      }
    } else {
      const result = await fanout(send, env, subs, step.text);
      if (result === "fail") {
        await env.BOT_KV.put(`pack:${pack.slug}`, JSON.stringify(pack));
        return { ok: false, status: 502, error: "notify failed", notified, posted: false };
      }
      notified++;
    }
    await env.BOT_KV.put(`state:${pack.slug}`, JSON.stringify(step.state));
  }
  await env.BOT_KV.put(`pack:${pack.slug}`, JSON.stringify(pack));
  return { ok: true, status: 200, notified, posted, waitingForUrl: pack.status === "done" && !pack.url };
}

async function handleProgress(request, env, send) {
  const secret = env.UPLOADER_SECRET || "";
  if (!secret || !timingSafeEqual(bearer(request), secret)) return new Response("unauthorized", { status: 401 });
  const raw = await request.text();
  if (raw.length > 16384) return new Response("too big", { status: 413 });
  let body;
  try {
    body = JSON.parse(raw);
  } catch {
    return json({ ok: false, error: "bad json" }, 400);
  }
  let pack;
  try {
    pack = normalizeProgress(body);
  } catch (err) {
    return json({ ok: false, error: err.message }, 400);
  }
  const result = await applyProgress(env, pack, send);
  return json(
    {
      ok: result.ok,
      slug: pack.slug,
      notified: result.notified,
      posted: result.posted,
      waitingForUrl: Boolean(result.waitingForUrl),
      error: result.error,
    },
    result.status,
  );
}

async function answer(env, update, send, stickerCount, deps = {}) {
  const message = update && update.message;
  if (!message || typeof message.text !== "string") return;
  const chatId = message.chat && message.chat.id;
  if (!Number.isSafeInteger(chatId) && typeof chatId !== "number") return;
  await ensureSeed(env.BOT_KV);
  const text = message.text;
  const cmd = commandOf(text);
  const known = staticReply(cmd);
  let out;
  if (known) {
    if (known.subscribe === true) await env.BOT_KV.put(`sub:${chatId}`, "1");
    if (known.subscribe === false) await env.BOT_KV.delete(`sub:${chatId}`);
    out = known.text;
  } else if (cmd === "/status") {
    out = statusText(await listPacks(env.BOT_KV));
  } else if (cmd === "/login" || cmd === "/connect" || cmd === "/upload") {
    await handleVmCommand(env, message, { send, fetch: deps.fetch });
    return;
  } else if (cmd) {
    return;
  } else {
    const parsed = parsePackMessage(text);
    if (!parsed.ok) {
      out = NOT_A_PACK;
    } else {
      const rows = [];
      let total = 0;
      for (const name of parsed.names) {
        try {
          const count = await stickerCount(env, name);
          total += count;
          rows.push(`• ${name} — ${count}`);
        } catch {
          rows.push(`• ${name} — набор не найден`);
        }
      }
      out = renderPackCheck(parsed.title, rows, total);
    }
  }
  await send(env, chatId, out);
}

async function handleTelegram(request, env, send, stickerCount, deps) {
  const secret = env.WEBHOOK_SECRET || "";
  const got = request.headers.get("X-Telegram-Bot-Api-Secret-Token") || "";
  if (!secret || !timingSafeEqual(got, secret)) return new Response("unauthorized", { status: 401 });
  let update;
  try {
    update = await request.json();
  } catch {
    return new Response("bad json", { status: 400 });
  }
  try {
    await answer(env, update, send, stickerCount, deps);
  } catch (err) {
    console.error("reply failed", err && err.message);
  }
  return new Response("ok");
}

export async function handle(request, env, deps = {}) {
  const send = deps.sendMessage || defaultSend;
  const stickerCount = deps.stickerCount || defaultStickerCount;
  const url = new URL(request.url);
  if (request.method === "GET" && (url.pathname === "/" || url.pathname === "/health")) return json({ ok: true });
  if (request.method === "POST" && url.pathname === "/progress") return handleProgress(request, env, send);
  if (request.method === "POST" && url.pathname === "/telegram") return handleTelegram(request, env, send, stickerCount, deps);
  return new Response("not found", { status: 404 });
}

export default {
  fetch(request, env) {
    return handle(request, env);
  },
};
