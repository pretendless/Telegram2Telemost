import assert from "node:assert/strict";
import test from "node:test";
import { handle } from "../src/index.js";
import { adminLiveStatusText } from "../../scripts/admin_status.mjs";
import {
  CREATE_PROMPT,
  MAX_PACK_TITLE,
  MAX_STICKERS,
  STOP_CLEARED,
  STOP_IDLE,
  createLinksPrompt,
  decodeAwaitCreate,
  encodeAwaitCreate,
  judgeCreateLinks,
  nameStepResult,
  parseStickerSetNames,
} from "../src/logic.js";

function memoryKv() {
  const store = new Map();
  return {
    store,
    async get(key) {
      return store.has(key) ? store.get(key) : null;
    },
    async put(key, value) {
      store.set(key, value);
    },
    async delete(key) {
      store.delete(key);
    },
    async list({ prefix }) {
      const keys = [...store.keys()].filter((key) => key.startsWith(prefix || "")).sort();
      return { keys: keys.map((name) => ({ name })), list_complete: true };
    },
  };
}

function envWith() {
  return {
    BOT_KV: memoryKv(),
    UPLOADER_SECRET: "uploader-secret",
    WEBHOOK_SECRET: "webhook-secret",
    TG2TMBOT_TOKEN: "bot-token",
  };
}

function telegram(chatId, text) {
  return new Request("https://tg2tmbot.example/telegram", {
    method: "POST",
    headers: { "X-Telegram-Bot-Api-Secret-Token": "webhook-secret", "content-type": "application/json" },
    body: JSON.stringify({ message: { chat: { id: chatId }, text } }),
  });
}

async function say(env, chatId, text, deps = {}) {
  const sent = [];
  const res = await handle(telegram(chatId, text), env, {
    sendMessage: async (_env, id, reply) => {
      sent.push({ chatId: id, reply });
      return { message_id: sent.length };
    },
    ...deps,
  });
  assert.equal(res.status, 200);
  return sent;
}

test("name step rejects links and keeps the chat on the name", async () => {
  const env = envWith();
  const prompted = await say(env, 7, "/create");
  assert.equal(prompted[0].reply, CREATE_PROMPT);
  assert.doesNotMatch(prompted[0].reply, /addstickers/);
  assert.deepEqual(decodeAwaitCreate(env.BOT_KV.store.get("await:7")), { step: "name" });

  const rejected = await say(env, 7, "Минто\nhttps://t.me/addstickers/minty_vk");
  assert.match(rejected[0].reply, /без ссылок/);
  assert.equal(env.BOT_KV.store.get("queue"), undefined);
  assert.deepEqual(decodeAwaitCreate(env.BOT_KV.store.get("await:7")), { step: "name" });

  const empty = await say(env, 7, "   ");
  assert.equal(empty[0].reply, CREATE_PROMPT);
  assert.deepEqual(decodeAwaitCreate(env.BOT_KV.store.get("await:7")), { step: "name" });
});

test("a trimmed name of 100 characters advances and 101 stays on the name", async () => {
  const env = envWith();
  const okName = "я".repeat(MAX_PACK_TITLE);
  const longName = "я".repeat(MAX_PACK_TITLE + 1);
  await say(env, 7, "/create");
  const rejected = await say(env, 7, `  ${longName}  `);
  assert.match(rejected[0].reply, new RegExp(`Название — ${longName.length} символ, лимит ${MAX_PACK_TITLE}`));
  assert.match(rejected[0].reply, /ещё раз/);
  assert.equal(env.BOT_KV.store.get("queue"), undefined);
  assert.deepEqual(decodeAwaitCreate(env.BOT_KV.store.get("await:7")), { step: "name" });

  const asked = await say(env, 7, ` ${okName} `);
  assert.equal(asked[0].reply, createLinksPrompt(okName));
  assert.deepEqual(decodeAwaitCreate(env.BOT_KV.store.get("await:7")), { step: "links", title: okName });
  assert.equal(nameStepResult(okName).ok, true);
  assert.equal(nameStepResult(`\n${longName}\n`).reason, "long");
});

test("a name asks for links and warns that the total must not exceed 150", async () => {
  const env = envWith();
  await say(env, 7, "/create");
  const asked = await say(env, 7, "  Лисёнок  ");
  assert.equal(asked[0].reply, createLinksPrompt("Лисёнок"));
  assert.match(asked[0].reply, /t\.me\/addstickers/);
  assert.match(asked[0].reply, new RegExp(`не больше ${MAX_STICKERS}`));
  assert.deepEqual(decodeAwaitCreate(env.BOT_KV.store.get("await:7")), { step: "links", title: "Лисёнок" });
});

