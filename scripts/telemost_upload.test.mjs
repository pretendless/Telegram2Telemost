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
  packSavedReply,
  savedReplyText,
  changedBotLinks,
  savedPackLinks,
  afterImageAttempts,
  afterSendReply,
  changedBotText,
  emojiAnswer,
  lastBotLine,
  planUpload,
  stickerReplyText,
  waitLastLine,
  IMAGE_ATTEMPTS,
  imageReply,
  isEmojiRequest,
  resumeFromChat,
  waitStatusDue,
  scrollPageScript,
  settledImageReply,
  unfinishedPack,
  leaveUnpublishedDraft,
  mustOpenNewPack,
  packDialogOpen,
  resetForNewPack,
  wantsPicture,
  openPackTitle,
  packTitleKey,
  restartTarget,
  restartAfterClose,
  isClockLine,
  savedPackTitle,
  screenLine,
  statusPackName,
  stickerSetName,
  typedPackTitle,
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
  assert.equal(wantsPicture("Это не картинка :)"), false);
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

test("a wait after send is not a failed attempt", () => {
  assert.equal(afterSendReply("pending"), "wait");
  assert.equal(afterSendReply("emoji"), "emoji");
  assert.equal(afterSendReply("ready"), "next");
  assert.equal(afterSendReply("reject"), "retry");
  assert.equal(afterImageAttempts(4, false), "retry");
  assert.equal(IMAGE_ATTEMPTS, 5);
  assert.equal(waitStatusDue(20000, 0, 0), true);
  assert.equal(waitStatusDue(19999, 0, 0), false);
  assert.equal(waitStatusDue(30000, 0, 20000), false);
  assert.equal(waitStatusDue(40000, 0, 20000), true);
});

test("an edited bubble after send is the emoji request, then the sticker is ready", () => {
  const baseline = [{ id: "7", text: "Отправьте картинку для следующего стикера." }];
  const asked = [{ id: "7", text: "Отправьте эмодзи для стикера." }];
  const peeked = [{ id: "8", text: "🫣" }];
  const ready = [{ id: "7", text: "Стикер готов. Отправьте картинку для следующего стикера или сохраните набор: /done" }];
  assert.equal(changedBotText(baseline, asked), "Отправьте эмодзи для стикера.");
  assert.equal(imageReply(changedBotText(baseline, asked)), "emoji");
  assert.equal(isEmojiRequest("🫣"), true);
  assert.equal(imageReply(changedBotText(baseline, peeked)), "emoji");
  assert.equal(emojiAnswer("Отправьте эмодзи для стикера.", "🫣"), "🫣");
  assert.equal(emojiAnswer("🫣", "😉"), "🫣");
  assert.equal(imageReply(changedBotText(asked, ready)), "ready");
  assert.equal(afterSendReply("ready"), "next");
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
  const accepted = resumeFromChat([
    { own: false, text: "Создан набор стикеров «Маф, Изис и Агнес». Отправьте картинку.", links: [] },
    ...Array.from({ length: 19 }, () => ready),
  ], title, 144);
  assert.equal(accepted.action, "continue");
  assert.equal(accepted.uploaded, 19);
  assert.equal(pack.images[accepted.uploaded].file, "020.png");
});

test("an open pack is continued, not restarted with /newpack", () => {
  const title = "Маф, Изис и Агнес";
  const readyLine = { own: false, text: "Стикер готов. Отправьте картинку для следующего стикера.", links: [] };
  const saved = { own: false, text: "Набор «Сэт, Рэдж и Летти» сохранён", links: [] };
  const sent = [saved, ...Array.from({ length: 71 }, () => readyLine)];
  const pack = JSON.parse(readFileSync(new URL("../packs/08-maf-izis-i-agnes/pack.json", import.meta.url), "utf8"));
  const missed = { action: "newpack", uploaded: 0, lastText: "" };
  const emoji = planUpload(missed, sent, "Стикеры Отправьте эмодзи для стикера. 11:17", 144);
  assert.equal(emoji.action, "emoji");
  assert.equal(emoji.uploaded, 71);
  assert.equal(pack.images[emoji.uploaded].file, "072.png");
  const ready = planUpload(missed, [...sent, readyLine], "Стикеры Стикер готов. Отправьте картинку. 11:18", 144);
  assert.equal(ready.action, "continue");
  assert.equal(ready.uploaded, 72);
  assert.equal(pack.images[ready.uploaded].file, "073.png");
  const quiet = planUpload(missed, sent, "Стикеры Отправьте картинку для следующего стикера. 11:19", 144);
  assert.equal(quiet.action, "continue");
  assert.equal(quiet.uploaded, 71);
  assert.equal(pack.images[quiet.uploaded].file, "072.png");
  const menu = "Команды\n/newpack — создать набор\n/done — завершить действие";
  assert.equal(planUpload(missed, sent, menu, 144).action, "newpack");
  assert.equal(unfinishedPack(menu), false);
  assert.equal(title.length > 0, true);
});

