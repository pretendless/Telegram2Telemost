import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  abandonReplyOk,
  afterNewpack,
  draftNeedsAbandon,
  dirsForRun,
  extractPackUrl,
  finalizeDecision,
  afterImageAttempts,
  IMAGE_ATTEMPTS,
  imageReply,
  resumeFromChat,
  scrollPageScript,
  settledImageReply,
  leaveUnpublishedDraft,
  mustOpenNewPack,
  packDialogOpen,
  resetForNewPack,
  wantsPicture,
} from "./telemost_upload.mjs";

const partial = {
  status: "stopped",
  uploaded: 14,
  created: true,
  nextImage: 14,
  pendingFile: "015.png",
  botReply: "Отправьте эмодзи для стикера.",
  packUrl: null,
};

test("a pack waiting on the emoji for 015 is abandoned, not resumed", () => {
  assert.equal(draftNeedsAbandon(partial), true);
  const next = resetForNewPack(partial);
  assert.equal(next.created, false);
  assert.equal(next.uploaded, 0);
  assert.equal(next.nextImage, 0);
  assert.equal(next.pendingFile, null);
  assert.equal(next.status, "pending");
});

test("a published pack is not abandoned and not started again", () => {
  assert.equal(draftNeedsAbandon({
    status: "done",
    uploaded: 147,
    packUrl: "https://messenger.360.yandex.ru/#/stickers/8387",
  }), false);
  assert.equal(draftNeedsAbandon({ status: "pending", uploaded: 0 }), false);
});

test("leaving the draft sends /start only, never an emoji or /done", async () => {
  const sent = [];
  const menu = "Команды\n/newpack — создать набор\n/done — завершить действие";
  const reply = await leaveUnpublishedDraft(async (text) => {
    sent.push(text);
    return { text: menu };
  });
  assert.deepEqual(sent, ["/start"]);
  assert.equal(reply.text, menu);
  assert.equal(abandonReplyOk(menu), true);
});

test("a stopped draft is opened with /newpack, not resumed and not /start", () => {
  assert.equal(mustOpenNewPack(partial), true);
  assert.equal(mustOpenNewPack({ status: "done", created: true }), false);
  assert.equal(afterNewpack("Напишите название набора"), "title");
  assert.equal(afterNewpack("Создан набор. Отправьте картинку стикера."), "picture");
  assert.equal(wantsPicture("Отправьте картинку для стикера."), true);
  assert.equal(wantsPicture("Отправьте эмодзи для стикера."), false);
  assert.equal(packDialogOpen("Это не эмодзи :)"), true);
  assert.equal(afterNewpack("Это не эмодзи :)"), "open");
});

test("pack 08 is the only pack closed after upload", () => {
  const dirs = ["07-set-redzh-i-letti", "08-maf-izis-i-agnes", "09-later"];
  assert.deepEqual(dirsForRun(dirs, { close: true }), ["08-maf-izis-i-agnes"]);
  assert.deepEqual(dirsForRun(dirs, { finalize: true }), ["07-set-redzh-i-letti"]);
});

