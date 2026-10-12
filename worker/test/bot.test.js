import assert from "node:assert/strict";
import test from "node:test";
import { handle } from "../src/index.js";
import {
  BOT_NAME,
  CHANNEL,
  COMMANDS,
  EXAMPLE,
  INITIAL_SUBSCRIBER,
  START,
  doneNotice,
  normalizeProgress,
  planNotifications,
  realPackUrl,
} from "../src/logic.js";

const PACK_URL = "https://messenger.360.yandex.ru/#/stickers/8377";

function memoryKv() {
  const store = new Map();
  const ops = { get: 0, put: 0, list: 0, delete: 0 };
  return {
    store,
    ops,
    async get(key) {
      ops.get++;
      return store.has(key) ? store.get(key) : null;
    },
    async put(key, value) {
      ops.put++;
      store.set(key, value);
    },
    async delete(key) {
      ops.delete++;
      store.delete(key);
    },
    async list({ prefix }) {
      ops.list++;
      const keys = [...store.keys()].filter((key) => key.startsWith(prefix || "")).sort();
      return { keys: keys.map((name) => ({ name })), list_complete: true };
    },
  };
}

function envWith(kv = memoryKv()) {
  return {
    BOT_KV: kv,
    UPLOADER_SECRET: "uploader-secret",
    WEBHOOK_SECRET: "webhook-secret",
    TG2TMBOT_TOKEN: "bot-token",
  };
}

function pack(overrides = {}) {
  return {
    slug: "02-dzhek-i-bevka",
    title: "Джек и Бевка",
    source: "https://t.me/tg2tm/4",
    status: "done",
    uploaded: 144,
    total: 144,
    url: null,
    error: null,
    ...overrides,
  };
}

test("a real Telemost sticker link is kept, including the hash", () => {
  assert.equal(realPackUrl(PACK_URL), PACK_URL);
  assert.equal(realPackUrl(null), null);
  assert.equal(realPackUrl("null"), null);
  assert.equal(realPackUrl("https://t.me/addstickers/minty_vk"), null);
});

test("done without packUrl does not notify and does not post", () => {
  const plan = planNotifications(null, pack());
  assert.deepEqual(plan.messages, ["Начата загрузка пака «Джек и Бевка» в Телемост: 144/144."]);
  assert.equal(plan.channel, null);
  assert.equal(plan.state.done, false);
  assert.equal(plan.state.posted, false);
});

test("done with packUrl notifies once and posts the channel message", () => {
  const plan = planNotifications(null, pack({ url: PACK_URL }));
  assert.equal(plan.messages.at(-1), doneNotice("Джек и Бевка", 144, PACK_URL, false));
  assert.match(plan.messages.at(-1), /https:\/\/t\.me\/tg2tm/);
  assert.equal(plan.channel, `«Джек и Бевка»\n\n${PACK_URL}`);
  assert.doesNotMatch(plan.channel, /addstickers/);
  assert.doesNotMatch(plan.channel, /t\.me\/tg2tm\/4/);
  const again = planNotifications(plan.state, pack({ url: PACK_URL }));
  assert.deepEqual(again.messages, []);
  assert.equal(again.channel, null);
});

test("a linkless done notice is followed by the link, then the channel post", () => {
  const plan = planNotifications({ started: true, step: 75, done: true, posted: false, error: null }, pack({ url: PACK_URL }));
  assert.deepEqual(plan.messages, [doneNotice("Джек и Бевка", 144, PACK_URL, true)]);
  assert.match(plan.channel, /8377/);
  assert.equal(plan.state.doneWithLink, true);
  assert.equal(plan.state.posted, true);
});

test("progress percentages and errors follow the polling bot", () => {
  const started = planNotifications(null, pack({ status: "uploading", uploaded: 10, total: 100, url: null }));
  assert.deepEqual(started.messages, ["Начата загрузка пака «Джек и Бевка» в Телемост: 10/100."]);
  const quarter = planNotifications(started.state, pack({ status: "uploading", uploaded: 40, total: 100 }));
  assert.deepEqual(quarter.messages, ["«Джек и Бевка»: 40/100 (25 %)."]);
  const late = planNotifications(quarter.state, pack({ status: "uploading", uploaded: 80, total: 100 }));
  assert.deepEqual(late.messages, ["«Джек и Бевка»: 80/100 (75 %)."]);
  const failed = planNotifications(late.state, pack({ status: "error", uploaded: 80, total: 100, error: "stopped at 081.png" }));
  assert.match(failed.messages[0], /Ошибка в паке «Джек и Бевка»: stopped at 081.png/);
  const same = planNotifications(failed.state, pack({ status: "error", uploaded: 80, total: 100, error: "stopped at 081.png" }));
  assert.deepEqual(same.messages, []);
});