test("an existing «Стикер готов» line sends the next image", () => {
  const line = "Стикеры Стикер готов. Отправьте картинку для следующего стикера или сохраните набор: /done";
  const baseline = [{ id: "9", text: `${line} 11:48` }];
  const same = [{ id: "9", text: `${line} 11:48` }];
  const ticked = [{ id: "9", text: `${line} 11:49` }];
  assert.equal(stickerReplyText(baseline, same).kind, "ready");
  assert.equal(stickerReplyText(baseline, ticked).kind, "ready");
  assert.equal(stickerReplyText(baseline, ticked).text, ticked[0].text);
  assert.equal(afterSendReply(stickerReplyText(baseline, ticked).kind), "next");
  const asked = [{ id: "9", text: "Стикеры Отправьте эмодзи для стикера. 11:49" }];
  assert.equal(stickerReplyText(baseline, asked).kind, "emoji");
  const rejected = [{ id: "9", text: "Стикеры Не удалось обработать картинку. 11:49" }];
  assert.equal(stickerReplyText(baseline, rejected).kind, "reject");
});

test("a clock tick is not a reply, and the last new line is", () => {
  const baseline = [{ id: "7", text: "Стикеры Отправьте картинку для следующего стикера. 11:00" }];
  const ticked = [{ id: "7", text: "Стикеры Отправьте картинку для следующего стикера. 11:10" }];
  assert.equal(changedBotText(baseline, ticked), "");
  assert.equal(stickerReplyText(baseline, ticked).kind, "pending");
  const asked = [
    { id: "7", text: "Стикеры Отправьте картинку для следующего стикера. 11:10" },
    { id: "8", text: "Стикеры Отправьте эмодзи для стикера. 11:17" },
  ];
  assert.equal(stickerReplyText(baseline, asked).kind, "emoji");
  const ready = [{ id: "8", text: "Стикеры Стикер готов. Отправьте картинку для следующего стикера. 11:18" }];
  assert.equal(stickerReplyText(baseline, ready).kind, "ready");
  assert.equal(waitLastLine(20, lastBotLine(asked)), "");
  assert.match(waitLastLine(30, lastBotLine(asked)), /Отправьте эмодзи для стикера/);
  assert.match(waitLastLine(621, "Стикеры Отправьте эмодзи для стикера. 11:17"), /Отправьте эмодзи/);
});