test("a missing set names that set and asks for links again", async () => {
  const env = envWith();
  await say(env, 7, "/create");
  await say(env, 7, "Лис");
  const failed = await say(env, 7, "https://t.me/addstickers/gone\nhttps://t.me/addstickers/fox", {
    stickerCount: async (_env, name) => {
      if (name === "gone") throw new Error("not found");
      return 4;
    },
  });
  assert.match(failed[0].reply, /Набор «gone» не найден/);
  assert.match(failed[0].reply, /ещё раз/);
  assert.match(failed[0].reply, /«Лис» сохранено/);
  assert.equal(env.BOT_KV.store.get("queue"), undefined);
  assert.deepEqual(decodeAwaitCreate(env.BOT_KV.store.get("await:7")), { step: "links", title: "Лис" });
});

test("more than 150 stickers reports the total and keeps the name", async () => {
  const env = envWith();
  await say(env, 7, "/create");
  await say(env, 7, "Минто");
  const failed = await say(
    env,
    7,
    "https://t.me/addstickers/minty_vk\nhttps://t.me/addstickers/minty2_vk",
    { stickerCount: async () => 80 },
  );
  assert.match(failed[0].reply, /Всего 160 стикеров/);
  assert.match(failed[0].reply, /160 > 150/);
  assert.match(failed[0].reply, /«Минто» сохранено/);
  assert.equal(env.BOT_KV.store.get("queue"), undefined);
  assert.deepEqual(decodeAwaitCreate(env.BOT_KV.store.get("await:7")), { step: "links", title: "Минто" });
});

test("valid links enqueue the saved title and clear the dialog", async () => {
  const env = envWith();
  env.BOT_KV.store.set("meta:seeded", "1");
  await say(env, 7, "/create");
  await say(env, 7, "Лисёнок");
  const accepted = await say(env, 7, "не ссылка\nhttps://t.me/addstickers/fox_one\nhttps://t.me/addstickers/fox_two", {
    stickerCount: async (_env, name) => (name === "fox_one" ? 3 : 4),
  });
  assert.match(accepted[0].reply, /Запрос принят/);
  assert.match(accepted[0].reply, /«Лисёнок»/);
  assert.match(accepted[0].reply, /fox_one — 3/);
  assert.match(accepted[0].reply, /fox_two — 4/);
  assert.match(accepted[0].reply, /Всего 7 стикеров/);
  assert.equal(env.BOT_KV.store.get("await:7"), undefined);
  const queue = JSON.parse(env.BOT_KV.store.get("queue"));
  assert.equal(queue.items.length, 1);
  assert.equal(queue.items[0].title, "Лисёнок");
  assert.equal(queue.items[0].status, "queued");
  assert.equal(queue.items[0].stickers, 7);
  assert.deepEqual(queue.items[0].links, [
    "https://t.me/addstickers/fox_one",
    "https://t.me/addstickers/fox_two",
  ]);
  const catalog = [...env.BOT_KV.store.keys()].filter((key) => key.startsWith("pack:"));
  assert.deepEqual(catalog, []);
});

test("/create restarts at the name and drops a saved title", async () => {
  const env = envWith();
  env.BOT_KV.store.set("meta:seeded", "1");
  await say(env, 7, "/create");
  await say(env, 7, "Лис");
  const again = await say(env, 7, "/create");
  assert.equal(again[0].reply, CREATE_PROMPT);
  assert.deepEqual(decodeAwaitCreate(env.BOT_KV.store.get("await:7")), { step: "name" });

  const rejected = await say(env, 7, "https://t.me/addstickers/fox", {
    stickerCount: async () => 5,
  });
  assert.match(rejected[0].reply, /без ссылок/);
  assert.equal(env.BOT_KV.store.get("queue"), undefined);

  await say(env, 7, "Другой");
  const accepted = await say(env, 7, "https://t.me/addstickers/fox", {
    stickerCount: async () => 5,
  });
  assert.match(accepted[0].reply, /«Другой»/);
  assert.equal(JSON.parse(env.BOT_KV.store.get("queue")).items[0].title, "Другой");
});

test("another command keeps its reply and the half-finished create state", async () => {
  const env = envWith();
  env.BOT_KV.store.set("meta:seeded", "1");
  await say(env, 7, "/create");
  await say(env, 7, "Лис");
  const status = await say(env, 7, "/status");
  assert.match(status[0].reply, /Активных запросов нет/);
  assert.doesNotMatch(status[0].reply, /название/);
  assert.deepEqual(decodeAwaitCreate(env.BOT_KV.store.get("await:7")), { step: "links", title: "Лис" });

  const restart = await say(env, 7, "/restart");
  assert.equal(restart[0].reply, "Эта команда только для администратора.");
  assert.deepEqual(decodeAwaitCreate(env.BOT_KV.store.get("await:7")), { step: "links", title: "Лис" });

  const accepted = await say(env, 7, "https://t.me/addstickers/fox", {
    stickerCount: async () => 2,
  });
  assert.match(accepted[0].reply, /«Лис»/);
  assert.equal(JSON.parse(env.BOT_KV.store.get("queue")).items[0].title, "Лис");
});