test("nested pack.json telemost block is accepted", () => {
  const normalized = normalizeProgress({
    slug: "02-dzhek-i-bevka",
    title: "Джек и Бевка",
    sourceMessage: "https://t.me/tg2tm/4",
    stickerCount: 144,
    telemost: { status: "done", uploaded: 144, packUrl: PACK_URL, error: null },
  });
  assert.equal(normalized.url, PACK_URL);
  assert.equal(normalized.total, 144);
  const waiting = normalizeProgress({
    slug: "01-pappy-i-pryanik",
    title: "Паппи и Пряник",
    telemost: { status: "done", uploaded: 137, packUrl: null },
  });
  assert.equal(waiting.url, null);
});

function progressRequest(body, secret = "uploader-secret") {
  return new Request("https://tg2tmbot.example/progress", {
    method: "POST",
    headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

test("progress endpoint waits for packUrl, then notifies and does not repeat", async () => {
  const sent = [];
  const env = envWith();
  const sendMessage = async (_env, chatId, text) => {
    sent.push({ chatId, text });
  };
  const body = {
    slug: "02-dzhek-i-bevka",
    title: "Джек и Бевка",
    source: "https://t.me/tg2tm/4",
    status: "done",
    uploaded: 144,
    total: 144,
    packUrl: null,
  };
  const waiting = await handle(progressRequest(body), env, { sendMessage });
  assert.equal(waiting.status, 200);
  const waitingJson = await waiting.json();
  assert.equal(waitingJson.waitingForUrl, true);
  assert.equal(waitingJson.posted, false);
  assert.equal(sent.length, 1);
  assert.match(sent[0].text, /Начата загрузка/);
  assert.equal(sent[0].chatId, INITIAL_SUBSCRIBER);

  sent.length = 0;
  const done = await handle(progressRequest({ ...body, packUrl: PACK_URL }), env, { sendMessage });
  assert.equal(done.status, 200);
  const doneJson = await done.json();
  assert.equal(doneJson.posted, true);
  assert.equal(sent.length, 2);
  assert.match(sent[0].text, /^Готово:/);
  assert.equal(sent[0].chatId, INITIAL_SUBSCRIBER);
  assert.equal(sent[1].chatId, "@tg2tm");
  assert.match(sent[1].text, /8377/);

  sent.length = 0;
  env.BOT_KV.ops.get = 0;
  env.BOT_KV.ops.put = 0;
  env.BOT_KV.ops.list = 0;
  env.BOT_KV.ops.delete = 0;
  await handle(progressRequest({ ...body, packUrl: PACK_URL }), env, { sendMessage });
  assert.equal(sent.length, 0);
  assert.equal(env.BOT_KV.ops.put, 0);
  assert.equal(env.BOT_KV.ops.list, 0);
  assert.equal(env.BOT_KV.ops.delete, 0);
  assert.equal(env.BOT_KV.ops.get, 1);
});

test("an unchanged progress report does not write, and a real change writes the pack once", async () => {
  const env = envWith();
  const body = {
    slug: "02-dzhek-i-bevka",
    title: "Джек и Бевка",
    status: "uploading",
    uploaded: 40,
    total: 100,
  };
  const sendMessage = async () => {};
  await handle(progressRequest(body), env, { sendMessage });
  env.BOT_KV.ops.get = 0;
  env.BOT_KV.ops.put = 0;
  env.BOT_KV.ops.list = 0;
  const repeat = await handle(progressRequest(body), env, { sendMessage });
  assert.equal(repeat.status, 200);
  assert.equal(env.BOT_KV.ops.get, 1);
  assert.equal(env.BOT_KV.ops.put, 0);
  assert.equal(env.BOT_KV.ops.list, 0);

  env.BOT_KV.ops.put = 0;
  env.BOT_KV.ops.list = 0;
  const moved = await handle(progressRequest({ ...body, uploaded: 41 }), env, { sendMessage });
  assert.equal(moved.status, 200);
  assert.equal(env.BOT_KV.ops.put, 1);
  assert.equal(env.BOT_KV.ops.list, 0);
  const stored = JSON.parse(await env.BOT_KV.get(`pack:${body.slug}`));
  assert.equal(stored.uploaded, 41);
  assert.equal(stored.status, "uploading");
});

test("health and the root path do not read or list KV", async () => {
  const kv = memoryKv();
  const env = envWith(kv);
  for (const path of ["/health", "/"]) {
    kv.ops.get = 0;
    kv.ops.put = 0;
    kv.ops.list = 0;
    kv.ops.delete = 0;
    const res = await handle(new Request(`https://tg2tmbot.example${path}`), env);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true });
    assert.equal(kv.ops.get + kv.ops.put + kv.ops.list + kv.ops.delete, 0);
  }
});

test("progress endpoint rejects a missing secret", async () => {
  const res = await handle(progressRequest({ slug: "02-dzhek-i-bevka" }, "nope"), envWith(), {
    sendMessage: async () => {},
  });
  assert.equal(res.status, 401);
});

test("/start subscribes and replies with the format and the channel example", async () => {
  const sent = [];
  const env = envWith();
  const res = await handle(
    new Request("https://tg2tmbot.example/telegram", {
      method: "POST",
      headers: { "X-Telegram-Bot-Api-Secret-Token": "webhook-secret", "content-type": "application/json" },
      body: JSON.stringify({ update_id: 1, message: { message_id: 1, chat: { id: 4242 }, text: "/start" } }),
    }),
    env,
    { sendMessage: async (_env, chatId, text) => sent.push({ chatId, text }) },
  );
  assert.equal(res.status, 200);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].chatId, 4242);
  assert.equal(sent[0].text, START);
  assert.match(sent[0].text, new RegExp(BOT_NAME));
  assert.match(sent[0].text, new RegExp(CHANNEL.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.doesNotMatch(sent[0].text, /из канала/);
  assert.ok(sent[0].text.includes(EXAMPLE));
  assert.equal(COMMANDS.find((item) => item.command === "start").description, "Как пользоваться");
  assert.equal(COMMANDS.find((item) => item.command === "format").description, "Формат запроса");
  assert.equal(COMMANDS.find((item) => item.command === "example").description, "Пример набора");
  assert.equal(await env.BOT_KV.get("sub:4242"), "1");
});

test("webhook without the secret token is rejected", async () => {
  const res = await handle(
    new Request("https://tg2tmbot.example/telegram", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: { chat: { id: 1 }, text: "/start" } }),
    }),
    envWith(),
    { sendMessage: async () => assert.fail("should not send") },
  );
  assert.equal(res.status, 401);
});

