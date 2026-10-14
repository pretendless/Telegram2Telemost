import assert from "node:assert/strict";
import test from "node:test";
import { handle } from "../src/index.js";
import {
  BOT_NAME,
  CHANNEL,
  ADMIN_COMMANDS,
  ADMIN_ONLY_COMMANDS,
  USER_COMMANDS,
  EXAMPLE,
  INITIAL_SUBSCRIBER,
  START,
  doneNotice,
  normalizeProgress,
  planNotifications,
  adminQueueOverviewText,
  claimNext,
  emptyQueue,
  enqueueRequest,
  findUploadingReleaseId,
  formatUserRequestCard,
  queueHasPendingWork,
  queueHasQueuedWork,
  queueItemSlug,
  queueStatusText,
  resolveRequesterChatId,
  queueItemBySlug,
  userRequestEvent,
  realPackUrl,
  shouldSchedulePipelineAfterProgress,
  shouldStartPipeline,
  sortQueuedItems,
  terminalProgress,
  unstickUploadingQueue,
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

function trackPipelineWait(deps = {}) {
  let pending;
  return {
    ...deps,
    waitUntil: (promise) => {
      pending = promise;
      return promise;
    },
    async flushPipeline() {
      if (pending) await pending;
    },
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
  assert.equal(sent.length, 2);
  assert.match(sent[0].text, /Начата загрузка/);
  assert.equal(sent[0].chatId, INITIAL_SUBSCRIBER);
  assert.equal(String(sent[1].chatId), String(INITIAL_SUBSCRIBER));
  assert.match(sent[1].text, /«Джек и Бевка» \| стикер 144 из 144 \| старт/);

  sent.length = 0;
  const done = await handle(progressRequest({ ...body, packUrl: PACK_URL }), env, { sendMessage });
  assert.equal(done.status, 200);
  const doneJson = await done.json();
  assert.equal(doneJson.posted, true);
  assert.equal(sent.length, 3);
  assert.match(sent[0].text, /^Готово:/);
  assert.equal(sent[0].chatId, INITIAL_SUBSCRIBER);
  assert.equal(sent[1].chatId, "@tg2tm");
  assert.match(sent[1].text, /8377/);
  assert.equal(String(sent[2].chatId), String(INITIAL_SUBSCRIBER));
  assert.match(sent[2].text, /ссылка/);
  assert.match(sent[2].text, /8377/);

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
  assert.ok(env.BOT_KV.ops.get >= 1);
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

test("admin chat gets another user's upload, edits the sticker count, and /status says idle or running", async () => {
  const env = envWith();
  env.LOGIN_CHAT_IDS = "8502935020";
  env.BOT_KV.store.set("meta:seeded", "1");
  const sent = [];
  const edited = [];
  const sendMessage = async (_env, chatId, text) => {
    sent.push({ chatId, text });
    return { message_id: sent.length };
  };
  const editMessage = async (_env, chatId, messageId, text) => {
    edited.push({ chatId, messageId, text });
  };
  const body = {
    slug: "08-maf-izis-i-agnes",
    title: "Маф, Изис и Агнес",
    status: "uploading",
    uploaded: 1,
    total: 144,
    requester: "111",
  };
  await handle(progressRequest(body), env, { sendMessage, editMessage });
  assert.equal(sent.some((row) => String(row.chatId) === "8502935020"), true);
  assert.match(sent.map((row) => row.text).join("\n"), /запрос: 111/);
  sent.length = 0;
  await handle(progressRequest({ ...body, uploaded: 2 }), env, { sendMessage, editMessage });
  await handle(progressRequest({ ...body, uploaded: 3 }), env, { sendMessage, editMessage });
  assert.equal(edited.length, 2);
  assert.equal(sent.length, 0);
  assert.match(edited[1].text, /стикер 3 из 144/);
  assert.equal(String(edited[0].chatId), "8502935020");

  const idle = [];
  await handle(packMessage(8502935020, "/status"), env, {
    sendMessage: async (_env, _chatId, text) => idle.push(text),
  });
  assert.equal(idle[0], "простаивает");

  const mafItem = {
    id: "req-maf",
    chatId: "111",
    title: "Маф, Изис и Агнес",
    links: ["https://t.me/addstickers/maf"],
    priority: false,
    createdAt: "2026-10-13T12:00:00.000Z",
    status: "uploading",
    stickers: 144,
  };
  env.BOT_KV.store.set(
    "queue",
    JSON.stringify({
      priority: [],
      items: [mafItem],
    }),
  );
  env.BOT_KV.store.set(
    `pack:${queueItemSlug(mafItem)}`,
    JSON.stringify({
      slug: queueItemSlug(mafItem),
      title: mafItem.title,
      status: "uploading",
      uploaded: 3,
      total: 144,
    }),
  );
  idle.length = 0;
  await handle(packMessage(8502935020, "/status"), env, {
    sendMessage: async (_env, _chatId, text) => idle.push(text),
  });
  assert.match(idle[0], /идёт \| «Маф, Изис и Агнес» \| стикер 3 из 144/);
});

test("progress that the uploader already told the admin does not send a second card", async () => {
  const sent = [];
  const env = envWith();
  await handle(progressRequest({
    slug: "08-maf-izis-i-agnes",
    title: "Маф, Изис и Агнес",
    status: "uploading",
    uploaded: 1,
    total: 144,
    adminDelivered: true,
    phase: "sending",
  }), env, {
    sendMessage: async (_env, _chatId, text) => sent.push(text),
  });
  assert.equal(sent.some((text) => text.includes("стикер 1 из 144")), false);
  assert.equal(sent.some((text) => text.includes("Начата загрузка")), true);
});

function packMessage(chatId, text) {
  return new Request("https://tg2tmbot.example/telegram", {
    method: "POST",
    headers: { "X-Telegram-Bot-Api-Secret-Token": "webhook-secret", "content-type": "application/json" },
    body: JSON.stringify({ message: { chat: { id: chatId }, text } }),
  });
}

async function acceptPackMessage(chatId, text, env, deps) {
  await handle(telegramRequest(chatId, "/create"), env, { sendMessage: async () => ({}) });
  return handle(packMessage(chatId, text), env, deps);
}

test("a priority chat is queued ahead of an older normal request, behind an active upload", () => {
  let queue = { ...emptyQueue(), priority: ["111"] };
  const normal = enqueueRequest(queue, {
    chatId: 222,
    title: "Обычный",
    links: ["https://t.me/addstickers/normal_pack"],
    priority: false,
    createdAt: "2026-10-12T14:00:00.000Z",
    stickers: 10,
  });
  queue = normal.queue;
  const first = enqueueRequest(queue, {
    chatId: 111,
    title: "Первый",
    links: ["https://t.me/addstickers/first_pack"],
    priority: true,
    createdAt: "2026-10-12T14:01:00.000Z",
    stickers: 12,
  });
  queue = first.queue;
  const second = enqueueRequest(queue, {
    chatId: 111,
    title: "Второй",
    links: ["https://t.me/addstickers/second_pack"],
    priority: true,
    createdAt: "2026-10-12T14:02:00.000Z",
    stickers: 8,
  });
  queue = second.queue;
  const claimed = claimNext(queue);
  assert.equal(claimed.claimed.title, "Первый");
  assert.equal(claimed.busy, false);
  const again = claimNext(claimed.queue);
  assert.equal(again.busy, true);
  assert.equal(again.changed, false);
  assert.equal(again.claimed.title, "Первый");
  assert.equal(queueStatusText(claimed.queue, 111).includes("Второй"), true);
  assert.match(queueStatusText(claimed.queue, 111), /перед ним 1/);
  assert.doesNotMatch(queueStatusText(claimed.queue, 222), /111/);
});

test("a finished request is not enqueued again", () => {
  let queue = emptyQueue();
  const req = {
    chatId: 42,
    title: "Лис",
    links: ["https://t.me/addstickers/fox_one"],
    priority: false,
    createdAt: "2026-10-12T14:00:00.000Z",
    stickers: 5,
  };
  const first = enqueueRequest(queue, req);
  queue = first.queue;
  queue = {
    ...queue,
    items: queue.items.map((item) => ({ ...item, status: "done" })),
  };
  const again = enqueueRequest(queue, req);
  assert.equal(again.created, false);
  assert.equal(again.duplicate, "done");
});

test("progress done releases the uploading row and dispatches the next restart", async () => {
  const env = envWith();
  env.GH_DISPATCH_TOKEN = "dispatch-token";
  env.BOT_KV.store.set(
    "queue",
    JSON.stringify({
      priority: [],
      items: [
        {
          id: "req-1",
          chatId: "99",
          title: "Запад",
          links: ["https://t.me/addstickers/zapad"],
          priority: false,
          createdAt: "2026-10-13T12:00:00.000Z",
          status: "uploading",
          stickers: 10,
        },
        {
          id: "req-2",
          chatId: "100",
          title: "Восток",
          links: ["https://t.me/addstickers/vostok"],
          priority: false,
          createdAt: "2026-10-13T12:01:00.000Z",
          status: "queued",
          stickers: 8,
        },
      ],
    }),
  );
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({
      url: String(url),
      body: init && init.body ? JSON.parse(init.body) : null,
    });
    if (String(url).includes("/runs?")) {
      return { status: 200, json: async () => ({ workflow_runs: [] }) };
    }
    return { status: 204, json: async () => ({}) };
  };
  const sendMessage = async () => ({ message_id: 1 });
  const body = {
    slug: "request-req-1",
    title: "Запад",
    status: "done",
    uploaded: 10,
    total: 10,
    packUrl: PACK_URL,
    queueRequestId: "req-1",
    adminDelivered: true,
  };
  const pipe = trackPipelineWait({ sendMessage, fetch });
  await handle(progressRequest(body), env, pipe);
  await pipe.flushPipeline();
  const stored = JSON.parse(env.BOT_KV.store.get("queue"));
  assert.equal(stored.items[0].status, "done");
  const dispatch = calls.find((call) => call.url.endsWith("/dispatches"));
  assert.ok(dispatch);
  assert.match(dispatch.body.inputs.dispatch_reason, /Восток/);
});

test("sessionDrain terminal progress releases but does not dispatch another Actions run", async () => {
  const env = envWith();
  env.GH_DISPATCH_TOKEN = "dispatch-token";
  env.BOT_KV.store.set(
    "queue",
    JSON.stringify({
      priority: [],
      items: [
        {
          id: "req-1",
          chatId: "99",
          title: "Запад",
          links: ["https://t.me/addstickers/zapad"],
          priority: false,
          createdAt: "2026-10-13T12:00:00.000Z",
          status: "uploading",
          stickers: 10,
        },
        {
          id: "req-2",
          chatId: "100",
          title: "Восток",
          links: ["https://t.me/addstickers/vostok"],
          priority: false,
          createdAt: "2026-10-13T12:01:00.000Z",
          status: "queued",
          stickers: 8,
        },
      ],
    }),
  );
  const calls = [];
  const fetch = async (url) => {
    calls.push(String(url));
    if (String(url).includes("/runs?")) {
      return { status: 200, json: async () => ({ workflow_runs: [] }) };
    }
    return { status: 204, json: async () => ({}) };
  };
  const body = {
    slug: "request-req-1",
    title: "Запад",
    status: "done",
    uploaded: 10,
    total: 10,
    packUrl: PACK_URL,
    queueRequestId: "req-1",
    adminDelivered: true,
    sessionDrain: true,
  };
  assert.equal(shouldSchedulePipelineAfterProgress(normalizeProgress(body)), false);
  const pipe = trackPipelineWait({ sendMessage: async () => ({ message_id: 1 }), fetch });
  await handle(progressRequest(body), env, pipe);
  await pipe.flushPipeline();
  const stored = JSON.parse(env.BOT_KV.store.get("queue"));
  assert.equal(stored.items[0].status, "done");
  assert.equal(calls.some((url) => url.endsWith("/dispatches")), false);
});

test("drain-complete schedules when queued work remains after session ends", async () => {
  const env = envWith();
  env.GH_DISPATCH_TOKEN = "dispatch-token";
  env.BOT_KV.store.set(
    "queue",
    JSON.stringify({
      priority: [],
      items: [
        {
          id: "req-2",
          chatId: "100",
          title: "Восток",
          links: ["https://t.me/addstickers/vostok"],
          priority: false,
          createdAt: "2026-10-13T12:01:00.000Z",
          status: "queued",
          stickers: 8,
        },
      ],
    }),
  );
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({
      url: String(url),
      body: init && init.body ? JSON.parse(init.body) : null,
    });
    if (String(url).includes("/runs?")) {
      return { status: 200, json: async () => ({ workflow_runs: [] }) };
    }
    return { status: 204, json: async () => ({}) };
  };
  const pipe = trackPipelineWait({ sendMessage: async () => ({}), fetch });
  const req = new Request("https://tg2tmbot.example/queue/drain-complete", {
    method: "POST",
    headers: { authorization: "Bearer uploader-secret" },
    body: "{}",
  });
  await handle(req, env, pipe);
  await pipe.flushPipeline();
  const dispatch = calls.find((call) => call.url.endsWith("/dispatches"));
  assert.ok(dispatch);
  assert.match(dispatch.body.inputs.dispatch_reason, /Восток/);
});

test("an accepted pack dispatches restart when Actions is idle", async () => {
  const env = envWith();
  env.GH_DISPATCH_TOKEN = "dispatch-token";
  env.BOT_KV.store.set("meta:seeded", "1");
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({
      url: String(url),
      body: init && init.body ? JSON.parse(init.body) : null,
    });
    if (String(url).includes("/runs?")) {
      return { status: 200, json: async () => ({ workflow_runs: [] }) };
    }
    return { status: 204, json: async () => ({}) };
  };
  const text = "Запад\n\nhttps://t.me/addstickers/zapad";
  const pipe = trackPipelineWait({
    sendMessage: async () => {},
    stickerCount: async () => 10,
    fetch,
  });
  await acceptPackMessage(4242, text, env, pipe);
  await pipe.flushPipeline();
  const dispatch = calls.find((call) => call.url.endsWith("/dispatches"));
  assert.ok(dispatch);
  assert.match(dispatch.body.inputs.dispatch_reason, /Запад/);
});