test("after a missing set the same name is queued when the links are valid", async () => {
  const env = envWith();
  env.BOT_KV.store.set("meta:seeded", "1");
  await say(env, 7, "/create");
  await say(env, 7, "Лис");
  await say(env, 7, "https://t.me/addstickers/gone", {
    stickerCount: async () => {
      throw new Error("missing");
    },
  });
  const accepted = await say(env, 7, "https://t.me/addstickers/fox", {
    stickerCount: async () => 6,
  });
  assert.match(accepted[0].reply, /«Лис»/);
  assert.match(accepted[0].reply, /Всего 6 стикеров/);
  assert.equal(JSON.parse(env.BOT_KV.store.get("queue")).items[0].stickers, 6);
});

test("admin keeps the one-message pack, and /create still starts the dialog", async () => {
  const env = envWith();
  env.BOT_KV.store.set("meta:seeded", "1");
  const admin = 8502935020;
  const direct = await say(env, admin, "Админ\n\nhttps://t.me/addstickers/admin_set", {
    stickerCount: async () => 3,
  });
  assert.match(direct[0].reply, /Запрос принят/);
  assert.equal(JSON.parse(env.BOT_KV.store.get("queue")).items[0].title, "Админ");

  const prompted = await say(env, admin, "/create");
  assert.equal(prompted[0].reply, CREATE_PROMPT);
  const rejected = await say(env, admin, "Ещё\nhttps://t.me/addstickers/other", {
    stickerCount: async () => 1,
  });
  assert.match(rejected[0].reply, /без ссылок/);
  assert.equal(JSON.parse(env.BOT_KV.store.get("queue")).items.length, 1);
});

test("judgeCreateLinks and the name step are pure", () => {
  assert.equal(nameStepResult("https://t.me/addstickers/fox").reason, "links");
  assert.equal(nameStepResult("  Кот ").title, "Кот");
  assert.deepEqual(parseStickerSetNames("a\nhttps://t.me/addstickers/one\nhttps://t.me/addstickers/one"), ["one"]);
  const missing = judgeCreateLinks("Кот", ["gone", "ok"], [
    { name: "gone", missing: true },
    { name: "ok", count: 1 },
  ]);
  assert.equal(missing.ok, false);
  assert.deepEqual(missing.missing, ["gone"]);
  assert.match(missing.text, /Набор «gone» не найден/);
  const both = judgeCreateLinks("Кот", ["gone", "also"], [
    { name: "gone", missing: true },
    { name: "also", missing: true },
  ]);
  assert.deepEqual(both.missing, ["gone", "also"]);
  assert.match(both.text, /Не найдены наборы/);
  const over = judgeCreateLinks("Кот", ["a", "b"], [
    { name: "a", count: 100 },
    { name: "b", count: 51 },
  ]);
  assert.equal(over.reason, "over");
  assert.match(over.text, /151 > 150/);
  const zero = judgeCreateLinks("Кот", ["a"], [{ name: "a", count: 0 }]);
  assert.equal(zero.reason, "empty");
  assert.equal(decodeAwaitCreate("1").step, "name");
  assert.deepEqual(decodeAwaitCreate(encodeAwaitCreate({ step: "links", title: "Кот" })), {
    step: "links",
    title: "Кот",
  });
});

const OLD_LINK = "https://t.me/addstickers/p8502935020_1791999310374124782_by_creastikersbot";

function seedDone(env, title, links) {
  env.BOT_KV.store.set("meta:seeded", "1");
  env.BOT_KV.store.set(
    "queue",
    JSON.stringify({
      priority: [],
      items: [
        {
          id: "done-test",
          chatId: "1",
          title,
          links,
          priority: false,
          createdAt: "2026-10-14T00:00:00.000Z",
          status: "done",
          stickers: 4,
        },
      ],
    }),
  );
}

test("a new title with the same finished links enqueues", async () => {
  const env = envWith();
  seedDone(env, "test", [OLD_LINK]);
  await say(env, 7, "/create");
  await say(env, 7, "test2");
  const accepted = await say(env, 7, OLD_LINK, { stickerCount: async () => 4 });
  assert.match(accepted[0].reply, /Запрос принят/);
  assert.match(accepted[0].reply, /«test2»/);
  assert.doesNotMatch(accepted[0].reply, /уже переносился/);
  const queue = JSON.parse(env.BOT_KV.store.get("queue"));
  assert.equal(queue.items.filter((item) => item.status === "queued").length, 1);
  assert.equal(queue.items.find((item) => item.status === "queued").title, "test2");
});