test("the chat scroll script defines direction inside the page", () => {
  const up = scrollPageScript(-1);
  const down = scrollPageScript(1);
  assert.match(up, /const direction = -1;/);
  assert.match(down, /const direction = 1;/);
  assert.doesNotMatch(up, /\$\{/);
  new Function(up);
  new Function(down);
});

test("resume does not resend stickers the bot already accepted", () => {
  const title = "Маф, Изис и Агнес";
  const older = [
    { own: false, text: "Создан набор стикеров «Сэт, Рэдж и Летти».", links: [] },
    { own: false, text: "Стикер готов.", links: [] },
    { own: false, text: "Набор «Сэт, Рэдж и Летти» сохранён.", links: ["https://messenger.360.yandex.ru/#/stickers/8393"] },
  ];
  const ready = { own: false, text: "Стикер готов. Отправьте картинку для следующего стикера.", links: [] };
  const open = resumeFromChat(older.concat([
    { own: false, text: "Создан набор стикеров «Маф, Изис и Агнес». Отправьте картинку.", links: [] },
    ready,
    ready,
  ]), title, 144);
  assert.equal(open.action, "continue");
  assert.equal(open.uploaded, 2);
  const asking = resumeFromChat(older.concat([
    { own: false, text: "Создан набор стикеров «Маф, Изис и Агнес».", links: [] },
    ready,
    { own: false, text: "Отправьте эмодзи для стикера.", links: [] },
  ]), title, 144);
  assert.equal(asking.action, "emoji");
  assert.equal(asking.uploaded, 1);
  const saved = resumeFromChat(older.concat([
    { own: false, text: "Создан набор стикеров «Маф, Изис и Агнес».", links: [] },
    ready,
    { own: false, text: "Набор «Маф, Изис и Агнес» сохранён и доступен по ссылке.", links: ["https://messenger.360.yandex.ru/#/stickers/8400"] },
  ]), title, 144);
  assert.equal(saved.action, "saved");
  assert.equal(saved.url, "https://messenger.360.yandex.ru/#/stickers/8400");
});

test("five failures skip that image and the pack continues", () => {
  assert.equal(IMAGE_ATTEMPTS, 5);
  assert.equal(afterImageAttempts(0, false), "retry");
  assert.equal(afterImageAttempts(4, false), "retry");
  assert.equal(afterImageAttempts(5, false), "skip");
  assert.equal(afterImageAttempts(3, true), "next");
});

test("eighteen accepted stickers continue at 019", () => {
  const title = "Маф, Изис и Агнес";
  const ready = { own: false, text: "Стикер готов. Отправьте картинку для следующего стикера.", links: [] };
  const plan = resumeFromChat([
    { own: false, text: "Создан набор стикеров «Маф, Изис и Агнес». Отправьте картинку.", links: [] },
    ...Array.from({ length: 18 }, () => ready),
  ], title, 144);
  const pack = JSON.parse(readFileSync(new URL("../packs/08-maf-izis-i-agnes/pack.json", import.meta.url), "utf8"));
  assert.equal(plan.action, "continue");
  assert.equal(plan.uploaded, 18);
  assert.equal(pack.images[plan.uploaded].file, "019.png");
  assert.equal(pack.images[17].file, "018.png");
});

test("a ready sticker does not wait for an emoji", () => {
  assert.equal(imageReply("Стикер готов. Отправьте картинку для следующего стикера или сохраните набор: /done"), "ready");
  assert.equal(imageReply("Отправьте эмодзи для стикера."), "emoji");
  assert.equal(imageReply("Стикеры"), "pending");
  assert.equal(settledImageReply("Стикеры", 0), "pending");
  assert.equal(settledImageReply("Стикеры", 400), "reject");
  assert.equal(imageReply("Не удалось обработать картинку."), "reject");
});

test("finalize sends /done only after a sticker is ready and the pack is still open", () => {
  assert.equal(finalizeDecision("Стикер готов. Отправьте следующую картинку.").action, "done");
  assert.equal(finalizeDecision("/start — показать команды\n/newpack — создать набор\n/done — завершить действие").action, "stop");
  assert.equal(finalizeDecision("Отправьте картинку для стикера.\n/done — завершить действие").action, "stop");
  assert.equal(finalizeDecision("Набор «Сэт, Рэдж и Летти» сохранён и доступен по ссылке.\n/done — завершить действие").reason, "draft-gone");
  assert.equal(finalizeDecision("Отправьте эмодзи для стикера.\n/done — завершить действие").reason, "waiting-emoji");
  assert.equal(
    extractPackUrl("Набор «Сэт» сохранён", ["https://t.me/addstickers/x", "https://messenger.360.yandex.ru/#/stickers/9999"]),
    "https://messenger.360.yandex.ru/#/stickers/9999",
  );
});

test("a reply that is still asking for an emoji does not continue", async () => {
  const sent = [];
  await assert.rejects(
    () => leaveUnpublishedDraft(async (text) => {
      sent.push(text);
      return { text: "Отправьте эмодзи для стикера." };
    }),
    /not sending an emoji and not sending \/done/,
  );
  assert.deepEqual(sent, ["/start"]);
  assert.equal(abandonReplyOk("Отправьте эмодзи для стикера."), false);
  assert.equal(abandonReplyOk("Стикер готов"), false);
  assert.equal(abandonReplyOk("Набор сохранён https://messenger.360.yandex.ru/#/stickers/8387"), false);
});
