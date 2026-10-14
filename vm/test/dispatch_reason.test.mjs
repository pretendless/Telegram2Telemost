import assert from "node:assert/strict";
import test from "node:test";
import {
  adminRestartReason,
  enrichDispatchReason,
  nextAutostartPackTitle,
  nextQueuePackTitle,
  queuePipelineReason,
  QUEUE_REASON,
  withPackTitle,
} from "../dispatch_reason.js";
import { titlesForPackNumbers } from "../pack_titles.js";
import { join } from "node:path";

const queue = {
  priority: [],
  items: [
    { id: "a", status: "uploading", title: "Запад", createdAt: "2026-01-01T00:00:00.000Z", priority: false },
    { id: "b", status: "queued", title: "Восток", createdAt: "2026-01-02T00:00:00.000Z", priority: false },
  ],
};

test("nextQueuePackTitle prefers uploading row", () => {
  assert.equal(nextQueuePackTitle(queue), "Запад");
});

test("nextAutostartPackTitle ignores uploading and picks priority queued", () => {
  assert.equal(nextAutostartPackTitle(queue), "Восток");
  const mixed = {
    priority: [],
    items: [
      { id: "a", status: "uploading", title: "Снупи", createdAt: "2026-01-01T00:00:00.000Z", priority: false },
      { id: "b", status: "queued", title: "ВолнаСветa", createdAt: "2026-01-02T00:00:00.000Z", priority: true },
      { id: "c", status: "queued", title: "Дьяволица", createdAt: "2026-01-03T00:00:00.000Z", priority: false },
    ],
  };
  assert.equal(nextAutostartPackTitle(mixed), "ВолнаСветa");
});

test("queuePipelineReason for autostart names next queued pack, not stale uploading", () => {
  const stuck = {
    priority: [],
    items: [
      { id: "a", status: "uploading", title: "Снупи", createdAt: "2026-01-01T00:00:00.000Z", priority: false },
      { id: "b", status: "queued", title: "ВолнаСветa", createdAt: "2026-01-02T00:00:00.000Z", priority: true },
    ],
  };
  assert.equal(
    queuePipelineReason(QUEUE_REASON.afterUnstick, stuck, { preferQueued: true }),
    "очередь: автозапуск после /unstick — «ВолнаСветa»",
  );
});

test("adminRestartReason prefers next queued over stale uploading", () => {
  assert.equal(adminRestartReason(queue), "админ: /restart — «Восток»");
});

test("nextQueuePackTitle picks priority queued item", () => {
  const mixed = {
    priority: [],
    items: [
      { id: "a", status: "queued", title: "Обычный", createdAt: "2026-01-01T00:00:00.000Z", priority: false },
      { id: "b", status: "queued", title: "Срочный", createdAt: "2026-01-02T00:00:00.000Z", priority: true },
    ],
  };
  assert.equal(nextQueuePackTitle(mixed), "Срочный");
});

test("withPackTitle appends title once", () => {
  assert.equal(withPackTitle("админ: /restart", "Запад"), "админ: /restart — «Запад»");
  assert.equal(withPackTitle("админ: /restart — «Запад»", "Запад"), "админ: /restart — «Запад»");
});

test("queue pipeline reason includes pack from queue", () => {
  assert.equal(
    queuePipelineReason(QUEUE_REASON.newRequest, queue),
    "очередь: новый запрос принят — «Запад»",
  );
});

test("admin restart without queue keeps short reason", () => {
  assert.equal(adminRestartReason({ items: [] }), "админ: /restart");
});

test("enrichDispatchReason adds repo pack titles for upload", () => {
  const root = join(new URL("../..", import.meta.url).pathname, "packs");
  const resolveTitles = (nums) => titlesForPackNumbers(nums, root);
  const reason = enrichDispatchReason({
    dispatchReason: "админ: /upload 07 08",
    mode: "upload",
    packs: "07 08",
    resolveTitles,
  });
  assert.match(reason, /07 08/);
  assert.match(reason, /Сэт, Рэдж и Летти/);
  assert.match(reason, /Маф, Изис и Агнес/);
});