test("the same title with different links enqueues", async () => {
  const env = envWith();
  seedDone(env, "test", [OLD_LINK]);
  await say(env, 7, "/create");
  await say(env, 7, "test");
  const accepted = await say(env, 7, "https://t.me/addstickers/konchanch", { stickerCount: async () => 33 });
  assert.match(accepted[0].reply, /Запрос принят/);
  assert.match(accepted[0].reply, /«test»/);
  assert.match(accepted[0].reply, /Всего 33 стикеров/);
  assert.doesNotMatch(accepted[0].reply, /уже переносился/);
  const queued = JSON.parse(env.BOT_KV.store.get("queue")).items.find((item) => item.status === "queued");
  assert.equal(queued.title, "test");
  assert.deepEqual(queued.links, ["https://t.me/addstickers/konchanch"]);
});

test("the same title and the same links restart the name prompt", async () => {
  const env = envWith();
  seedDone(env, "test", [OLD_LINK]);
  await say(env, 7, "/create");
  await say(env, 7, "test");
  const blocked = await say(env, 7, OLD_LINK, { stickerCount: async () => 4 });
  assert.match(blocked[0].reply, /этими же ссылками/);
  assert.match(blocked[0].reply, /«test»/);
  assert.match(blocked[0].reply, /p8502935020_1791999310374124782_by_creastikersbot/);
  assert.doesNotMatch(blocked[0].reply, /«test2»/);
  assert.ok(blocked[0].reply.endsWith(CREATE_PROMPT));
  assert.deepEqual(decodeAwaitCreate(env.BOT_KV.store.get("await:7")), { step: "name" });
  assert.equal(JSON.parse(env.BOT_KV.store.get("queue")).items.length, 1);

  const renamed = await say(env, 7, "test2");
  assert.equal(renamed[0].reply, createLinksPrompt("test2"));
  const accepted = await say(env, 7, OLD_LINK, { stickerCount: async () => 4 });
  assert.match(accepted[0].reply, /«test2»/);
  assert.match(accepted[0].reply, /Запрос принят/);
});

test("/stop clears the name step, the links step, and answers when idle", async () => {
  const env = envWith();
  env.BOT_KV.store.set("meta:seeded", "1");
  env.BOT_KV.store.set(
    "queue",
    JSON.stringify({
      priority: [],
      items: [
        {
          id: "queued-1",
          chatId: "7",
          title: "Шерсть",
          links: ["https://t.me/addstickers/piidarasy"],
          priority: false,
          createdAt: "2026-10-14T01:00:00.000Z",
          status: "queued",
          stickers: 109,
        },
      ],
    }),
  );

  await say(env, 7, "/create");
  const fromName = await say(env, 7, "/stop");
  assert.equal(fromName[0].reply, STOP_CLEARED);
  assert.equal(env.BOT_KV.store.get("await:7"), undefined);
  assert.equal(JSON.parse(env.BOT_KV.store.get("queue")).items[0].status, "queued");

  await say(env, 7, "/create");
  await say(env, 7, "test");
  const fromLinks = await say(env, 7, "/stop");
  assert.equal(fromLinks[0].reply, STOP_CLEARED);
  assert.match(fromLinks[0].reply, /\/create/);
  assert.match(fromLinks[0].reply, /\/status/);
  assert.equal(env.BOT_KV.store.get("await:7"), undefined);

  const idle = await say(env, 9, "/stop");
  assert.equal(idle[0].reply, STOP_IDLE);
  assert.match(idle[0].reply, /нечего прерывать/);
  assert.equal(JSON.parse(env.BOT_KV.store.get("queue")).items[0].title, "Шерсть");
});

test("admin /status names a starting run and an upload instead of idle", () => {
  const queued = {
    items: [
      {
        status: "queued",
        title: "Шерсть Ебаная",
        stickers: 109,
        createdAt: "2026-10-14T00:57:00.000Z",
      },
    ],
  };
  const session = {
    url: "https://github.com/pretendless/tg2tm/actions/runs/38644156549",
    at: "2026-10-14T00:57:30.000Z",
  };
  const starting = adminLiveStatusText({ queue: queued, job: { running: false }, session });
  assert.match(starting, /запуск Actions, пак «Шерсть Ебаная», стикеры ещё не пошли/);
  assert.match(starting, /38644156549/);
  assert.doesNotMatch(starting, /^простаивает$/);

  const uploading = adminLiveStatusText({
    queue: { items: [{ status: "uploading", title: "Шерсть Ебаная", stickers: 109 }] },
    job: { running: true, pack: "Шерсть Ебаная", index: 8, total: 109 },
    session,
  });
  assert.match(uploading, /идёт \| «Шерсть Ебаная» \| стикер 8 из 109/);
  assert.doesNotMatch(uploading, /простаивает/);

  assert.equal(adminLiveStatusText({ queue: { items: [] }, job: { running: false } }), "простаивает");
});