test("a pack-shaped message counts stickers and enforces 150", async () => {
  const sent = [];
  const res = await handle(
    new Request("https://tg2tmbot.example/telegram", {
      method: "POST",
      headers: { "X-Telegram-Bot-Api-Secret-Token": "webhook-secret" },
      body: JSON.stringify({
        message: {
          chat: { id: 7 },
          text: "Минто\n\nhttps://t.me/addstickers/minty_vk\nhttps://t.me/addstickers/minty2_vk",
        },
      }),
    }),
    envWith(),
    {
      sendMessage: async (_env, _chatId, text) => sent.push(text),
      stickerCount: async (_env, name) => (name === "minty_vk" ? 80 : 80),
    },
  );
  assert.equal(res.status, 200);
  assert.match(sent[0], /Пак «Минто»/);
  assert.match(sent[0], /minty_vk — 80/);
  assert.match(sent[0], /больше лимита 150/);
});

function telegramRequest(chatId, text) {
  return new Request("https://tg2tmbot.example/telegram", {
    method: "POST",
    headers: { "X-Telegram-Bot-Api-Secret-Token": "webhook-secret", "content-type": "application/json" },
    body: JSON.stringify({ message: { chat: { id: chatId }, text } }),
  });
}

test("/login and /connect refuse every chat outside LOGIN_CHAT_IDS", async () => {
  const sent = [];
  let fetched = 0;
  const env = { ...envWith(), LOGIN_CHAT_IDS: String(INITIAL_SUBSCRIBER), GH_DISPATCH_TOKEN: "dispatch-token" };
  const fetch = async () => {
    fetched += 1;
    return new Response(null, { status: 204 });
  };
  const sendMessage = async (_env, chatId, text) => sent.push({ chatId, text });
  for (const text of ["/login", "/connect work", "/login@tg2tmbot"]) {
    const res = await handle(telegramRequest(111, text), env, { sendMessage, fetch });
    assert.equal(res.status, 200);
  }
  assert.equal(fetched, 0);
  assert.equal(sent.length, 3);
  for (const item of sent) {
    assert.equal(item.chatId, 111);
    assert.equal(item.text, "Эта команда только для владельца.");
  }
});