test("pipeline start waits while a Telemost run is already active", () => {
  const queue = enqueueRequest(emptyQueue(), {
    chatId: 1,
    title: "A",
    links: ["https://t.me/addstickers/a"],
    priority: false,
    createdAt: "1",
    stickers: 1,
  }).queue;
  queue.items[0].status = "uploading";
  assert.equal(shouldStartPipeline(queue, true), false);
  assert.equal(shouldStartPipeline(queue, false), false);
  assert.equal(queueHasPendingWork(queue), true);
  assert.equal(queueHasQueuedWork(queue), false);
  assert.equal(findUploadingReleaseId(queue, { title: "A", queueRequestId: queue.items[0].id }), queue.items[0].id);
  assert.equal(terminalProgress({ status: "done", url: PACK_URL }), true);
});

test("pipeline autostart needs a queued row, not a stuck uploading row alone", () => {
  let queue = enqueueRequest(emptyQueue(), {
    chatId: 1,
    title: "A",
    links: ["https://t.me/addstickers/a"],
    priority: false,
    createdAt: "1",
    stickers: 1,
  }).queue;
  queue.items[0].status = "uploading";
  assert.equal(shouldStartPipeline(queue, false), false);
  queue = enqueueRequest(queue, {
    chatId: 2,
    title: "B",
    links: ["https://t.me/addstickers/b"],
    priority: false,
    createdAt: "2",
    stickers: 1,
  }).queue;
  assert.equal(shouldStartPipeline(queue, false), true);
});

