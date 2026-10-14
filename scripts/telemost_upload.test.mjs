import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  abandonReplyOk,
  afterNewpack,
  afterAddsticker,
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
  newOwnId,
  ownIds,
  stagingOwnIdAfterSend,
  stagingNewRows,
  stagingImageRows,
  stagingBufferRows,
  stagingForwardBuffer,
  stagingImageOnlyRow,
  stagingForwardMessageId,
  stagingForwardMessageIdFromBatch,
  resolveStagingForwardId,
  stagingRowsForForward,
  STAGING_FORWARD_POLL_MS,
  STAGING_FORWARD_MENU_LABELS,
  STAGING_MESSAGE_ACTIONS_SELECTOR,
  stagingForwardMenuBlocked,
  menuLabelMatches,
  botRepliesAfterOwn,
  loadTelemostUrls,
  githubActionsChatUrlError,
  telemostUrlMatches,
  telemostUrlToken,
  devtoolsNewTabRequests,
  bufferImageCount,
  bufferCountGrew,
  bufferImagesGrown,
  bufferBatchBubble,
  bufferUploadLogLine,
  bufferPostCount,
  bufferClearStartLine,
  bufferClearDeletedLine,
  bufferClearDoneLine,
  bufferClearAllowed,
  bufferClearFailed,
  newImageDidNotAppear,
  menuIsDeleteConfirm,
  BUFFER_DELETE_ATTEMPTS,
  bufferDeleteReduced,
  messageMenuHasDelete,
  isDeleteMessageOk,
  dialogAsksDeleteMessage,
  botClearStartLine,
  botClearConfirmedLine,
  botClearSkippedLine,
  botReopenLine,
  botClearFailed,
  isClearHistoryMenu,
  isClearHistoryConfirmButton,
  dialogWarnsClearHistory,
  sidebarTitleIsChat,
  forwardSubmenuLogLine,
  botReplyLogLine,
  forwardTargetFromTitle,
  isForwardSubmenuLabel,
  submenuChatMatches,
  forwardSubmenuOpensRight,
  contextMenuLooksOpen,
  flyoutAnchoredBeside,
  flyoutLabelsHaveTarget,
  forwardFlyoutFailure,
  adminPhaseForStagingStep,
  stagingOperationTarget,
  stagingForwardExpectsRows,
  STAGING_CHAT_WARM_ITERATIONS,
  stagingFillTo,
  waitLastLine,
  IMAGE_ATTEMPTS,
  STALL_MS,
  stallDue,
  needsAddSticker,
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
  shouldAbandonOpenPack,
  closeOpenPackPlan,
  acceptedInOpenPack,
  latestIncomingText,
  incomingTailText,
  unfinishedPackTail,
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

