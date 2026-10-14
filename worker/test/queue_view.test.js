import assert from "node:assert/strict";
import test from "node:test";
import { activeUploadJob, loadAdminQueueState } from "../src/queue_view.js";
import { queueItemSlug } from "../src/logic.js";

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
  };
}

test("activeUploadJob ignores orphan catalog pack progress", () => {
  const queue = {
    priority: [],
    items: [
      {
        id: "b",
        title: "Дьяволица",
        status: "queued",
        createdAt: "2",
        priority: false,
        chatId: "1",
        links: [],
        stickers: 10,
      },
    ],
  };
  const orphan = { title: "Сэт, Рэдж и Летти", status: "uploading", uploaded: 0, total: 144 };
  assert.equal(activeUploadJob(queue, orphan).running, false);
});

test("loadAdminQueueState reconciles terminal uploading before reporting", async () => {
  const kv = memoryKv();
  const item = {
    id: "req-done",
    chatId: "1",
    title: "ВолнаСветa",
    links: ["https://t.me/addstickers/w"],
    priority: false,
    createdAt: "2026-10-13T12:00:00.000Z",
    status: "uploading",
    stickers: 5,
  };
  const slug = queueItemSlug(item);
  kv.store.set(
    "queue",
    JSON.stringify({
      priority: [],
      items: [
        item,
        {
          id: "req-next",
          chatId: "2",
          title: "Дьяволица",
          links: ["https://t.me/addstickers/d"],
          priority: false,
          createdAt: "2026-10-13T12:01:00.000Z",
          status: "queued",
          stickers: 8,
        },
      ],
    }),
  );
  kv.store.set(
    `pack:${slug}`,
    JSON.stringify({
      slug,
      title: item.title,
      status: "done",
      uploaded: 5,
      total: 5,
      url: "https://messenger.360.yandex.ru/#/stickers/1",
    }),
  );
  const view = await loadAdminQueueState(kv);
  assert.equal(view.job.running, false);
  const stored = JSON.parse(kv.store.get("queue"));
  assert.equal(stored.items.find((row) => row.id === "req-done").status, "done");
});