test("an accepted priority request is one KV write and /status does not list", async () => {
  const env = envWith();
  env.BOT_KV.store.set("meta:seeded", "1");
  env.BOT_KV.store.set("queue", JSON.stringify({ priority: ["111"], items: [] }));
  const sent = [];
  const text = "Лисёнок\n\nhttps://t.me/addstickers/fox_one\nhttps://t.me/addstickers/fox_two";
  env.BOT_KV.ops.get = 0;
  env.BOT_KV.ops.put = 0;
  env.BOT_KV.ops.list = 0;
  const res = await acceptPackMessage(111, text, env, {
    sendMessage: async (_env, chatId, reply) => sent.push({ chatId, reply }),
    stickerCount: async () => 10,
  });
  assert.equal(res.status, 200);
  assert.equal(sent[0].chatId, 111);
  assert.match(sent[0].reply, /Запрос принят с приоритетом/);
  assert.match(sent[0].reply, /«Лисёнок»/);
  assert.match(sent[0].reply, /Всего 20 стикеров/);
  assert.doesNotMatch(sent[0].reply, /8502935020|владел/);
  assert.ok(env.BOT_KV.ops.put >= 1);
  assert.equal(env.BOT_KV.ops.list, 0);
  const stored = JSON.parse(env.BOT_KV.store.get("queue"));
  assert.equal(stored.items.length, 1);
  assert.equal(stored.items[0].priority, true);
  assert.deepEqual(stored.items[0].links, [
    "https://t.me/addstickers/fox_one",
    "https://t.me/addstickers/fox_two",
  ]);
  assert.equal(stored.items[0].chatId, "111");
  assert.equal(stored.items[0].stickers, 20);

  env.BOT_KV.ops.get = 0;
  env.BOT_KV.ops.put = 0;
  env.BOT_KV.ops.list = 0;
  sent.length = 0;
  await handle(packMessage(111, "/status"), env, {
    sendMessage: async (_env, _chatId, reply) => sent.push(reply),
  });
  assert.match(sent[0], /«Лисёнок» с приоритетом: в очереди, перед ним 0/);
  assert.equal(env.BOT_KV.ops.list, 0);
  assert.equal(env.BOT_KV.ops.put, 0);

  env.BOT_KV.ops.put = 0;
  await acceptPackMessage(111, text, env, {
    sendMessage: async () => {},
    stickerCount: async () => 10,
  });
  assert.equal(JSON.parse(env.BOT_KV.store.get("queue")).items.length, 1);
});