test("close and finalize keep every requested pack folder", () => {
  const dirs = ["07-set-redzh-i-letti", "08-maf-izis-i-agnes", "09-later"];
  assert.deepEqual(dirsForRun(dirs, { close: true }), dirs);
  assert.deepEqual(dirsForRun(dirs, { finalize: true }), dirs);
  assert.deepEqual(dirsForRun(dirs, {}), dirs);
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
  assert.equal(afterSendReply("stall"), "recover");
  assert.equal(afterImageAttempts(4, false), "retry");
  assert.equal(IMAGE_ATTEMPTS, 5);
  assert.equal(STALL_MS, 120000);
  assert.equal(stallDue(120000, 0, 120000), true);
  assert.equal(stallDue(119999, 0, 120000), false);
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

test("an existing «Стикер готов» line does not advance until a new bot reply", () => {
  const line = "Стикеры Стикер готов. Отправьте картинку для следующего стикера или сохраните набор: /done";
  const baseline = [{ id: "9", text: `${line} 11:48` }];
  const same = [{ id: "9", text: `${line} 11:48` }];
  const ticked = [{ id: "9", text: `${line} 11:49` }];
  // Run 38421357861 raced here: same ready line → next image in ~300ms.
  assert.equal(stickerReplyText(baseline, same).kind, "pending");
  assert.equal(stickerReplyText(baseline, ticked).kind, "pending");
  assert.equal(afterSendReply(stickerReplyText(baseline, ticked).kind), "wait");
  const asked = [{ id: "9", text: "Стикеры Отправьте эмодзи для стикера. 11:49" }];
  assert.equal(stickerReplyText(baseline, asked).kind, "emoji");
  assert.equal(afterSendReply("emoji"), "emoji");
  const rejected = [{ id: "9", text: "Стикеры Не удалось обработать картинку. 11:49" }];
  assert.equal(stickerReplyText(baseline, rejected).kind, "reject");
  const freshReady = [{ id: "10", text: `${line} 11:50` }];
  assert.equal(stickerReplyText(baseline, freshReady).kind, "ready");
  assert.equal(afterSendReply("ready"), "next");
  const rewritten = [{ id: "9", text: `${line} 11:50` }];
  // Same id with only a clock change stays pending; a real rewrite to ready
  // after an emoji ask is changed text and advances.
  assert.equal(stickerReplyText(asked, rewritten).kind, "ready");
});

test("changed bot text above our image does not count as ready", () => {
  const line = "Стикеры Стикер готов. Отправьте картинку для следующего стикера или сохраните набор: /done";
  const baseline = [{ id: "9", text: `${line} 23:10` }];
  const thread = [
    { id: "9", own: false, text: `${line} 23:11` },
    { id: "12", own: true, text: "фото 23:11" },
  ];
  // Run 38421357861: changedBotText saw «Стикер готов» above the new image and sent N+2.
  assert.equal(
    stickerReplyText(baseline, thread.filter((r) => !r.own), { thread, afterOwnId: "12" }).kind,
    "pending",
  );
  assert.equal(stickerReplyText(baseline, thread.filter((r) => !r.own), { thread, afterOwnId: null }).kind, "pending");
});

test("must not treat sticker N+1 as ready before bot replies to sticker N", () => {
  const ready = "Стикеры Стикер готов. Отправьте картинку для следующего стикера или сохраните набор: /done";
  const baseline = [{ id: "9", text: `${ready} 23:11` }];
  const afterSend = [
    { id: "9", own: false, text: `${ready} 23:11` },
    { id: "10", own: true, text: "стикер-10 23:11" },
  ];
  assert.equal(
    stickerReplyText(baseline, afterSend.filter((r) => !r.own), { thread: afterSend, afterOwnId: "10" }).kind,
    "pending",
  );
  const replied = [
    ...afterSend,
    { id: "11", own: false, text: "Стикеры Отправьте эмодзи для стикера. 23:12" },
  ];
  assert.equal(
    stickerReplyText(baseline, replied.filter((r) => !r.own), { thread: replied, afterOwnId: "10" }).kind,
    "emoji",
  );
  const done = [
    { id: "9", own: false, text: `${ready} 23:11` },
    { id: "10", own: true, text: "стикер-10 23:11" },
    { id: "11", own: false, text: `${ready} 23:12` },
  ];
  assert.equal(
    stickerReplyText(baseline, done.filter((r) => !r.own), { thread: done, afterOwnId: "10" }).kind,
    "ready",
  );
  assert.equal(afterSendReply("ready"), "next");
  assert.equal(afterSendReply("pending"), "wait");
});

test("a ready after our outbound bubble advances; the old ready before it does not", () => {
  const line = "Стикеры Стикер готов. Отправьте картинку для следующего стикера или сохраните набор: /done";
  const baseline = [{ id: "9", text: `${line} 20:08` }];
  const ownBefore = ["1"];
  const waiting = [
    { id: "9", own: false, text: `${line} 20:08` },
    { id: "12", own: true, text: "фото 20:08" },
  ];
  assert.equal(newOwnId(ownBefore, waiting), "12");
  assert.equal(botRepliesAfterOwn(waiting, "12").length, 0);
  // Hang case: previous ready still last bot line, our image is on screen, no new bot bubble yet.
  assert.equal(
    stickerReplyText(baseline, waiting.filter((r) => !r.own), { thread: waiting, afterOwnId: "12" }).kind,
    "pending",
  );
  const accepted = [
    { id: "9", own: false, text: `${line} 20:08` },
    { id: "12", own: true, text: "фото 20:08" },
    { id: "13", own: false, text: `${line} 20:09` },
  ];
  assert.equal(
    stickerReplyText(baseline, accepted.filter((r) => !r.own), { thread: accepted, afterOwnId: "12" }).kind,
    "ready",
  );
  const askedAfter = [
    { id: "9", own: false, text: `${line} 20:08` },
    { id: "12", own: true, text: "фото 20:08" },
    { id: "13", own: false, text: "Стикеры Отправьте эмодзи для стикера. 20:09" },
  ];
  assert.equal(
    stickerReplyText(baseline, askedAfter.filter((r) => !r.own), { thread: askedAfter, afterOwnId: "12" }).kind,
    "emoji",
  );
  const rejectedAfter = [
    { id: "9", own: false, text: `${line} 20:08` },
    { id: "12", own: true, text: "фото 20:08" },
    { id: "13", own: false, text: "Стикеры Не удалось обработать картинку. 20:09" },
  ];
  assert.equal(
    stickerReplyText(baseline, rejectedAfter.filter((r) => !r.own), { thread: rejectedAfter, afterOwnId: "12" }).kind,
    "reject",
  );
  // Clock tick on the old ready while our send is visible must not race.
  const tickedOld = [
    { id: "9", own: false, text: `${line} 20:16` },
    { id: "12", own: true, text: "фото 20:08" },
  ];
  assert.equal(
    stickerReplyText(baseline, tickedOld.filter((r) => !r.own), { thread: tickedOld, afterOwnId: "12" }).kind,
    "pending",
  );
  assert.deepEqual(ownIds(waiting), ["12"]);
});

test("stall timer ignores busy flicker in the progress key", () => {
  assert.equal(stallDue(1000, 0, STALL_MS), false);
  assert.equal(stallDue(STALL_MS, 0, STALL_MS), true);
  assert.equal(stallDue(STALL_MS + 1, 1, STALL_MS), true);
});

test("staging forward resolves by image index after navigation reassigns ids", () => {
  const beforeNav = [
    { id: "1", own: true, hasImage: true, text: "leftover" },
    { id: "2", own: true, hasImage: true, text: "001" },
    { id: "3", own: true, hasImage: true, text: "002" },
  ];
  assert.equal(stagingForwardMessageId(beforeNav, 0, 1), "2");
  assert.equal(stagingForwardMessageId(beforeNav, 1, 1), "3");
  // openChat resets tg2tmId in the DOM; index into image rows is unchanged.
  const afterNav = [
    { id: "9", own: true, hasImage: true, text: "leftover" },
    { id: "10", own: true, hasImage: true, text: "001" },
    { id: "11", own: true, hasImage: true, text: "002" },
  ];
  assert.deepEqual(stagingImageRows(afterNav).map((r) => r.id), ["9", "10", "11"]);
  assert.equal(stagingForwardMessageId(afterNav, 0, 1), "10");
  assert.equal(stagingForwardMessageId(afterNav, 1, 1), "11");
  assert.equal(stagingForwardMessageId(afterNav, 2, 1), null);
});

test("resolveStagingForwardId reads fresh ids from bot.chatRows", async () => {
  const rows = [
    { id: "20", own: true, hasImage: true },
    { id: "21", own: true, hasImage: true },
  ];
  const bot = {
    chatRows: async () => rows,
    scrollToBottom: async () => {},
  };
  assert.equal(await resolveStagingForwardId(bot, 1, 0), "21");
  rows[1].id = "99";
  assert.equal(await resolveStagingForwardId(bot, 1, 0), "99");
});

test("staging forward uses row index when join chat omits hasImage", () => {
  const baseRows = 2;
  const joinAfterUpload = [
    { id: "1", own: false, text: "system", hasImage: false },
    { id: "2", own: false, text: "hello", hasImage: false },
    { id: "3", own: false, text: "", hasImage: false },
    { id: "4", own: false, text: "", hasImage: false },
    { id: "5", own: false, text: "11:05", hasImage: false },
  ];
  assert.equal(stagingImageRows(joinAfterUpload).length, 0);
  assert.deepEqual(stagingBufferRows(joinAfterUpload).map((r) => r.id), ["3", "4", "5"]);
  assert.equal(stagingForwardMessageId(joinAfterUpload, 0, baseRows), "3");
  assert.equal(stagingForwardMessageId(joinAfterUpload, 1, baseRows), "4");
  assert.equal(stagingForwardMessageId(joinAfterUpload, 2, baseRows), "5");
  assert.equal(stagingForwardMessageId(joinAfterUpload, 0, baseRows, 0), "3");
  assert.equal(stagingImageOnlyRow({ text: "" }), true);
  assert.equal(stagingImageOnlyRow({ text: "11:05" }), true);
  assert.equal(stagingImageOnlyRow({ text: "caption" }), false);
});

test("batch buffer index maps pack slot when join history is collapsed", () => {
  const buffer = [
    { id: "a", text: "", hasImage: false },
    { id: "b", text: "", hasImage: false },
    { id: "c", text: "", hasImage: false },
    { id: "d", text: "", hasImage: false },
    { id: "e", text: "", hasImage: false },
  ];
  assert.equal(stagingForwardMessageIdFromBatch(buffer, 0, 5, 0), "a");
  assert.equal(stagingForwardMessageIdFromBatch(buffer, 4, 5, 0), "e");
  assert.equal(stagingForwardMessageIdFromBatch(buffer, 2, 5, 0), "c");
  const collapsed = [{ id: "left", text: "old", hasImage: true }];
  assert.equal(stagingForwardMessageId(collapsed, 0, 1, 0, { stagingFilled: 5, uploaded: 0 }), null);
  const withLeftover = [{ id: "left", text: "old", hasImage: true }, ...buffer];
  assert.equal(stagingForwardMessageId(withLeftover, 0, 1, 0, { stagingFilled: 5, uploaded: 0 }), "a");
  assert.equal(
    stagingForwardMessageIdFromBatch(stagingForwardBuffer(withLeftover), 0, 5, 0),
    "a",
  );
  assert.equal(
    stagingForwardMessageIdFromBatch(buffer, 3, 7, 2),
    "b",
  );
});

test("resolveStagingForwardId uses surveyChat when chatRows sees too few rows", async () => {
  let surveyed = 0;
  const full = [
    { id: "1", own: false, text: "leftover", hasImage: true },
    { id: "2", own: false, text: "", hasImage: false },
    { id: "3", own: false, text: "", hasImage: false },
  ];
  const bot = {
    scrollToBottom: async () => {},
    chatRows: async () => full.slice(0, 1),
    surveyChat: async () => {
      surveyed += 1;
      return { messages: full.map(({ id, own, text }) => ({ id, own, text, links: [] })), reachedTop: true };
    },
  };
  assert.equal(
    await resolveStagingForwardId(bot, 0, 1, 0, { stagingFilled: 2, uploaded: 0 }),
    "2",
  );
  assert.ok(surveyed >= 1);
});

test("resolveStagingForwardId polls until staged rows appear", async () => {
  let calls = 0;
  const bot = {
    scrollToBottom: async () => {},
    chatRows: async () => {
      calls += 1;
      if (calls < 3) return [{ id: "1", own: false, text: "old", hasImage: false }];
      return [
        { id: "1", own: false, text: "old", hasImage: false },
        { id: "2", own: false, text: "", hasImage: false },
      ];
    },
  };
  assert.equal(await resolveStagingForwardId(bot, 0, 1), "2");
  assert.ok(calls >= 3);
  assert.ok(STAGING_FORWARD_POLL_MS >= 8000);
});

test("menuLabelMatches accepts RU and EN forward menu labels", () => {
  assert.equal(menuLabelMatches("Переслать", ""), true);
  assert.equal(menuLabelMatches("Переслать сообщение", ""), true);
  assert.equal(menuLabelMatches("", "Forward"), true);
  assert.equal(menuLabelMatches("Forward to…", "Forward"), true);
  assert.equal(menuLabelMatches("Удалить", ""), false);
  assert.deepEqual([...STAGING_FORWARD_MENU_LABELS], ["Переслать сообщение", "Переслать", "Forward"]);
});

test("stagingForwardMenuBlocked detects forward failures eligible for sendImage fallback", () => {
  assert.equal(stagingForwardMenuBlocked(new Error("staging forward: context menu did not open for 1")), true);
  assert.equal(stagingForwardMenuBlocked(new Error("staging forward: Переслать not found")), true);
  assert.equal(stagingForwardMenuBlocked(new Error("staging forward: stickers chat not in picker")), true);
  assert.equal(stagingForwardMenuBlocked(new Error("staging forward: message 9 not found")), false);
  assert.equal(stagingForwardMenuBlocked(new Error("file input not found")), false);
});

test("staging message menu uses deep press helpers and CDP hover", () => {
  const src = readFileSync(new URL("./telemost_upload.mjs", import.meta.url), "utf8");
  assert.match(src, /function tg2tmDeepWithin/);
  assert.match(src, /function tg2tmPress/);
  assert.match(src, /async cdpHover/);
  assert.match(src, /async messageRowGeometry/);
  assert.match(src, /async focusChatSurface/);
  assert.match(src, /async cdpKeyTap/);
  assert.match(src, /async pressMessageRowActions/);
  assert.match(src, /async focusMessageRow/);
  assert.match(src, /stagingForwardDebugCapture/);
  assert.match(src, /buffer-upload \$\{index\}\/\$\{total\} ok msgCount=/);
  assert.match(src, /via submenu target=/);
  assert.match(src, /bot-reply \$\{index\}\/\$\{total\}/);
  assert.match(src, /async readForwardFlyout/);
  assert.match(src, /async hoverForwardAnchor/);
  assert.match(src, /Переслать flyout did not open/);
  assert.equal(src.includes('forward-fallback-send'), false);
  assert.equal(src.includes('single-tab fallback'), false);
  assert.match(src, /stagingForwardMenuBlocked/);
  assert.match(STAGING_MESSAGE_ACTIONS_SELECTOR, /Действия с сообщением/);
  assert.match(STAGING_MESSAGE_ACTIONS_SELECTOR, /MessageActions/i);
  assert.match(STAGING_MESSAGE_ACTIONS_SELECTOR, /yamb-message-row__actions/);
});

test("stagingRowsForForward prefers survey then merges live hasImage", async () => {
  const bot = {
    surveyChat: async () => ({
      messages: [{ id: "5", own: false, text: "", links: [] }],
      reachedTop: true,
    }),
    scrollToBottom: async () => {},
    chatRows: async () => [{ id: "5", own: false, text: "", hasImage: true }],
  };
  const rows = await stagingRowsForForward(bot);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, "5");
  assert.equal(rows[0].hasImage, true);
});

test("staging own-id detection falls back when join chat omits row_own", () => {
  const beforeOwn = ["1"];
  const beforeAll = ["1", "2"];
  const beforeCount = 2;
  const withOwn = [
    { id: "1", own: true, text: "old photo", hasImage: true },
    { id: "2", own: false, text: "hi", hasImage: false },
    { id: "3", own: true, text: "new photo", hasImage: true },
  ];
  assert.equal(stagingOwnIdAfterSend(beforeOwn, beforeCount, withOwn, beforeAll), "3");
  assert.equal(newOwnId(beforeOwn, withOwn), "3");

  const joinBuffer = [
    { id: "1", own: false, text: "old", hasImage: true },
    { id: "2", own: false, text: "old2", hasImage: false },
    { id: "3", own: false, text: "", hasImage: true },
  ];
  assert.equal(newOwnId(beforeOwn, joinBuffer), null);
  assert.equal(stagingOwnIdAfterSend(beforeOwn, beforeCount, joinBuffer, beforeAll), "3");

  const twoNew = [
    { id: "1", own: false, text: "a", hasImage: false },
    { id: "2", own: false, text: "b", hasImage: false },
    { id: "3", own: false, text: "text", hasImage: false },
    { id: "4", own: false, text: "", hasImage: true },
  ];
  assert.deepEqual(stagingNewRows(2, ["1", "2"], twoNew).map((r) => r.id), ["3", "4"]);
  assert.equal(stagingOwnIdAfterSend(beforeOwn, beforeCount, twoNew, beforeAll), "4");

  const countOnly = [
    { id: "10", own: false, hasImage: true },
    { id: "11", own: false, hasImage: true },
  ];
  assert.equal(stagingOwnIdAfterSend([], 1, countOnly, null), "11");
});

test("two-tab routing and admin phases split buffer vs send", () => {
  assert.equal(stagingOperationTarget("buffer"), "staging");
  assert.equal(stagingOperationTarget("forward-resolve"), "staging");
  assert.equal(stagingOperationTarget("send"), "bot");
  assert.equal(stagingOperationTarget("say"), "bot");
  assert.equal(adminPhaseForStagingStep("buffer"), "buffering");
  assert.equal(adminPhaseForStagingStep("buffering"), "buffering");
  assert.equal(adminPhaseForStagingStep("send"), "sending");
  assert.equal(adminPhaseForStagingStep("forward"), "sending");
  assert.equal(stagingForwardExpectsRows({ stagingFilled: 5, uploaded: 0 }), true);
  assert.equal(stagingForwardExpectsRows({ stagingFilled: 3, uploaded: 3 }), false);
  assert.equal(stagingForwardMenuBlocked(new Error("staging forward: context menu did not open for 9")), true);
  assert.equal(stagingForwardMenuBlocked(new Error("staging forward: image 2 not found")), false);
  assert.equal(STAGING_CHAT_WARM_ITERATIONS, 4);
  const botUrl = "https://telemost.yandex.ru/user/fe21ed07-748c-969d-7459-b4e06d03e84d";
  const joinUrl = "https://telemost.yandex.ru/join#87de7b40-0e2e-0557-537a-fa84858fd189";
  assert.equal(telemostUrlMatches(botUrl, botUrl), true);
  assert.equal(telemostUrlMatches(`${botUrl}/chat`, botUrl), true);
  assert.equal(telemostUrlMatches(joinUrl, joinUrl), true);
  assert.equal(telemostUrlMatches(botUrl, joinUrl), false);
});

test("staging URLs come from settings or env, and the fill window stays ahead of the bot", () => {
  const fromFile = loadTelemostUrls({ TELEMOST_STAGING: undefined });
  assert.match(fromFile.botUrl, /telemost\.yandex\.ru\/user\//);
  assert.match(fromFile.stagingUrl, /telemost\.yandex\.ru\/join#/);
  assert.equal(fromFile.stagingEnabled, true);
  assert.equal(fromFile.stagingWindow, 5);
  const off = loadTelemostUrls({ TELEMOST_STAGING: '0' });
  assert.equal(off.stagingEnabled, false);
  const custom = loadTelemostUrls({
    TELEMOST_BOT_URL: 'https://telemost.yandex.ru/user/abc',
    TELEMOST_STAGING_URL: 'https://telemost.yandex.ru/join#buffer',
    TELEMOST_STAGING_WINDOW: '3',
  });
  assert.equal(custom.botUrl, 'https://telemost.yandex.ru/user/abc');
  assert.equal(custom.stagingUrl, 'https://telemost.yandex.ru/join#buffer');
  assert.equal(custom.botUrlSource, 'env:TELEMOST_BOT_URL');
  assert.equal(custom.stagingUrlSource, 'env:TELEMOST_STAGING_URL');
  assert.equal(custom.stagingWindow, 3);
  const fromVars = loadTelemostUrls({
    telemostbufferchannel: 'https://telemost.yandex.ru/chat/tg2tm-channel',
    telemoststickerbot: 'https://telemost.yandex.ru/user/stickers-bot',
  });
  assert.equal(fromVars.stagingUrl, 'https://telemost.yandex.ru/chat/tg2tm-channel');
  assert.equal(fromVars.stagingUrlSource, 'env:telemostbufferchannel');
  assert.equal(fromVars.botUrl, 'https://telemost.yandex.ru/user/stickers-bot');
  assert.equal(fromVars.botUrlSource, 'env:telemoststickerbot');
  assert.equal(fromVars.botName, 'Стикеры');
  assert.equal(githubActionsChatUrlError(fromVars, { GITHUB_ACTIONS: 'true' }), '');
  assert.match(
    githubActionsChatUrlError(loadTelemostUrls({}), { GITHUB_ACTIONS: 'true' }),
    /telemostbufferchannel/,
  );
  assert.equal(githubActionsChatUrlError(loadTelemostUrls({}), {}), '');
  assert.deepEqual(stagingFillTo(0, 0, 144, 5), [0, 1, 2, 3, 4]);
  assert.deepEqual(stagingFillTo(2, 5, 144, 5), [5, 6]);
  assert.deepEqual(stagingFillTo(2, 7, 144, 5), []);
  assert.deepEqual(stagingFillTo(2, 3, 144, 5), [3, 4, 5, 6]);
  assert.deepEqual(stagingFillTo(140, 140, 144, 5), [140, 141, 142, 143]);
});

test("buffer channel counts image bubbles and ignores id churn and _own", () => {
  const oldImage = { id: "1", own: false, hasImage: true, text: "20:43" };
  const textRow = { id: "2", own: false, hasImage: false, text: "system" };
  const before = [oldImage, textRow];
  assert.equal(bufferImageCount(before), 1);
  const recycled = [
    { id: "9", own: false, hasImage: true, text: "20:43" },
    { id: "10", own: false, hasImage: false, text: "system" },
  ];
  assert.equal(bufferImagesGrown(before, recycled).ok, false);
  assert.equal(bufferCountGrew(1, 1), false);
  const posted = [
    oldImage,
    textRow,
    { id: "3", own: false, hasImage: true, text: "" },
  ];
  const grown = bufferImagesGrown(before, posted);
  assert.equal(grown.ok, true);
  assert.equal(grown.msgCount, 2);
  assert.equal(grown.before, 1);
  assert.equal(grown.id, "3");
  assert.equal(bufferUploadLogLine(1, 116, grown.msgCount), "buffer-upload 1/116 ok msgCount=2");
  assert.equal(bufferImagesGrown(posted, posted).ok, false);
  assert.equal(newImageDidNotAppear(6, 6), "staging upload: new image did not appear (before 6, msgCount=6)");
  assert.equal(newImageDidNotAppear(6, 6).includes("leftover"), false);
  assert.equal(bufferBatchBubble(posted, 1, 1, 0).id, "3");
  assert.equal(bufferBatchBubble(posted, 1, 1, 1), null);
  const channel = [
    { id: "a", own: false, hasImage: true },
    { id: "b", own: false, hasImage: true },
    { id: "c", own: false, hasImage: true },
  ];
  assert.equal(bufferBatchBubble(channel, 0, 3, 0).id, "a");
  assert.equal(bufferBatchBubble(channel, 0, 3, 2).id, "c");
  const tail = channel.slice(1);
  assert.equal(bufferBatchBubble(tail, 5, 2, 1).id, "c");
  assert.equal(bufferBatchBubble([{ id: "1", own: false, hasImage: false, text: "menu" }], 0, 1, 0), null);
});

test("forward submenu matches Переслать and the exact chat title", () => {
  assert.equal(isForwardSubmenuLabel("Переслать", ""), true);
  assert.equal(isForwardSubmenuLabel("Переслать ›", ""), true);
  assert.equal(isForwardSubmenuLabel("Forward >", ""), true);
  assert.equal(isForwardSubmenuLabel("Удалить", ""), false);
  assert.equal(isForwardSubmenuLabel("Переслать сообщение", ""), false);
  assert.equal(submenuChatMatches("Стикеры", "", "Стикеры"), true);
  assert.equal(submenuChatMatches("Стикеры\nСтикер", "", "Стикеры"), true);
  assert.equal(submenuChatMatches("Стикеры Стикер", "", "Стикеры"), false);
  assert.equal(submenuChatMatches("Сохранённые сообщения", "", "Стикеры"), false);
  assert.equal(submenuChatMatches("TG2TM", "", "Стикеры"), false);
  assert.equal(submenuChatMatches("", "Стикеры", "Стикеры"), true);
  assert.equal(forwardSubmenuOpensRight(640, 480), true);
  assert.equal(forwardSubmenuOpensRight(80, 480), false);
  const sidebar = ["Ещё", "Настройки", "Аккаунт", "Все", "Личные", "TG2TM 1 подписчик F", "Отправить файлы", "Эмодзи, стикеры и картинки"];
  assert.equal(contextMenuLooksOpen(sidebar), false);
  assert.equal(flyoutLabelsHaveTarget(sidebar, "Стикеры"), false);
  assert.equal(contextMenuLooksOpen(["Ответить", "Переслать ›", "Обсудить", "Скачать изображение"]), true);
  const flyout = ["Сохранённые сообщения", "TG2TM", "Стикеры", "NikGonzalez", "Ещё"];
  assert.equal(flyoutLabelsHaveTarget(flyout, "Стикеры"), true);
  assert.equal(flyoutLabelsHaveTarget(flyout, "Стикер"), false);
  const anchor = { x: 480, y: 120, width: 220, height: 36 };
  assert.equal(flyoutAnchoredBeside({ x: 708, y: 110, width: 240, height: 280 }, anchor), true);
  assert.equal(flyoutAnchoredBeside({ x: 480, y: 80, width: 220, height: 360 }, anchor), false);
  assert.equal(flyoutAnchoredBeside({ x: 0, y: 0, width: 280, height: 800 }, anchor), false);
  const runUrl = "https://github.com/pretendless/tg2tm/actions/runs/38613076217";
  const closed = forwardFlyoutFailure({ opened: false, runUrl });
  assert.equal(closed, `staging forward: Переслать flyout did not open ${runUrl}`);
  assert.equal(closed.includes("Ещё"), false);
  assert.equal(closed.includes("Настройки"), false);
  assert.equal(
    forwardFlyoutFailure({ opened: true, target: "Стикеры", flyoutLabels: flyout, runUrl }),
    `staging forward: submenu target Стикеры not in flyout (Сохранённые сообщения, TG2TM, Стикеры, NikGonzalez, Ещё) ${runUrl}`,
  );
  assert.equal(forwardTargetFromTitle("Стикеры\nв сети", "бот"), "Стикеры");
  assert.equal(forwardTargetFromTitle("", "Стикеры"), "Стикеры");
  assert.equal(forwardSubmenuLogLine(1, 116, "Стикеры"), "forward 1/116 via submenu target=Стикеры");
  assert.equal(botReplyLogLine(1, 116, "image emoji hi"), "bot-reply 1/116 image emoji hi");
});

test("buffer clear empties TG2TM before upload and does not treat leftovers as this pack", () => {
  const leftovers = [
    { id: "1", hasImage: true, own: false },
    { id: "2", hasImage: true, own: false },
    { id: "3", hasImage: true, own: false },
    { id: "4", hasImage: true, own: false },
    { id: "5", hasImage: true, own: false },
  ];
  assert.equal(bufferPostCount(leftovers), 5);
  assert.equal(bufferClearStartLine(5), "buffer-clear start msgCount=5");
  assert.equal(bufferClearDeletedLine(2, 5), "buffer-clear deleted 2/5");
  assert.equal(bufferClearDoneLine(), "buffer-clear done msgCount=0");
  assert.equal(bufferClearAllowed(true), true);
  assert.equal(bufferClearAllowed(false), false);
  const runUrl = "https://github.com/pretendless/tg2tm/actions/runs/38615179852";
  assert.equal(
    bufferClearFailed(6, runUrl),
    `staging upload: could not clear TG2TM (msgCount=6); not uploading ${runUrl}`,
  );
  assert.equal(menuIsDeleteConfirm(["Удалить", "Отмена"]), true);
  assert.equal(menuIsDeleteConfirm(["Ответить", "Переслать", "Удалить"]), false);
  assert.equal(menuIsDeleteConfirm(["Ещё", "Настройки", "Аккаунт"]), false);
  assert.equal(BUFFER_DELETE_ATTEMPTS, 3);
  assert.equal(bufferDeleteReduced(6, 5), true);
  assert.equal(bufferDeleteReduced(6, 6), false);
  const deleteMenu = ["Ответить", "Переслать", "Обсудить", "Скачать изображение", "Выбрать", "Удалить", "Пожаловаться"];
  assert.equal(messageMenuHasDelete(deleteMenu), true);
  assert.equal(messageMenuHasDelete(["Ещё", "Настройки", "Аккаунт"]), false);
  assert.equal(messageMenuHasDelete(["Выбрать"]), false);
  const src = readFileSync(new URL("./telemost_upload.mjs", import.meta.url), "utf8");
  assert.match(src, /buffer-clear start msgCount=/);
  assert.match(src, /onStaging\(\(\) => bot\.clearBufferChannel\(\)\)/);
  assert.match(src, /new image did not appear/);
  assert.equal(src.includes("image count did not grow"), false);
  assert.equal(isDeleteMessageOk("ОК"), true);
  assert.equal(isDeleteMessageOk("Отмена"), false);
  assert.equal(dialogAsksDeleteMessage("Удалить сообщение?"), true);
  assert.equal(botClearStartLine(), "bot-clear start");
  assert.equal(botClearConfirmedLine(), "bot-clear confirmed");
  assert.equal(botClearSkippedLine(), "bot-clear skipped: not in sidebar");
  assert.equal(botReopenLine("https://telemost.yandex.ru/user/stickers"), "bot-reopen url=https://telemost.yandex.ru/user/stickers");
  assert.equal(
    botClearFailed(runUrl),
    `staging upload: could not clear Стикеры history ${runUrl}`,
  );
  assert.equal(isClearHistoryMenu(["Информация о чате", "Пожаловаться", "Очистить историю"]), true);
  assert.equal(isClearHistoryMenu(["Переслать", "Удалить", "Очистить историю"]), false);
  assert.equal(isClearHistoryConfirmButton("Очистить историю"), true);
  assert.equal(isClearHistoryConfirmButton("Очистить ис…"), true);
  assert.equal(isClearHistoryConfirmButton("Отмена"), false);
  assert.equal(dialogWarnsClearHistory("Чат пропадёт из общего списка. прошлые сообщения восстановить будет невозможно."), true);
  assert.equal(sidebarTitleIsChat("Стикеры\nСоздан набор стикеров", "Стикеры"), true);
  assert.equal(sidebarTitleIsChat("TG2TM\nИзображение", "Стикеры"), false);
  assert.match(src, /bot-clear skipped: not in sidebar/);
  assert.match(src, /clearStickersHistory/);
});

test("devtools opens a buffer tab with PUT and keeps the URL hash", () => {
  const target = "https://telemost.yandex.ru/chat/tg2tm-channel#room";
  const reqs = devtoolsNewTabRequests("http://127.0.0.1:9222", target);
  assert.equal(reqs[0].method, "PUT");
  assert.equal(reqs[1].method, "GET");
  assert.match(reqs[0].url, /^http:\/\/127\.0\.0\.1:9222\/json\/new\?/);
  assert.match(reqs[0].url, /%23room/);
  assert.equal(telemostUrlToken(target), telemostUrlToken("https://telemost.yandex.ru/chat/tg2tm-channel#room"));
  assert.equal(
    telemostUrlMatches("https://telemost.yandex.ru/chat/tg2tm-channel", "https://telemost.yandex.ru/chat/tg2tm-channel"),
    true,
  );
  assert.equal(
    telemostUrlMatches(
      "https://telemost.yandex.ru/user/fe21ed07-748c-969d-7459-b4e06d03e84d",
      "https://telemost.yandex.ru/chat/tg2tm-channel",
    ),
    false,
  );
});

test("addsticker continues a short saved pack from pack.json", () => {
  assert.equal(afterAddsticker("Отправьте ссылку на набор"), "link");
  assert.equal(afterAddsticker("Отправьте картинку для стикера."), "picture");
  assert.equal(afterAddsticker("Отправьте эмодзи для стикера."), "open");
  assert.equal(
    needsAddSticker({
      status: "incomplete",
      uploaded: 52,
      packUrl: "https://messenger.360.yandex.ru/#/stickers/8427",
    }, 144),
    true,
  );
  assert.equal(
    needsAddSticker({
      status: "done",
      uploaded: 144,
      packUrl: "https://messenger.360.yandex.ru/#/stickers/8427",
    }, 144),
    false,
  );
  assert.equal(needsAddSticker({ status: "pending", uploaded: 0, packUrl: null }, 144), false);
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
  const yugActive = [
    ...requests,
    {
      id: "y",
      title: "Юг",
      status: "uploading",
      links: ["https://t.me/addstickers/yug"],
      createdAt: "3",
      priority: false,
    },
  ];
  const open = restartTarget({ unfinished: true, title: "Юг", catalogs, requests: yugActive });
  assert.equal(open.action, "restart");
  assert.equal(open.dir, "02-yug");
  assert.equal(open.title, "Юг");
  const ghostCatalog = restartTarget({ unfinished: true, title: "Юг", catalogs, requests });
  assert.equal(ghostCatalog.action, "close");
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
  assert.equal(idle.title, "Восток");
  assert.equal(idle.requestId, "b");
  const resumeOnly = restartTarget({
    unfinished: false,
    title: "",
    catalogs,
    requests: requests.filter((item) => item.status === "uploading"),
  });
  assert.equal(resumeOnly.title, "Запад");
  const next = restartTarget({
    unfinished: false,
    title: "",
    catalogs,
    requests: requests.filter((item) => item.status === "queued"),
  });
  assert.equal(next.title, "Восток");
  assert.equal(restartTarget({ unfinished: false, title: "", catalogs, requests: [] }).action, "idle");
  const loose = restartTarget({ unfinished: true, title: "«юг» 🎉", catalogs, requests: yugActive });
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

test("closeOpenPackPlan uses /done for a zero-sticker picture draft", () => {
  const pictureOnly = "Создан набор стикеров «Маф, Изис и Агнес». Отправьте картинку для стикера.";
  const messages = [
    { own: false, text: pictureOnly },
  ];
  assert.equal(acceptedInOpenPack(messages), 0);
  assert.equal(shouldAbandonOpenPack(pictureOnly, messages), false);
  assert.deepEqual(closeOpenPackPlan(pictureOnly, messages), { action: "done" });
  assert.equal(
    closeOpenPackPlan("Отправьте картинку для стикера.\n/done — завершить действие", messages).action,
    "done",
  );
});

test("closeOpenPackPlan uses /done when stickers were accepted", () => {
  const ready = "Стикер готов. Отправьте картинку для следующего стикера или сохраните набор: /done";
  const messages = [
    { own: false, text: "Создан набор «Юг»." },
    { own: false, text: ready },
  ];
  assert.ok(acceptedInOpenPack(messages) >= 1);
  assert.equal(shouldAbandonOpenPack(ready, messages), false);
  assert.deepEqual(closeOpenPackPlan(ready, messages), { action: "done" });
});

test("closeOpenPackPlan blocks emoji dialog without publishing", () => {
  const emoji = "Отправьте эмодзи для стикера.";
  const messages = [
    { own: false, text: "Создан набор «Маф»." },
    { own: false, text: emoji },
  ];
  assert.equal(shouldAbandonOpenPack(emoji, messages), false);
  assert.deepEqual(closeOpenPackPlan(emoji, messages), { action: "blocked" });
});

test("latestIncomingText ignores an older saved bubble when a draft is open", () => {
  const saved =
    "Набор «Старый» сохранён и доступен по ссылке https://t.me/addstickers/staryy\n09:00";
  const open =
    "Создан набор стикеров «Маф, Изис и Агнес». Отправьте картинку для стикера.\n/done — завершить действие\n10:25";
  const combined = `${saved}\n${open}`;
  const incoming = { text: combined, bubbles: [{ text: saved }, { text: open }] };

  assert.equal(unfinishedPack(combined), false);
  assert.equal(unfinishedPackTail(combined), true);
  assert.equal(latestIncomingText(incoming), open);
  assert.equal(unfinishedPack(latestIncomingText(incoming)), true);

  const messages = [{ own: false, text: open }];
  assert.equal(shouldAbandonOpenPack(open, messages), false);
  assert.deepEqual(closeOpenPackPlan(open, messages), { action: "done" });
  assert.deepEqual(closeOpenPackPlan(latestIncomingText(incoming), messages), { action: "done" });
});

test("incomingTailText splits joined bubbles without DOM bubbles", () => {
  const saved = "Набор «Старый» сохранён и доступен по ссылке.";
  const open = "Создан набор «Маф». Отправьте картинку для стикера.";
  const combined = `${saved}\n${open}`;
  assert.equal(incomingTailText(combined), open);
  assert.equal(unfinishedPackTail(combined), true);
});

test("latestIncomingText skips a trailing command menu bubble", () => {
  const open = "Создан набор «Юг». Отправьте картинку для стикера.";
  const menu = "/newpack — создать набор\n/done — завершить\n/stickers — мои наборы";
  const incoming = { text: `${open}\n${menu}`, bubbles: [{ text: open }, { text: menu }] };
  assert.equal(latestIncomingText(incoming), open);
  assert.equal(unfinishedPack(latestIncomingText(incoming)), true);
});
