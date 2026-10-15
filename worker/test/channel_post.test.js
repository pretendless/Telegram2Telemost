import assert from "node:assert/strict";
import test from "node:test";
import { handle } from "../src/index.js";
import {
  QUEUE_KEY,
  channelPack,
  channelPost,
  planNotifications,
  queueItemSlug,
  stickerCountLabel,
  telegramParseMode,
} from "../src/logic.js";

const PACK_URL = "https://messenger.360.yandex.ru/#/stickers/8506";

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
    async list() {
      return { keys: [], list_complete: true };
    },
  };
}

test("sticker counts use Russian plural forms", () => {
  assert.equal(stickerCountLabel(1), "1 стикер");
  assert.equal(stickerCountLabel(2), "2 стикера");
  assert.equal(stickerCountLabel(5), "5 стикеров");
  assert.equal(stickerCountLabel(11), "11 стикеров");
  assert.equal(stickerCountLabel(21), "21 стикер");
  assert.equal(stickerCountLabel(109), "109 стикеров");
  assert.equal(stickerCountLabel(144), "144 стикера");
  assert.equal(stickerCountLabel(0), "");
});

test("one source is a single hash after the phone and the title", () => {
  const text = channelPost({
    title: "Шерсть Ебаная",
    url: PACK_URL,
    total: 109,
    links: ["https://t.me/addstickers/piidarasy"],
  });
  assert.equal(
    text,
    "📞 <b>Шерсть Ебаная</b> · 109 стикеров\n" +
      `<a href="${PACK_URL}">Открыть в Телемосте</a> · из тг ` +
      '<a href="https://t.me/addstickers/piidarasy">#</a>',
  );
  assert.equal(telegramParseMode(text), "HTML");
});

test("several sources keep first-seen order", () => {
  const text = channelPost({
    title: "Два",
    url: PACK_URL,
    total: 40,
    links: ["https://t.me/addstickers/one_set", "t.me/addstickers/two_set"],
  });
  const first = text.indexOf("addstickers/one_set");
  const second = text.indexOf("addstickers/two_set");
  assert.ok(first > 0 && second > first);
  assert.equal(text.match(/<a href="https:\/\/t\.me\/addstickers\//g).length, 2);
  assert.match(text, /^📞 <b>Два<\/b> · 40 стикеров\n/);
});

test("the title is escaped and a pack without sources omits that clause", () => {
  const text = channelPost({
    title: 'Tom & <Jerry> "x"',
    url: PACK_URL,
    total: 3,
    links: ["not-a-url", ""],
    source: "https://github.com/pretendless/tg2tm/actions/runs/1",
    requesterChatId: "8502935020",
  });
  assert.equal(
    text,
    "📞 <b>Tom &amp; &lt;Jerry&gt; &quot;x&quot;</b> · 3 стикера\n" +
      `<a href="${PACK_URL}">Открыть в Телемосте</a>`,
  );
  assert.doesNotMatch(text, /из тг/);
  assert.doesNotMatch(text, /github\.com/);
  assert.doesNotMatch(text, /8502935020/);
  assert.doesNotMatch(text, /actions\/runs/);
  assert.equal(telegramParseMode(text), "HTML");
  assert.equal(telegramParseMode("просто текст"), undefined);
});

test("the queue title wins over a progress slug, in source order", () => {
  const item = {
    id: "req-wool",
    chatId: "777001",
    title: "Шерсть Ебаная",
    links: ["https://t.me/addstickers/first", "https://t.me/addstickers/second"],
    status: "uploading",
    stickers: 109,
  };
  const pack = channelPack(
    {
      slug: queueItemSlug(item),
      title: "first",
      status: "done",
      uploaded: 109,
      total: 109,
      url: PACK_URL,
      requesterChatId: "777001",
      queueRequestId: item.id,
      runUrl: "https://github.com/pretendless/tg2tm/actions/runs/9",
    },
    { items: [item] },
  );
  const text = channelPost(pack);
  assert.match(text, /^📞 <b>Шерсть Ебаная<\/b> · 109 стикеров\n/);
  assert.ok(text.indexOf("addstickers/first") < text.indexOf("addstickers/second"));
  assert.doesNotMatch(text, /<b>first<\/b>/);
  assert.doesNotMatch(text, /777001/);
  assert.doesNotMatch(text, /github\.com/);
});

test("a finished pack posts the compact channel message from the queue row", async () => {
  const kv = memoryKv();
  const item = {
    id: "req-wool",
    chatId: "777001",
    title: "Шерсть & Ебаная",
    links: ["https://t.me/addstickers/piidarasy"],
    priority: false,
    createdAt: "2026-10-15T00:00:00.000Z",
    status: "uploading",
    stickers: 109,
  };
  kv.store.set(QUEUE_KEY, JSON.stringify({ priority: [], items: [item] }));
  const sent = [];
  const env = {
    BOT_KV: kv,
    UPLOADER_SECRET: "uploader-secret",
    TG2TMBOT_TOKEN: "bot-token",
  };
  const res = await handle(
    new Request("https://tg2tmbot.example/progress", {
      method: "POST",
      headers: { authorization: "Bearer uploader-secret", "content-type": "application/json" },
      body: JSON.stringify({
        slug: queueItemSlug(item),
        title: "piidarasy",
        status: "done",
        uploaded: 109,
        total: 109,
        packUrl: PACK_URL,
        queueRequestId: item.id,
        requesterChatId: "777001",
        runUrl: "https://github.com/pretendless/tg2tm/actions/runs/9",
        adminDelivered: true,
      }),
    }),
    env,
    {
      sendMessage: async (_env, chatId, text) => {
        sent.push({ chatId, text });
        return { message_id: 1 };
      },
    },
  );
  assert.equal(res.status, 200);
  const channel = sent.find((row) => row.chatId === "@tg2tm");
  assert.ok(channel);
  assert.equal(
    channel.text,
    "📞 <b>Шерсть &amp; Ебаная</b> · 109 стикеров\n" +
      `<a href="${PACK_URL}">Открыть в Телемосте</a> · из тг ` +
      '<a href="https://t.me/addstickers/piidarasy">#</a>',
  );
  assert.equal(sent.filter((row) => row.chatId === "@tg2tm").length, 1);
  const user = sent.find((row) => String(row.chatId) === "777001");
  assert.ok(user);
  assert.doesNotMatch(user.text, /📞/);
});

test("planNotifications still posts once when the pack has no source links", () => {
  const plan = planNotifications(null, {
    slug: "02-old",
    title: "Старый",
    source: "https://t.me/tg2tm/4",
    status: "done",
    uploaded: 12,
    total: 12,
    url: PACK_URL,
    error: null,
  });
  assert.equal(
    plan.channel,
    `📞 <b>Старый</b> · 12 стикеров\n<a href="${PACK_URL}">Открыть в Телемосте</a>`,
  );
  assert.doesNotMatch(plan.channel, /t\.me\/tg2tm\/4/);
  const again = planNotifications(plan.state, {
    slug: "02-old",
    title: "Старый",
    status: "done",
    uploaded: 12,
    total: 12,
    url: PACK_URL,
  });
  assert.equal(again.channel, null);
});