test("a ready sticker does not wait for an emoji", () => {
  assert.equal(imageReply("Стикер готов. Отправьте картинку для следующего стикера или сохраните набор: /done"), "ready");
  assert.equal(imageReply("Отправьте эмодзи для стикера."), "emoji");
  const live = "Стикеры Отправьте эмодзи для стикера. 10:46";
  assert.equal(isEmojiRequest(live), true);
  assert.equal(imageReply(live), "emoji");
  assert.equal(emojiAnswer(live, "😉"), "😉");
  assert.equal(isEmojiRequest("Стикеры 🫣 10:46"), true);
  assert.equal(emojiAnswer("Стикеры 🫣 10:46", "😉"), "🫣");
  assert.equal(imageReply("Стикеры Это не картинка :) 10:33"), "pending");
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

test("done save needs сохранён plus the sticker href, not plain «по ссылке» wording", () => {
  const wording = "Стикеры Отправьте эмодзи для стикера. 15:30 Набор «Маф, Изис и Агнес» сохранён и доступен по ссылке. /start — показать команды /newpack — создать набор /done — завершить действие 15:30";
  assert.equal(packSavedReply(wording, []).ok, false);
  assert.equal(packSavedReply(wording, []).reason, "missing-url");
  assert.equal(
    packSavedReply(wording, ["https://messenger.360.yandex.ru/#/stickers/8401"]).url,
    "https://messenger.360.yandex.ru/#/stickers/8401",
  );
  const baseline = [{ id: "1", text: "Стикер готов. Отправьте картинку для следующего стикера или сохраните набор: /done 15:30" }];
  const rows = [
    { id: "1", text: "Стикер готов. Отправьте картинку для следующего стикера или сохраните набор: /done 15:30", links: [] },
    { id: "2", text: "Отправьте эмодзи для стикера. 15:30", links: [] },
    {
      id: "3",
      text: "Набор «Маф, Изис и Агнес» сохранён и доступен по ссылке. 15:30",
      links: ["https://messenger.360.yandex.ru/#/stickers/8401"],
    },
    { id: "4", text: "/start — показать команды\n/newpack — создать набор\n/done — завершить действие 15:30", links: [] },
  ];
  const seen = savedReplyText(baseline, rows);
  assert.equal(seen.kind, "saved");
  assert.match(seen.text, /сохранён/);
  assert.equal(extractPackUrl(seen.text, seen.links), "https://messenger.360.yandex.ru/#/stickers/8401");
  assert.deepEqual(savedPackLinks(rows), ["https://messenger.360.yandex.ru/#/stickers/8401"]);
  assert.ok(changedBotLinks(baseline, rows).includes("https://messenger.360.yandex.ru/#/stickers/8401"));
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

test("restart follows the open pack, or the next stored request", () => {
  const messages = [
    { own: false, text: "Создан набор стикеров «Север».", links: [] },
    { own: false, text: "Набор «Север» сохранён.", links: [] },
    { own: false, text: "Создан набор стикеров «Юг». Отправьте картинку.", links: [] },
    { own: false, text: "Отправьте эмодзи для стикера.", links: [] },
  ];
  assert.equal(openPackTitle(messages), "Юг");
  assert.equal(openPackTitle(messages.slice(0, 2)), "");
  const catalogs = [
    { title: "Север", dir: "01-sever" },
    { title: "Юг", dir: "02-yug" },
  ];
  const requests = [
    { id: "a", title: "Запад", status: "uploading", links: ["https://t.me/addstickers/zapad"], createdAt: "1", priority: false },
    { id: "b", title: "Восток", status: "queued", links: ["https://t.me/addstickers/vostok"], createdAt: "2", priority: true },
  ];
  const open = restartTarget({ unfinished: true, title: "Юг", catalogs, requests });
  assert.equal(open.action, "restart");
  assert.equal(open.dir, "02-yug");
  assert.equal(open.title, "Юг");
  const named = restartTarget({
    unfinished: true,
    title: "Запад",
    catalogs,
    requests,
  });
  assert.equal(named.requestId, "a");
  assert.deepEqual(named.links, ["https://t.me/addstickers/zapad"]);
  const idle = restartTarget({ unfinished: false, title: "", catalogs, requests });
  assert.equal(idle.action, "upload");
  assert.equal(idle.title, "Запад");
  const next = restartTarget({
    unfinished: false,
    title: "",
    catalogs,
    requests: requests.filter((item) => item.status === "queued"),
  });
  assert.equal(next.title, "Восток");
  assert.equal(restartTarget({ unfinished: false, title: "", catalogs, requests: [] }).action, "idle");
  const loose = restartTarget({ unfinished: true, title: "«юг» 🎉", catalogs, requests });
  assert.equal(loose.dir, "02-yug");
  assert.equal(packTitleKey("«Юг» 🎉"), "юг");
  const quoted = [
    { own: false, text: 'Создан набор стикеров "Юг". Отправьте картинку.', links: [] },
  ];
  assert.equal(openPackTitle(quoted), "Юг");
  assert.equal(screenLine("Стикеры\nОтправьте эмодзи для стикера."), "Отправьте эмодзи для стикера.");
  assert.equal(screenLine("Стикер готов. Отправьте картинку.\n\n11:57"), "Стикер готов. Отправьте картинку.");
  assert.equal(isClockLine("11:57"), true);
  assert.equal(isClockLine("Стикер готов"), false);
  assert.equal(statusPackName("11:57"), "");
  assert.equal(statusPackName("Маф, Изис и Агнес"), "Маф, Изис и Агнес");
  assert.equal(savedPackTitle("Набор «Маф, Изис и Агнес» сохранён и доступен по ссылке."), "Маф, Изис и Агнес");
  assert.equal(
    typedPackTitle([
      { own: true, text: "/newpack" },
      { own: false, text: "Напишите название набора" },
      { own: true, text: "Маф, Изис и Агнес" },
      { own: false, text: "Отправьте эмодзи для стикера." },
    ]),
    "Маф, Изис и Агнес",
  );
  const unmatched = restartTarget({
    unfinished: true,
    title: "Нет такого",
    liveText: "Отправьте эмодзи для стикера.",
    catalogs,
    requests,
  });
  assert.equal(unmatched.action, "seen");
  assert.equal(unmatched.title, "Нет такого");
  assert.deepEqual(unmatched.matches, []);
  const several = restartTarget({
    unfinished: true,
    title: "Юг",
    catalogs: [...catalogs, { title: "юг", dir: "03-yug-2" }],
    requests: [],
  });
  assert.equal(several.action, "seen");
  assert.deepEqual(several.matches, ["Юг", "юг"]);
  const clockOnly = restartTarget({
    unfinished: true,
    title: "11:57",
    liveText: "Стикер готов. Отправьте картинку для следующего стикера или сохраните набор: /done\n\n11:57",
    catalogs,
    requests: [],
  });
  assert.equal(clockOnly.action, "close");
  assert.equal(clockOnly.title, "");
  const emptyThenQueue = restartTarget({
    unfinished: true,
    title: "",
    liveText: "11:57",
    catalogs,
    requests: requests.filter((item) => item.status === "queued"),
  });
  assert.equal(emptyThenQueue.action, "upload");
  assert.equal(emptyThenQueue.title, "Восток");
  assert.equal(restartAfterClose("Отправьте эмодзи для стикера.").action, "stop");
  assert.equal(restartAfterClose("Набор «Юг» сохранён.").action, "newpack");
  assert.equal(restartAfterClose("Набор «Юг» сохранён.").uploaded, 0);
  assert.equal(stickerSetName("https://t.me/addstickers/vostok"), "vostok");
});