test("an allowlisted /login and /connect dispatch the Telemost workflow", async () => {
  const sent = [];
  const calls = [];
  const env = { ...envWith(), LOGIN_CHAT_IDS: "8502935020", GH_DISPATCH_TOKEN: "dispatch-token" };
  const fetch = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body), authorization: init.headers.authorization });
    return new Response(null, { status: 204 });
  };
  const sendMessage = async (_env, chatId, text) => sent.push({ chatId, text });
  await handle(telegramRequest(INITIAL_SUBSCRIBER, "/login"), env, { sendMessage, fetch });
  await handle(telegramRequest(INITIAL_SUBSCRIBER, "/connect work"), env, { sendMessage, fetch });
  assert.equal(calls.length, 2);
  assert.equal(
    calls[0].url,
    "https://api.github.com/repos/pretendless/tg2tm/actions/workflows/telemost-session.yml/dispatches",
  );
  assert.equal(calls[0].authorization, "Bearer dispatch-token");
  assert.equal(calls[0].body.ref, "main");
  assert.deepEqual(calls[0].body.inputs, { mode: "login", account: "default", chat_id: "8502935020", packs: "" });
  assert.deepEqual(calls[1].body.inputs, { mode: "login", account: "work", chat_id: "8502935020", packs: "" });
  assert.match(sent[0].text, /QR-код Яндекса/);
  assert.match(sent[1].text, /«work»/);
  assert.equal(COMMANDS.find((item) => item.command === "login").description, "Войти в Яндекс");
  assert.equal(COMMANDS.find((item) => item.command === "connect").description, "Войти в аккаунт с меткой");
});

test("login does not dispatch when the GitHub token is missing", async () => {
  const sent = [];
  const env = { ...envWith(), LOGIN_CHAT_IDS: "8502935020" };
  const res = await handle(telegramRequest(INITIAL_SUBSCRIBER, "/login"), env, {
    sendMessage: async (_env, chatId, text) => sent.push({ chatId, text }),
    fetch: async () => assert.fail("should not dispatch"),
  });
  assert.equal(res.status, 200);
  assert.match(sent[0].text, /GH_DISPATCH_TOKEN/);
});

test("/format and /stop", async () => {
  const sent = [];
  const env = envWith();
  const send = async (_env, chatId, text) => sent.push({ chatId, text });
  await handle(
    new Request("https://tg2tmbot.example/telegram", {
      method: "POST",
      headers: { "X-Telegram-Bot-Api-Secret-Token": "webhook-secret" },
      body: JSON.stringify({ message: { chat: { id: INITIAL_SUBSCRIBER }, text: "/format" } }),
    }),
    env,
    { sendMessage: send },
  );
  assert.match(sent[0].text, /Одно сообщение — один пак/);
  await handle(
    new Request("https://tg2tmbot.example/telegram", {
      method: "POST",
      headers: { "X-Telegram-Bot-Api-Secret-Token": "webhook-secret" },
      body: JSON.stringify({ message: { chat: { id: INITIAL_SUBSCRIBER }, text: "/stop" } }),
    }),
    env,
    { sendMessage: send },
  );
  assert.equal(await env.BOT_KV.get(`sub:${INITIAL_SUBSCRIBER}`), null);
  assert.match(sent[1].text, /Уведомления выключены/);
});