test("claim takes the priority request and does not replace an active one", async () => {
  const env = envWith();
  let queue = { ...emptyQueue(), priority: ["111"] };
  queue = enqueueRequest(queue, {
    chatId: 222,
    title: "Обычный",
    links: ["https://t.me/addstickers/normal_pack"],
    priority: false,
    createdAt: "2026-10-12T14:00:00.000Z",
    stickers: 4,
  }).queue;
  queue = enqueueRequest(queue, {
    chatId: 111,
    title: "Первый",
    links: ["https://t.me/addstickers/first_pack"],
    priority: true,
    createdAt: "2026-10-12T14:05:00.000Z",
    stickers: 6,
  }).queue;
  env.BOT_KV.store.set("queue", JSON.stringify(queue));
  const claim = async (body) =>
    handle(
      new Request("https://tg2tmbot.example/queue/claim", {
        method: "POST",
        headers: { authorization: "Bearer uploader-secret", "content-type": "application/json" },
        body: body ? JSON.stringify(body) : "",
      }),
      env,
    );
  const denied = await handle(
    new Request("https://tg2tmbot.example/queue/claim", { method: "POST", body: "{}" }),
    env,
  );
  assert.equal(denied.status, 401);
  env.BOT_KV.ops.put = 0;
  const first = await claim();
  assert.equal(first.status, 200);
  const firstJson = await first.json();
  assert.equal(firstJson.claimed.title, "Первый");
  assert.equal(firstJson.claimed.priority, true);
  assert.equal(firstJson.active, false);
  assert.equal(env.BOT_KV.ops.put, 1);
  env.BOT_KV.ops.put = 0;
  const busy = await claim();
  const busyJson = await busy.json();
  assert.equal(busyJson.active, true);
  assert.equal(busyJson.claimed.title, "Первый");
  assert.equal(env.BOT_KV.ops.put, 0);
  const released = await claim({ release: { id: firstJson.claimed.id, status: "done" } });
  const releasedJson = await released.json();
  assert.equal(releasedJson.claimed, null);
  const stored = JSON.parse(env.BOT_KV.store.get("queue"));
  assert.equal(stored.items.find((item) => item.title === "Первый").status, "done");
  assert.equal(stored.items.find((item) => item.title === "Обычный").status, "queued");
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
  assert.equal(USER_COMMANDS.find((item) => item.command === "create").description, "Новый запрос на перенос");
  assert.equal(USER_COMMANDS.find((item) => item.command === "start").description, "Как пользоваться");
  assert.equal(USER_COMMANDS.find((item) => item.command === "format").description, "Формат и пример пака");
  assert.equal(USER_COMMANDS.some((item) => item.command === "example"), false);
  assert.equal(ADMIN_ONLY_COMMANDS.find((item) => item.command === "queue").description, "Очередь и прогресс");
  assert.equal(ADMIN_COMMANDS.length, USER_COMMANDS.length + ADMIN_ONLY_COMMANDS.length);
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

test("a pack-shaped message without /create asks for /create first", async () => {
  const sent = [];
  const text = "Минто\n\nhttps://t.me/addstickers/minty_vk\nhttps://t.me/addstickers/minty2_vk";
  await handle(packMessage(7, text), envWith(), {
    sendMessage: async (_env, _chatId, reply) => sent.push(reply),
    stickerCount: async () => 80,
  });
  assert.match(sent[0], /\/create/);
});

test("after /create a pack-shaped message counts stickers and enforces 150", async () => {
  const sent = [];
  const env = envWith();
  const text = "Минто\n\nhttps://t.me/addstickers/minty_vk\nhttps://t.me/addstickers/minty2_vk";
  const res = await acceptPackMessage(7, text, env, {
    sendMessage: async (_env, _chatId, reply) => sent.push(reply),
    stickerCount: async (_env, name) => (name === "minty_vk" ? 80 : 80),
  });
  assert.equal(res.status, 200);
  assert.match(sent.find((line) => /Пак «Минто»/.test(line)), /Пак «Минто»/);
  assert.match(sent.find((line) => /minty_vk — 80/.test(line)), /minty_vk — 80/);
  assert.match(sent.find((line) => /больше лимита 150/.test(line)), /больше лимита 150/);
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
  assert.deepEqual(calls[0].body.inputs, {
    mode: "login",
    account: "default",
    chat_id: "8502935020",
    packs: "",
    dispatch_reason: "админ: /login или /connect",
  });
  assert.deepEqual(calls[1].body.inputs, {
    mode: "login",
    account: "work",
    chat_id: "8502935020",
    packs: "",
    dispatch_reason: "админ: /login или /connect",
  });
  assert.match(sent[0].text, /QR-код Яндекса/);
  assert.match(sent[1].text, /«work»/);
  assert.equal(ADMIN_ONLY_COMMANDS.find((item) => item.command === "login").description, "Войти в Яндекс");
  assert.equal(ADMIN_ONLY_COMMANDS.find((item) => item.command === "connect").description, "Войти в аккаунт с меткой");
  assert.equal(ADMIN_ONLY_COMMANDS.find((item) => item.command === "restart").description, "Перезапустить загрузку");
});

test("/restart is only for the admin chat, cancels the running job, and dispatches one restart from main", async () => {
  const sent = [];
  const calls = [];
  const env = { ...envWith(), LOGIN_CHAT_IDS: "111,8502935020", GH_DISPATCH_TOKEN: "dispatch-token" };
  let lists = 0;
  const fetch = async (url, init) => {
    calls.push({ url, method: init && init.method, body: init && init.body ? JSON.parse(init.body) : null, authorization: init.headers.authorization });
    if (String(url).includes("/runs?")) {
      lists += 1;
      const runs = lists === 1
        ? [{ id: 38392857620, status: "in_progress", html_url: "https://github.com/pretendless/tg2tm/actions/runs/38392857620", created_at: "2026-10-13T11:49:14Z" }]
        : [{ id: 383999, status: "queued", html_url: "https://github.com/pretendless/tg2tm/actions/runs/383999", created_at: new Date().toISOString() }];
      return { status: 200, json: async () => ({ workflow_runs: runs }) };
    }
    return { status: init && init.method === "POST" && String(url).endsWith("/cancel") ? 202 : 204, json: async () => ({}) };
  };
  const sendMessage = async (_env, chatId, text) => sent.push({ chatId, text });
  const refused = await handle(telegramRequest(111, "/restart"), env, { sendMessage, fetch, sleep: async () => {} });
  assert.equal(refused.status, 200);
  assert.equal(calls.length, 0);
  assert.equal(sent[0].text, "Эта команда только для администратора.");
  env.BOT_KV.store.set(
    "queue",
    JSON.stringify({
      priority: [],
      items: [
        {
          id: "req-1",
          chatId: "99",
          title: "Запад",
          links: ["https://t.me/addstickers/zapad"],
          priority: false,
          createdAt: "2026-10-13T12:00:00.000Z",
          status: "uploading",
          stickers: 10,
        },
      ],
    }),
  );
  await handle(telegramRequest(8502935020, "/restart"), env, { sendMessage, fetch, sleep: async () => {} });
  const dispatch = calls.find((call) => String(call.url).endsWith("/dispatches"));
  assert.equal(dispatch.body.ref, "main");
  assert.deepEqual(dispatch.body.inputs, {
    mode: "restart",
    account: "default",
    chat_id: "8502935020",
    packs: "",
    dispatch_reason: "админ: /restart — «Запад»",
  });
  const dispatchAt = calls.findIndex((call) => String(call.url).endsWith("/dispatches"));
  const cancelAt = calls.findIndex((call) => String(call.url).endsWith("/38392857620/cancel"));
  assert.equal(dispatchAt < cancelAt, true);
  assert.match(sent[1].text, /отдельным сообщением/);
  assert.equal(sent[1].text.includes("383999"), false);
  assert.equal(sent[1].text.includes("dispatch-token"), false);
  assert.match(sent[1].text, /\/done/);
});

test("/queue lists priority queued rows before normal ones", () => {
  let queue = emptyQueue();
  queue = enqueueRequest(queue, {
    chatId: 1,
    title: "Дьяволица",
    links: ["https://t.me/addstickers/dev"],
    priority: false,
    createdAt: "2026-10-13T10:00:00.000Z",
    stickers: 5,
  }).queue;
  queue = enqueueRequest(queue, {
    chatId: 2,
    title: "Tom & Jerry",
    links: ["https://t.me/addstickers/tj"],
    priority: false,
    createdAt: "2026-10-13T10:01:00.000Z",
    stickers: 5,
  }).queue;
  queue = enqueueRequest(queue, {
    chatId: 3,
    title: "ВолнаСветa",
    links: ["https://t.me/addstickers/wave"],
    priority: true,
    createdAt: "2026-10-13T10:02:00.000Z",
    stickers: 5,
  }).queue;
  const ordered = sortQueuedItems(queue.items).map((item) => item.title);
  assert.deepEqual(ordered, ["ВолнаСветa", "Дьяволица", "Tom & Jerry"]);
  const text = adminQueueOverviewText(queue, null);
  const block = text.split("В очереди:")[1].split("Недавно:")[0];
  assert.ok(block.indexOf("ВолнаСветa") < block.indexOf("Дьяволица"));
  assert.ok(block.indexOf("Дьяволица") < block.indexOf("Tom & Jerry"));
});

test("/unstick refuses while Actions runs and releases uploading when idle", async () => {
  const env = envWith();
  env.LOGIN_CHAT_IDS = String(INITIAL_SUBSCRIBER);
  env.GH_DISPATCH_TOKEN = "dispatch-token";
  env.BOT_KV.store.set(
    "queue",
    JSON.stringify({
      priority: [],
      items: [
        {
          id: "req-stuck",
          chatId: "1",
          title: "Застрял",
          links: ["https://t.me/addstickers/stuck"],
          priority: false,
          createdAt: "2026-10-13T12:00:00.000Z",
          status: "uploading",
          stickers: 3,
        },
        {
          id: "req-next",
          chatId: "2",
          title: "Следующий",
          links: ["https://t.me/addstickers/next"],
          priority: false,
          createdAt: "2026-10-13T12:01:00.000Z",
          status: "queued",
          stickers: 4,
        },
      ],
    }),
  );
  const sent = [];
  const fetchBusy = async (url) => {
    if (String(url).includes("/runs?")) {
      return { status: 200, json: async () => ({ workflow_runs: [{ id: 1, status: "in_progress" }] }) };
    }
    return { status: 204, json: async () => ({}) };
  };
  await handle(packMessage(INITIAL_SUBSCRIBER, "/unstick"), env, {
    sendMessage: async (_env, _chatId, text) => sent.push(text),
    fetch: fetchBusy,
  });
  assert.match(sent[0], /Actions/);
  assert.match(sent[0], /не трогаю/);
  let stored = JSON.parse(env.BOT_KV.store.get("queue"));
  assert.equal(stored.items[0].status, "uploading");

  sent.length = 0;
  const calls = [];
  const fetchIdle = async (url, init) => {
    calls.push({
      url: String(url),
      body: init && init.body ? JSON.parse(init.body) : null,
    });
    if (String(url).includes("/runs?")) {
      return { status: 200, json: async () => ({ workflow_runs: [] }) };
    }
    return { status: 204, json: async () => ({}) };
  };
  const pipe = trackPipelineWait({
    sendMessage: async (_env, _chatId, text) => sent.push(text),
    fetch: fetchIdle,
  });
  await handle(packMessage(INITIAL_SUBSCRIBER, "/unstick"), env, pipe);
  await pipe.flushPipeline();
  assert.match(sent[0], /Застрял/);
  assert.match(sent[0], /блокировку «загружается»/);
  assert.match(sent[0], /ждёт в очереди/);
  assert.doesNotMatch(sent[0], /снова в очереди/);
  assert.match(sent[0], /Запускаю pipeline/);
  stored = JSON.parse(env.BOT_KV.store.get("queue"));
  assert.equal(stored.items.find((item) => item.id === "req-stuck").status, "queued");
  assert.equal(unstickUploadingQueue(stored).changed, false);
  const dispatch = calls.find((call) => call.url.endsWith("/dispatches"));
  assert.ok(dispatch);
  assert.match(dispatch.body.inputs.dispatch_reason, /unstick|Следующий|Застрял/i);
});

test("terminal progress releases queue row matched by slug when status is queued", async () => {
  const env = envWith();
  const item = {
    id: "req-snupy",
    chatId: "1",
    title: "Снупи",
    links: ["https://t.me/addstickers/snoopy"],
    priority: false,
    createdAt: "2026-10-13T12:00:00.000Z",
    status: "queued",
    stickers: 5,
  };
  const slug = queueItemSlug(item);
  env.BOT_KV.store.set("queue", JSON.stringify({ priority: [], items: [item] }));
  env.BOT_KV.store.set(
    `pack:${slug}`,
    JSON.stringify({ slug, title: item.title, status: "done", uploaded: 5, total: 5, url: PACK_URL }),
  );
  env.GH_DISPATCH_TOKEN = "dispatch-token";
  const fetch = async (url) => {
    if (String(url).includes("/runs?")) {
      return { status: 200, json: async () => ({ workflow_runs: [] }) };
    }
    return { status: 204, json: async () => ({}) };
  };
  await handle(
    progressRequest({
      slug,
      title: item.title,
      status: "done",
      uploaded: 5,
      total: 5,
      packUrl: PACK_URL,
      queueRequestId: item.id,
      adminDelivered: true,
    }),
    env,
    { sendMessage: async () => ({}), fetch, waitUntil: (p) => p },
  );
  const stored = JSON.parse(env.BOT_KV.store.get("queue"));
  assert.equal(stored.items[0].status, "done");
});

test("repeat terminal progress retries queue release when KV pack was already done", async () => {
  const env = envWith();
  const item = {
    id: "req-stuck-done",
    chatId: "1",
    title: "Застрял готов",
    links: ["https://t.me/addstickers/x"],
    priority: false,
    createdAt: "2026-10-13T12:00:00.000Z",
    status: "uploading",
    stickers: 3,
  };
  const slug = queueItemSlug(item);
  env.BOT_KV.store.set(
    "queue",
    JSON.stringify({
      priority: [],
      items: [
        item,
        {
          id: "req-next",
          chatId: "2",
          title: "Следующий",
          links: ["https://t.me/addstickers/y"],
          priority: false,
          createdAt: "2026-10-13T12:01:00.000Z",
          status: "queued",
          stickers: 4,
        },
      ],
    }),
  );
  env.BOT_KV.store.set(
    `pack:${slug}`,
    JSON.stringify({
      slug,
      title: item.title,
      status: "done",
      uploaded: 3,
      total: 3,
      url: PACK_URL,
      notice: { started: true, step: 75, done: true, doneWithLink: true, posted: true },
    }),
  );
  env.GH_DISPATCH_TOKEN = "dispatch-token";
  let dispatches = 0;
  const fetch = async (url, init) => {
    if (String(url).includes("/runs?")) {
      return { status: 200, json: async () => ({ workflow_runs: [] }) };
    }
    if (String(url).endsWith("/dispatches")) dispatches += 1;
    return { status: 204, json: async () => ({}) };
  };
  const body = {
    slug,
    title: item.title,
    status: "done",
    uploaded: 3,
    total: 3,
    packUrl: PACK_URL,
    queueRequestId: item.id,
    adminDelivered: true,
  };
  const pipe = trackPipelineWait({ sendMessage: async () => ({}), fetch });
  await handle(progressRequest(body), env, pipe);
  await pipe.flushPipeline();
  const stored = JSON.parse(env.BOT_KV.store.get("queue"));
  assert.equal(stored.items.find((row) => row.id === item.id).status, "done");
  assert.equal(stored.items.find((row) => row.id === "req-next").status, "queued");
  assert.equal(dispatches, 1);
});

test("/unstick marks uploading as done when pack progress is already terminal", () => {
  const item = {
    id: "req-done",
    chatId: "1",
    title: "Готовый",
    links: ["https://t.me/addstickers/d"],
    priority: false,
    createdAt: "1",
    status: "uploading",
    stickers: 2,
  };
  const queue = { priority: [], items: [item, { ...item, id: "req-wait", title: "Ждёт", status: "queued" }] };
  const slug = queueItemSlug(item);
  const result = unstickUploadingQueue(queue, {
    packForItem: () => ({ slug, title: item.title, status: "done", uploaded: 2, total: 2, url: PACK_URL }),
  });
  assert.equal(result.finished.length, 1);
  assert.equal(result.released.length, 0);
  assert.equal(result.queue.items[0].status, "done");
  assert.equal(result.queue.items[1].status, "queued");
});

test("findUploadingReleaseId matches slug for queued row", () => {
  const item = { id: "abc-1", chatId: "1", title: "T", links: [], priority: false, createdAt: "1", status: "queued" };
  const slug = queueItemSlug(item);
  const id = findUploadingReleaseId({ items: [item] }, { slug, title: "T", queueRequestId: "abc-1" });
  assert.equal(id, "abc-1");
});

test("findUploadingReleaseId prefers slug over a stale queueRequestId", () => {
  const active = {
    id: "req-live",
    chatId: "1",
    title: "ВолнаСвета",
    links: [],
    priority: false,
    createdAt: "1",
    status: "uploading",
  };
  const stale = {
    id: "req-stale",
    chatId: "2",
    title: "Другой",
    links: [],
    priority: false,
    createdAt: "2",
    status: "queued",
  };
  const slug = queueItemSlug(active);
  const id = findUploadingReleaseId(
    { items: [active, stale] },
    { slug, title: active.title, queueRequestId: stale.id },
  );
  assert.equal(id, "req-live");
});

test("admin /status reconciles terminal pack KV and reports idle", async () => {
  const env = envWith();
  env.LOGIN_CHAT_IDS = String(INITIAL_SUBSCRIBER);
  const item = {
    id: "req-wave",
    chatId: "1",
    title: "ВолнаСвета",
    links: ["https://t.me/addstickers/wave"],
    priority: false,
    createdAt: "2026-10-13T12:00:00.000Z",
    status: "uploading",
    stickers: 79,
  };
  const slug = queueItemSlug(item);
  env.BOT_KV.store.set("queue", JSON.stringify({ priority: [], items: [item] }));
  env.BOT_KV.store.set(
    `pack:${slug}`,
    JSON.stringify({
      slug,
      title: item.title,
      status: "done",
      uploaded: 79,
      total: 79,
      url: PACK_URL,
      notice: { started: true, step: 75, done: true, doneWithLink: true, posted: true },
    }),
  );
  const replies = [];
  await handle(packMessage(INITIAL_SUBSCRIBER, "/status"), env, {
    sendMessage: async (_env, _chatId, text) => {
      replies.push(text);
    },
  });
  assert.equal(replies[0], "простаивает");
  const stored = JSON.parse(env.BOT_KV.store.get("queue"));
  assert.equal(stored.items[0].status, "done");
});

test("terminal progress releases the queue even when the channel post fails", async () => {
  const env = envWith();
  const item = {
    id: "req-1",
    chatId: "99",
    title: "Запад",
    links: ["https://t.me/addstickers/zapad"],
    priority: false,
    createdAt: "2026-10-13T12:00:00.000Z",
    status: "uploading",
    stickers: 10,
  };
  env.BOT_KV.store.set("queue", JSON.stringify({ priority: [], items: [item] }));
  const sendMessage = async (_env, chatId) => {
    if (String(chatId) === "@tg2tm") throw new Error("channel down");
    return { message_id: 1 };
  };
  const res = await handle(
    progressRequest({
      slug: queueItemSlug(item),
      title: item.title,
      status: "done",
      uploaded: 10,
      total: 10,
      packUrl: PACK_URL,
      queueRequestId: item.id,
      adminDelivered: true,
    }),
    env,
    { sendMessage },
  );
  assert.equal(res.status, 502);
  const stored = JSON.parse(env.BOT_KV.store.get("queue"));
  assert.equal(stored.items[0].status, "done");
});

test("/unstick autostart dispatch names next queued pack after terminal uploading row closes", async () => {
  const env = envWith();
  env.LOGIN_CHAT_IDS = String(INITIAL_SUBSCRIBER);
  env.GH_DISPATCH_TOKEN = "dispatch-token";
  const snoopy = {
    id: "req-snoopy",
    chatId: "1",
    title: "Снупи",
    links: ["https://t.me/addstickers/snoopy"],
    priority: false,
    createdAt: "2026-10-13T12:00:00.000Z",
    status: "uploading",
    stickers: 80,
  };
  const wave = {
    id: "req-wave",
    chatId: "2",
    title: "ВолнаСветa",
    links: ["https://t.me/addstickers/wave"],
    priority: true,
    createdAt: "2026-10-13T12:01:00.000Z",
    status: "queued",
    stickers: 10,
  };
  env.BOT_KV.store.set("queue", JSON.stringify({ priority: ["2"], items: [snoopy, wave] }));
  env.BOT_KV.store.set(
    `pack:${queueItemSlug(snoopy)}`,
    JSON.stringify({
      slug: queueItemSlug(snoopy),
      title: snoopy.title,
      status: "done",
      uploaded: 80,
      total: 80,
      url: PACK_URL,
    }),
  );
  const calls = [];
  const fetchIdle = async (url, init) => {
    calls.push({
      url: String(url),
      body: init && init.body ? JSON.parse(init.body) : null,
    });
    if (String(url).includes("/runs?")) {
      return { status: 200, json: async () => ({ workflow_runs: [] }) };
    }
    return { status: 204, json: async () => ({}) };
  };
  const pipe = trackPipelineWait({ sendMessage: async () => {}, fetch: fetchIdle });
  await handle(packMessage(INITIAL_SUBSCRIBER, "/unstick"), env, pipe);
  await pipe.flushPipeline();
  const stored = JSON.parse(env.BOT_KV.store.get("queue"));
  assert.equal(stored.items.find((item) => item.id === "req-snoopy").status, "done");
  const dispatch = calls.find((call) => call.url.endsWith("/dispatches"));
  assert.ok(dispatch);
  assert.match(dispatch.body.inputs.dispatch_reason, /ВолнаСветa/);
  assert.doesNotMatch(dispatch.body.inputs.dispatch_reason, /Снупи/);
});

test("admin /queue reads queue and one pack key for uploading progress", async () => {
  const env = envWith();
  env.LOGIN_CHAT_IDS = String(INITIAL_SUBSCRIBER);
  const item = {
    id: "req-1",
    chatId: "4242",
    title: "Запад",
    links: ["https://t.me/addstickers/zapad"],
    priority: false,
    createdAt: "2026-10-13T12:00:00.000Z",
    status: "uploading",
    stickers: 10,
  };
  env.BOT_KV.store.set(
    "queue",
    JSON.stringify({
      priority: [],
      items: [item, { ...item, id: "req-2", title: "Восток", status: "queued", chatId: "777" }],
    }),
  );
  env.BOT_KV.store.set(
    `pack:${queueItemSlug(item)}`,
    JSON.stringify({ slug: queueItemSlug(item), title: item.title, status: "uploading", uploaded: 3, total: 10 }),
  );
  const sent = [];
  env.BOT_KV.ops.list = 0;
  await handle(packMessage(INITIAL_SUBSCRIBER, "/queue"), env, {
    sendMessage: async (_env, _chatId, text) => sent.push(text),
  });
  assert.match(sent[0], /Запад/);
  assert.match(sent[0], /стикер 3 из 10/);
  assert.match(sent[0], /Восток/);
  assert.match(sent[0], /Подсказка:/);
  assert.equal(env.BOT_KV.ops.list, 0);
});

test("session-started notifies admin once per run id", async () => {
  const env = envWith();
  env.LOGIN_CHAT_IDS = String(INITIAL_SUBSCRIBER);
  const sent = [];
  const body = {
    runId: "999001",
    url: "https://github.com/pretendless/tg2tm/actions/runs/999001",
    reason: "очередь: новый запрос принят — «Лис»",
  };
  const req = new Request("https://tg2tmbot.example/session-started", {
    method: "POST",
    headers: { authorization: "Bearer uploader-secret", "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const first = await handle(req, env, {
    sendMessage: async (_env, chatId, text) => sent.push({ chatId, text }),
  });
  assert.equal(first.status, 200);
  assert.equal(sent.length, 1);
  assert.match(sent[0].text, /новый запрос принят/);
  assert.match(sent[0].text, /999001/);
  sent.length = 0;
  const second = await handle(
    new Request("https://tg2tmbot.example/session-started", {
      method: "POST",
      headers: { authorization: "Bearer uploader-secret", "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    env,
    {
      sendMessage: async (_env, _chatId, text) => sent.push(text),
    },
  );
  assert.equal(second.status, 200);
  assert.equal(sent.length, 0);
});

test("accept reply includes queue position and opens a user card", async () => {
  const env = envWith();
  env.BOT_KV.store.set("meta:seeded", "1");
  const sent = [];
  const text = "Лис\n\nhttps://t.me/addstickers/fox_one";
  await acceptPackMessage(4242, text, env, {
    sendMessage: async (_env, chatId, reply) => {
      sent.push({ chatId, reply });
      return { message_id: sent.length };
    },
    stickerCount: async () => 5,
  });
  assert.equal(sent.length, 2);
  assert.match(sent[0].reply, /перед вами/);
  assert.match(sent[1].reply, /в очереди/);
  const queue = JSON.parse(env.BOT_KV.store.get("queue"));
  assert.equal(queue.items[0].notifyMessageId, 2);
});

test("progress edits the queue requester card even when requester is the admin chat", async () => {
  const env = envWith();
  env.LOGIN_CHAT_IDS = "8502935020";
  env.BOT_KV.store.set("meta:seeded", "1");
  let queue = enqueueRequest(emptyQueue(), {
    chatId: 424242,
    title: "Fox",
    links: ["https://t.me/addstickers/fox"],
    priority: false,
    createdAt: "1",
    stickers: 5,
  }).queue;
  queue.items[0].status = "uploading";
  queue.items[0].notifyMessageId = 77;
  env.BOT_KV.store.set("queue", JSON.stringify(queue));
  const item = queue.items[0];
  const slug = queueItemSlug(item);
  const edited = [];
  const sendMessage = async (_env, chatId, text) => {
    edited.push({ chatId, text, kind: "send" });
    return { message_id: 1 };
  };
  const editMessage = async (_env, chatId, messageId, text) => {
    edited.push({ chatId, messageId, text, kind: "edit" });
  };
  await handle(
    progressRequest({
      slug,
      title: "Fox",
      status: "uploading",
      uploaded: 2,
      total: 5,
      queueRequestId: item.id,
      requester: "8502935020",
      adminDelivered: true,
    }),
    env,
    { sendMessage, editMessage },
  );
  assert.equal(edited.length, 1);
  assert.equal(String(edited[0].chatId), "424242");
  assert.equal(edited[0].kind, "edit");
  assert.equal(edited[0].messageId, 77);
  assert.match(edited[0].text, /стикер 2 из 5/);
});

test("resolveRequesterChatId prefers the queue item over progress requester", () => {
  const item = { chatId: "424242" };
  assert.equal(
    resolveRequesterChatId({ requesterChatId: "8502935020", requester: "8502935020" }, item),
    "424242",
  );
  const keyed = { ...item, id: "abc" };
  assert.equal(queueItemBySlug({ items: [keyed] }, queueItemSlug(keyed)), keyed);
});

test("user request card text follows upload progress", () => {
  const queue = enqueueRequest(emptyQueue(), {
    chatId: 42,
    title: "Лис",
    links: ["https://t.me/addstickers/fox"],
    priority: false,
    createdAt: "1",
    stickers: 12,
  }).queue;
  const item = queue.items[0];
  assert.match(formatUserRequestCard(userRequestEvent({ item, pack: null, queue })), /перед вами/);
  const uploading = userRequestEvent({
    item: { ...item, status: "uploading" },
    pack: { title: "Лис", status: "uploading", uploaded: 4, total: 12 },
    queue,
  });
  assert.match(formatUserRequestCard(uploading), /стикер 4 из 12/);
  assert.equal(adminQueueOverviewText(queue, { uploaded: 4, total: 12 }).includes("стикер 4 из 12"), false);
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

test("enqueue rejects a done title from another chat", () => {
  let queue = enqueueRequest(emptyQueue(), {
    chatId: 1,
    title: "Маф, Изис и Агнес",
    links: ["https://t.me/addstickers/a"],
    priority: false,
    createdAt: "1",
    stickers: 1,
  }).queue;
  queue = { ...queue, items: queue.items.map((item) => ({ ...item, status: "done" })) };
  const again = enqueueRequest(queue, {
    chatId: 2,
    title: "Маф, Изис и Агнес",
    links: ["https://t.me/addstickers/b"],
    priority: false,
    createdAt: "2",
    stickers: 1,
  });
  assert.equal(again.created, false);
  assert.equal(again.duplicate, "done");
});

test("admin chat accepts a pack without /create", async () => {
  const env = envWith();
  env.BOT_KV.store.set("meta:seeded", "1");
  const sent = [];
  const text = "Админ-пак\n\nhttps://t.me/addstickers/admin_set";
  await handle(packMessage(8502935020, text), env, {
    sendMessage: async (_env, _chatId, reply) => sent.push(reply),
    stickerCount: async () => 3,
  });
  assert.match(sent[0], /Запрос принят/);
  assert.equal(JSON.parse(env.BOT_KV.store.get("queue")).items.length, 1);
});

test("admin /status matches /queue when catalog pack KV is orphan", async () => {
  const env = envWith();
  env.LOGIN_CHAT_IDS = String(INITIAL_SUBSCRIBER);
  env.BOT_KV.store.set(
    "pack:07-set-redzh-i-letti",
    JSON.stringify({
      slug: "07-set-redzh-i-letti",
      title: "Сэт, Рэдж и Летти",
      status: "uploading",
      uploaded: 0,
      total: 144,
    }),
  );
  env.BOT_KV.store.set(
    "queue",
    JSON.stringify({
      priority: [],
      items: [
        {
          id: "req-maf",
          chatId: "1",
          title: "Maf",
          links: ["https://t.me/addstickers/maf"],
          priority: false,
          createdAt: "2026-10-13T10:00:00.000Z",
          status: "queued",
          stickers: 12,
        },
        {
          id: "req-dev",
          chatId: "2",
          title: "Дьяволица",
          links: ["https://t.me/addstickers/dev"],
          priority: false,
          createdAt: "2026-10-13T10:01:00.000Z",
          status: "queued",
          stickers: 10,
        },
      ],
    }),
  );
  const sent = [];
  await handle(packMessage(INITIAL_SUBSCRIBER, "/status"), env, {
    sendMessage: async (_env, _chatId, text) => sent.push(text),
  });
  assert.equal(sent[0], "простаивает");
  sent.length = 0;
  await handle(packMessage(INITIAL_SUBSCRIBER, "/queue"), env, {
    sendMessage: async (_env, _chatId, text) => sent.push(text),
  });
  assert.match(sent[0], /никто не загружается/);
  assert.match(sent[0], /Дьяволица/);
  assert.doesNotMatch(sent[0], /Сэт, Рэдж и Летти/);
});

test("admin /skip dispatches with afterSkip reason", async () => {
  const env = envWith();
  env.LOGIN_CHAT_IDS = String(INITIAL_SUBSCRIBER);
  env.GH_DISPATCH_TOKEN = "dispatch-token";
  env.BOT_KV.store.set(
    "queue",
    JSON.stringify({
      priority: [],
      items: [
        {
          id: "req-wave",
          chatId: "1",
          title: "ВолнаСветa",
          links: ["https://t.me/addstickers/wave"],
          priority: false,
          createdAt: "2026-10-13T12:00:00.000Z",
          status: "uploading",
          stickers: 5,
        },
        {
          id: "req-next",
          chatId: "2",
          title: "Дьяволица",
          links: ["https://t.me/addstickers/dev"],
          priority: false,
          createdAt: "2026-10-13T12:01:00.000Z",
          status: "queued",
          stickers: 8,
        },
      ],
    }),
  );
  const calls = [];
  const fetchIdle = async (url, init) => {
    calls.push({
      url: String(url),
      body: init && init.body ? JSON.parse(init.body) : null,
    });
    if (String(url).includes("/runs?")) {
      return { status: 200, json: async () => ({ workflow_runs: [] }) };
    }
    return { status: 204, json: async () => ({}) };
  };
  const pipe = trackPipelineWait({
    sendMessage: async () => {},
    fetch: fetchIdle,
  });
  await handle(packMessage(INITIAL_SUBSCRIBER, "/skip"), env, pipe);
  await pipe.flushPipeline();
  const dispatch = calls.find((call) => call.url.endsWith("/dispatches"));
  assert.ok(dispatch);
  assert.match(dispatch.body.inputs.dispatch_reason, /\/skip/);
  assert.match(dispatch.body.inputs.dispatch_reason, /Дьяволица/);
  const stored = JSON.parse(env.BOT_KV.store.get("queue"));
  assert.equal(stored.items.find((row) => row.id === "req-wave").status, "error");
});

test("/format, /example and /stop", async () => {
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
      body: JSON.stringify({ message: { chat: { id: INITIAL_SUBSCRIBER }, text: "/example" } }),
    }),
    env,
    { sendMessage: send },
  );
  assert.equal(sent[1].text, sent[0].text);
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
  assert.match(sent[2].text, /Уведомления выключены/);
});
