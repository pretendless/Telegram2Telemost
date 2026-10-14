// Pack-format replies and Telemost progress notices for @tg2tmbot.
// The final "done" note and the channel post wait until packUrl is a real link.
// A completion note that already went out without a link is followed by that link once.

export const MAX_STICKERS = 150;
export const BOT_NAME = "Telegram2Telemost";
export const CHANNEL = "https://t.me/tg2tm";
export const CHANNEL_CHAT = "@tg2tm";
export const CHANNEL_TITLE = "Стикеры TG → Телемост";
export const CHANNEL_ABOUT = "Готовые наборы стикеров, перенесённые в Телемост. Каждый пост — один набор и ссылка на него.";
export const STEPS = [25, 50, 75];
// Existing subscriber from the polling bot. Written to KV once; /stop is not undone.
export const INITIAL_SUBSCRIBER = 8502935020;

export const EXAMPLE =
  "Минто\n" +
  "\n" +
  "https://t.me/addstickers/minty_vk\n" +
  "https://t.me/addstickers/minty2_vk";

export const FORMAT =
  "Одно сообщение — один пак Телемоста.\n" +
  "\n" +
  "1. Первая строка — название пака.\n" +
  "2. Дальше ссылки t.me/addstickers/…, по одной в строке. Порядок ссылок = порядок стикеров.\n" +
  `3. Всего не больше ${MAX_STICKERS} стикеров: это лимит Телемоста на пак.\n` +
  "\n" +
  "Пример:\n" +
  "\n" +
  EXAMPLE;

export const START =
  `${BOT_NAME} (@tg2tmbot) переносит стикеры из Telegram в Телемост.\n` +
  "\n" +
  FORMAT +
  `\n\nГотовые наборы публикуются в канале ${CHANNEL}` +
  "\n\nСначала /create — затем одним сообщением название и ссылки (см. /format). Бот проверит набор и поставит его в очередь." +
  "\n\nВы подписаны на ход переноса: бот напишет, когда пак начнёт загружаться, как идёт загрузка и пришлёт ссылку на готовый пак в Телемосте. /status — текущее состояние, /stop — отписаться.";

export const DESCRIPTION =
  `${BOT_NAME} переносит стикеры из Telegram в Телемост.\n` +
  "\n" +
  "Одно сообщение — один пак: первая строка — название, дальше ссылки t.me/addstickers/… по порядку, " +
  `всего до ${MAX_STICKERS} стикеров.\n` +
  "\n" +
  "Пример:\n" +
  EXAMPLE +
  "\n\n" +
  `Бот проверяет набор и сообщает о ходе загрузки. Готовые наборы: ${CHANNEL}`;

export const ABOUT = "Переносит стикеры из Telegram в Телемост.";

export const CREATE_PROMPT =
  "Жду описание пака одним сообщением.\n\n" +
  "Первая строка — название, дальше ссылки t.me/addstickers/… (подробнее — /format).";

export const NEED_CREATE =
  "Сначала отправьте /create, затем одним сообщением название и ссылки t.me/addstickers/…\n\nПодробнее — /format.";

export const AWAIT_CREATE_PREFIX = "await:";

export function awaitCreateKey(chatId) {
  return `${AWAIT_CREATE_PREFIX}${chatId}`;
}

// Telegram menu (BotFather / setMyCommands). Admin-only rows — ADMIN_ONLY_COMMANDS.
export const USER_COMMANDS = [
  { command: "start", description: "Как пользоваться" },
  { command: "create", description: "Новый запрос на перенос" },
  { command: "format", description: "Формат и пример пака" },
  { command: "status", description: "Ваши запросы в очереди" },
  { command: "stop", description: "Отписаться" },
];

export const ADMIN_ONLY_COMMANDS = [
  { command: "queue", description: "Очередь и прогресс" },
  { command: "unstick", description: "Снять зависшую загрузку" },
  { command: "skip", description: "Пропустить текущий пак" },
  { command: "restart", description: "Перезапустить загрузку" },
  { command: "project", description: "Вопрос или задача для Cursor Cloud Agent" },
  { command: "ghrun", description: "Запустить GitHub workflow" },
  { command: "login", description: "Войти в Яндекс" },
  { command: "connect", description: "Войти в аккаунт с меткой" },
  { command: "upload", description: "Загрузить паки этой сессией" },
];

export const ADMIN_COMMANDS = USER_COMMANDS.concat(ADMIN_ONLY_COMMANDS);

const STATUS_RU = { pending: "ждёт", uploading: "загружается", done: "готов", error: "ошибка" };
const STATUSES = new Set(Object.keys(STATUS_RU));
const LINK_RE = /(?:https?:\/\/)?t\.me\/addstickers\/([A-Za-z0-9_]+)/g;

export function emptyState() {
  return {
    started: false,
    step: 0,
    done: false,
    doneWithoutLink: false,
    doneWithLink: false,
    posted: false,
    error: null,
  };
}

export function normalizeState(prev) {
  const state = { ...emptyState(), ...(prev || {}) };
  if (state.doneWithLink) state.doneWithoutLink = false;
  else if (state.done) state.doneWithoutLink = true;
  return state;
}

// A Telemost pack link. t.me/addstickers is a submission, not a finished pack.
export function realPackUrl(url) {
  if (typeof url !== "string") return null;
  const trimmed = url.trim();
  if (!trimmed || trimmed.length > 500) return null;
  if (/addstickers/i.test(trimmed)) return null;
  let parsed;
  try {
    parsed = new URL(trimmed);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return null;
  return trimmed;
}

export function channelPost(pack) {
  return `«${pack.title}»\n\n${pack.url}`;
}

export function doneNotice(title, total, url, followUp) {
  const head = followUp
    ? `Ссылка на пак «${title}» в Телемосте:\n${url}`
    : `Готово: пак «${title}» в Телемосте, ${total} стикеров.\n${url}`;
  return `${head}\n\nГотовые наборы: ${CHANNEL}`;
}

function snapshot(state) {
  return { ...state };
}

// Ordered deliveries. State on each step is what to store after that delivery succeeds.
export function notificationSteps(prev, pack) {
  const state = normalizeState(prev);
  const steps = [];
  const title = pack.title;
  const uploaded = pack.uploaded;
  const total = pack.total;
  const pct = total ? Math.floor((100 * uploaded) / total) : 0;
  const url = realPackUrl(pack.url);

  if ((pack.status === "uploading" || pack.status === "done") && !state.started) {
    state.started = true;
    steps.push({
      kind: "subscribers",
      text: `Начата загрузка пака «${title}» в Телемост: ${uploaded}/${total}.`,
      state: snapshot(state),
    });
  }

  if (pack.status === "uploading") {
    const reached = STEPS.reduce((max, step) => (pct >= step ? step : max), 0);
    if (reached > state.step) {
      state.step = reached;
      steps.push({
        kind: "subscribers",
        text: `«${title}»: ${uploaded}/${total} (${reached} %).`,
        state: snapshot(state),
      });
    }
  }

  if (pack.status === "error" && pack.error && pack.error !== state.error) {
    state.error = pack.error;
    steps.push({
      kind: "subscribers",
      text: `Ошибка в паке «${title}»: ${pack.error}. Загрузка остановлена на ${uploaded}/${total}; перезапуск продолжит с этого места.`,
      state: snapshot(state),
    });
  }

  // Done notice and the channel post both wait for a real pack link.
  if (pack.status === "done" && url && !state.doneWithLink) {
    const text = doneNotice(title, total, url, state.doneWithoutLink);
    state.done = true;
    state.doneWithLink = true;
    state.doneWithoutLink = false;
    steps.push({ kind: "subscribers", text, state: snapshot(state) });
  }

  if (pack.status === "done" && url && !state.posted) {
    state.posted = true;
    steps.push({
      kind: "channel",
      text: channelPost({ ...pack, url }),
      state: snapshot(state),
    });
  }

  return steps;
}

export function planNotifications(prev, pack) {
  const steps = notificationSteps(prev, pack);
  const state = steps.length ? steps[steps.length - 1].state : normalizeState(prev);
  return {
    steps,
    state,
    messages: steps.filter((step) => step.kind === "subscribers").map((step) => step.text),
    channel: steps.find((step) => step.kind === "channel")?.text || null,
  };
}

function countOf(value, label) {
  const n = Number(value ?? 0);
  if (!Number.isFinite(n) || n < 0 || n > 100000) throw new Error(label);
  return Math.floor(n);
}

function optionalHttpUrl(value) {
  const text = String(value || "").trim();
  if (!/^https?:\/\//i.test(text)) return null;
  return text.slice(0, 300);
}

export function normalizeProgress(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("body");
  const telemost = body.telemost && typeof body.telemost === "object" ? body.telemost : {};
  const slug = String(body.slug || "").trim();
  // Request ids keep the ISO "T" and "Z" (request-2026-10-13T180955555Z-2).
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(slug)) throw new Error("slug");
  const title = String(body.title || "").replace(/\s+/g, " ").trim();
  if (!title || title.length > 200) throw new Error("title");
  const status = body.status || telemost.status || "pending";
  if (!STATUSES.has(status)) throw new Error("status");
  const source = body.source ?? body.sourceMessage ?? null;
  const error = body.error !== undefined ? body.error : telemost.error;
  return {
    slug,
    title,
    source: source ? String(source).slice(0, 300) : null,
    status,
    uploaded: countOf(body.uploaded !== undefined ? body.uploaded : telemost.uploaded, "uploaded"),
    total: countOf(
      body.total !== undefined ? body.total : body.stickerCount !== undefined ? body.stickerCount : telemost.total,
      "total",
    ),
    url: realPackUrl(body.packUrl !== undefined ? body.packUrl : telemost.packUrl),
    error: error ? String(error).slice(0, 500) : null,
    runUrl: optionalHttpUrl(body.runUrl),
    adminDelivered: Boolean(body.adminDelivered),
    lastLine: body.lastLine ? String(body.lastLine).slice(0, 300) : null,
    phase: typeof body.phase === "string" ? body.phase.slice(0, 40) : null,
    requester: body.requester ? String(body.requester).slice(0, 32) : null,
    requesterChatId: body.requesterChatId ? String(body.requesterChatId).slice(0, 16) : null,
    queueRequestId: body.queueRequestId ? String(body.queueRequestId).slice(0, 64) : null,
    sessionDrain: Boolean(body.sessionDrain),
  };
}

// While a Telemost Actions job drains the queue in-browser, terminal progress still
// releases the row (same as bc-c3fb423d) but must not dispatch another workflow.
export function shouldSchedulePipelineAfterProgress(pack) {
  return !pack.sessionDrain;
}

export function commandOf(text) {
  if (!text.startsWith("/")) return "";
  return text.split(/\s/)[0].split("@")[0].toLowerCase();
}

export function staticReply(cmd) {
  if (cmd === "/start" || cmd === "/help") return { subscribe: true, text: START };
  if (cmd === "/stop") return { subscribe: false, text: "Уведомления выключены. /start — включить снова." };
  if (cmd === "/format" || cmd === "/example") return { text: FORMAT };
  return null;
}

export function parsePackMessage(text) {
  const lines = text.trim().split(/\r?\n/).map((line) => line.trim());
  const title = lines.find((line) => line) || "";
  const names = [];
  for (const line of lines) {
    for (const match of line.matchAll(LINK_RE)) {
      if (!names.includes(match[1])) names.push(match[1]);
    }
  }
  const titleIsLink = /(?:https?:\/\/)?t\.me\/addstickers\/[A-Za-z0-9_]+/.test(title);
  return { title, names, ok: names.length > 0 && !titleIsLink };
}

export const NOT_A_PACK =
  "Не похоже на пак. Нужно: первая строка — название, дальше ссылки t.me/addstickers/….\n\nПример:\n\n" + EXAMPLE;

export function renderPackCheck(title, rows, total) {
  const verdict =
    total <= MAX_STICKERS
      ? `Всего ${total} стикеров — укладывается в лимит ${MAX_STICKERS}.`
      : `Всего ${total} стикеров — больше лимита ${MAX_STICKERS}. Разбейте на два сообщения.`;
  return `Пак «${title}»\n\n${rows.join("\n")}\n\n${verdict}`;
}

export const QUEUE_KEY = "queue";

export function emptyQueue() {
  return { priority: [], items: [] };
}

function sameLinks(left, right) {
  return left.length === right.length && left.every((link, index) => link === right[index]);
}

export function normalizeQueue(raw) {
  const source = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  const priority = [];
  for (const id of Array.isArray(source.priority) ? source.priority : []) {
    const text = String(id);
    if (/^[0-9]{1,16}$/.test(text) && !priority.includes(text)) priority.push(text);
  }
  const items = [];
  for (const item of Array.isArray(source.items) ? source.items : []) {
    if (!item || typeof item !== "object") continue;
    const id = String(item.id || "");
    const chatId = String(item.chatId ?? "");
    const title = String(item.title || "").trim();
    const links = Array.isArray(item.links) ? item.links.map((link) => String(link)) : [];
    const status = ["queued", "uploading", "done", "error"].includes(item.status) ? item.status : "";
    const createdAt = String(item.createdAt || "");
    if (!id || !/^[0-9]{1,16}$/.test(chatId) || !title || !links.length || !status || !createdAt) continue;
    const row = {
      id,
      chatId,
      title,
      links,
      priority: Boolean(item.priority),
      createdAt,
      status,
      stickers: Number.isFinite(Number(item.stickers)) ? Number(item.stickers) : links.length,
    };
    if (item.notifyMessageId && /^[0-9]{1,16}$/.test(String(item.notifyMessageId))) {
      row.notifyMessageId = Number(item.notifyMessageId);
    }
    items.push(row);
  }
  return { priority, items };
}

export function isPriorityChat(queue, chatId) {
  return queue.priority.includes(String(chatId));
}

function sameRequest(left, right) {
  return (
    left.chatId === String(right.chatId) &&
    left.title === right.title &&
    sameLinks(left.links, right.links)
  );
}

function duplicateDoneRequest(queue, request) {
  const title = String(request.title || "").trim();
  return queue.items.find(
    (item) =>
      item.status === "done" &&
      (item.title === title || sameLinks(item.links, request.links)),
  );
}

// One document, so accepting a request is one KV write. Identical open or finished requests are not written again.
export function enqueueRequest(queue, request) {
  const open = queue.items.find(
    (item) =>
      sameRequest(item, request) &&
      (item.status === "queued" || item.status === "uploading"),
  );
  if (open) return { queue, item: open, created: false, duplicate: "open" };
  const done = queue.items.find((item) => sameRequest(item, request) && item.status === "done");
  if (done) return { queue, item: done, created: false, duplicate: "done" };
  const doneGlobally = duplicateDoneRequest(queue, request);
  if (doneGlobally) return { queue, item: doneGlobally, created: false, duplicate: "done" };
  const createdAt = request.createdAt;
  const item = {
    id: `${createdAt}-${queue.items.length}`,
    chatId: String(request.chatId),
    title: request.title,
    links: request.links.slice(),
    priority: Boolean(request.priority),
    createdAt,
    status: "queued",
    stickers: request.stickers,
  };
  return {
    queue: { priority: queue.priority.slice(), items: queue.items.concat(item) },
    item,
    created: true,
    duplicate: null,
  };
}

export function queueHasPendingWork(queue) {
  return queue.items.some((item) => item.status === "queued" || item.status === "uploading");
}

export function queueHasQueuedWork(queue) {
  return queue.items.some((item) => item.status === "queued");
}

// Start Actions only when nothing is running and the KV queue still has work.
export function shouldStartPipeline(queue, activeRun) {
  if (activeRun) return false;
  // A lone "uploading" row means a run already claimed it; autostart must not
  // dispatch again (that re-runs the same pack). New work is only "queued" rows.
  return queueHasQueuedWork(queue);
}

export function duplicateRequestReply({ title, duplicate, priority }) {
  if (duplicate === "done") {
    return `Набор «${title}» уже переносился. Чтобы отправить снова, измените название или список ссылок.`;
  }
  return alreadyQueuedReply({ title, priority: Boolean(priority) });
}

// Match the queue row to close when upload progress reaches a terminal state.
// Slug (`request-<id>`) wins over queueRequestId: pack.json metadata can be stale while
// the KV row still shows another item as uploading.
export function findUploadingReleaseId(queue, pack) {
  const items = (queue && queue.items) || [];
  if (pack.slug) {
    const bySlug = queueItemBySlug(queue, pack.slug);
    if (bySlug && (bySlug.status === "uploading" || bySlug.status === "queued")) return bySlug.id;
  }
  const explicit = pack.queueRequestId ? String(pack.queueRequestId) : "";
  if (explicit) {
    const hit = items.find((item) => item.id === explicit);
    if (hit && (hit.status === "uploading" || hit.status === "queued")) return hit.id;
  }
  const byTitle = items.filter((item) => item.status === "uploading" && item.title === pack.title);
  if (byTitle.length === 1) return byTitle[0].id;
  const loneUploading = items.filter((item) => item.status === "uploading");
  if (loneUploading.length === 1 && pack.title && loneUploading[0].title === pack.title) {
    return loneUploading[0].id;
  }
  return null;
}

export function terminalProgress(pack) {
  return (pack.status === "done" && Boolean(pack.url)) || pack.status === "error";
}

function byTime(left, right) {
  return left.createdAt < right.createdAt ? -1 : left.createdAt > right.createdAt ? 1 : left.id < right.id ? -1 : 1;
}

// Queued rows for display and ahead-count: priority first, FIFO within each band.
export function sortQueuedItems(items) {
  const waiting = (items || []).filter((item) => item.status === "queued");
  const priority = waiting.filter((item) => item.priority).sort(byTime);
  const normal = waiting.filter((item) => !item.priority).sort(byTime);
  return priority.concat(normal);
}

function packProgressTerminal(pack) {
  return pack && terminalProgress(pack);
}

// Reset stuck "uploading" rows when Actions is not running (admin /unstick).
// Rows whose pack progress is already done/error are marked done/error in the queue
// instead of being re-queued (avoids re-uploading the same request).
export function unstickUploadingQueue(queue, { packForItem = null, terminalOnly = false } = {}) {
  const stuck = (queue.items || []).filter((item) => item.status === "uploading");
  if (!stuck.length) return { queue, changed: false, reason: "none", released: [], finished: [] };
  let changed = false;
  const released = [];
  const finished = [];
  const items = queue.items.map((item) => {
    if (item.status !== "uploading") return item;
    if (packForItem) {
      const pack = packForItem(item);
      if (packProgressTerminal(pack)) {
        changed = true;
        const status = pack.status === "error" ? "error" : "done";
        finished.push({ ...item, status });
        return { ...item, status };
      }
    }
    if (terminalOnly) return item;
    changed = true;
    released.push(item);
    return { ...item, status: "queued" };
  });
  return {
    queue: changed ? { priority: queue.priority.slice(), items } : queue,
    changed,
    reason: released.length || finished.length ? "released" : "none",
    released,
    finished,
  };
}

// Admin /skip: drop the current uploading row and advance the queue.
export function skipUploadingQueue(queue) {
  const stuck = (queue.items || []).filter((item) => item.status === "uploading");
  if (!stuck.length) return { queue, changed: false, reason: "none", skipped: [] };
  let changed = false;
  const skipped = [];
  const items = queue.items.map((item) => {
    if (item.status !== "uploading") return item;
    changed = true;
    skipped.push(item);
    return { ...item, status: "error" };
  });
  return {
    queue: changed ? { priority: queue.priority.slice(), items } : queue,
    changed,
    reason: "skipped",
    skipped,
  };
}

export function skipReply({ reason, skipped, actionsRunning }) {
  if (actionsRunning) {
    return "Сейчас идёт запуск Actions — /skip не выполняю.";
  }
  if (reason === "none" || !skipped.length) {
    return "Нет строки «загружается» — /skip не к чему применить.";
  }
  const titles = skipped.map((item) => `«${item.title}»`).join(", ");
  return `Пропустил ${titles} (ошибка в очереди). Запускаю следующий пак, если очередь не пуста.`;
}

export function unstickReply({ reason, released, finished, actionsRunning, cleanedWhileRunning = false }) {
  if (actionsRunning) {
    if (cleanedWhileRunning && (finished || []).length) {
      const titles = finished.map((item) => `«${item.title}»`).join(", ");
      return `Сейчас идёт Actions — строку «загружается» не снимаю. Закрыл в очереди как готовый: ${titles} (прогресс в KV уже был завершён). Когда run закончится, при необходимости снова /unstick или /skip.`;
    }
    return "Сейчас идёт запуск Actions — строку «загружается» не трогаю. Если run оборвётся, повторите /unstick (или /skip).";
  }
  if (reason === "none" || (!released.length && !(finished || []).length)) {
    return "Зависших строк «загружается» нет.";
  }
  const parts = [];
  if ((finished || []).length) {
    const titles = finished.map((item) => `«${item.title}»`).join(", ");
    parts.push(`Закрыл в очереди как готовый: ${titles} (прогресс уже был завершён).`);
  }
  if (released.length) {
    const titles = released.map((item) => `«${item.title}»`).join(", ");
    const one = released.length === 1;
    const subject = one ? "Набор" : "Наборы";
    const wait = one ? "снова ждёт" : "снова ждут";
    parts.push(`Снял блокировку «загружается» у ${titles}. ${subject} ${wait} в очереди.`);
  }
  parts.push("Запускаю pipeline: следующий пак по приоритету (или /restart, /skip — пропустить текущий).");
  return parts.join(" ");
}

// Priority requests pass normal ones. An item already uploading stays in front and is not replaced.
export function claimNext(queue) {
  const active = queue.items.find((item) => item.status === "uploading");
  if (active) return { queue, claimed: active, changed: false, busy: true };
  const waiting = queue.items.filter((item) => item.status === "queued").sort(byTime);
  const priority = waiting.filter((item) => item.priority);
  const next = (priority.length ? priority : waiting)[0] || null;
  if (!next) return { queue, claimed: null, changed: false, busy: false };
  const items = queue.items.map((item) => (item.id === next.id ? { ...item, status: "uploading" } : item));
  return {
    queue: { priority: queue.priority.slice(), items },
    claimed: { ...next, status: "uploading" },
    changed: true,
    busy: false,
  };
}

// Mark one stored request as the upload in progress. Another uploading row goes back to the queue.
export function focusRequest(queue, id) {
  const found = queue.items.find((item) => item.id === id);
  if (!found) return { queue, changed: false, item: null };
  const items = queue.items.map((item) => {
    if (item.id === id) return { ...item, status: "uploading" };
    if (item.status === "uploading") return { ...item, status: "queued" };
    return item;
  });
  const changed = items.some((item, index) => item.status !== queue.items[index].status);
  return {
    queue: changed ? { priority: queue.priority.slice(), items } : queue,
    changed,
    item: { ...found, status: "uploading" },
  };
}

export function releaseRequest(queue, id, status) {
  if (status !== "done" && status !== "error") return { queue, changed: false };
  let changed = false;
  const items = queue.items.map((item) => {
    if (item.id !== id || item.status === status) return item;
    changed = true;
    return { ...item, status };
  });
  return { queue: changed ? { priority: queue.priority.slice(), items } : queue, changed };
}

export function aheadCount(queue, item) {
  if (item.status !== "queued") return 0;
  let ahead = queue.items.some((other) => other.status === "uploading") ? 1 : 0;
  for (const other of queue.items) {
    if (other.id === item.id || other.status !== "queued") continue;
    if (item.priority) {
      if (other.priority && byTime(other, item) < 0) ahead++;
    } else if (other.priority || byTime(other, item) < 0) {
      ahead++;
    }
  }
  return ahead;
}

export function queueStatusText(queue, chatId) {
  const mine = queue.items.filter((item) => item.chatId === String(chatId));
  if (!mine.length) return null;
  const lines = mine.map((item) => {
    const priority = item.priority ? " с приоритетом" : "";
    if (item.status === "uploading") return `«${item.title}»${priority}: загружается`;
    if (item.status === "done") return `«${item.title}»${priority}: готов`;
    if (item.status === "error") return `«${item.title}»${priority}: ошибка, можно прислать набор ещё раз`;
    const ahead = aheadCount(queue, item);
    return `«${item.title}»${priority}: в очереди, перед ним ${ahead}`;
  });
  return `Ваши запросы:\n\n${lines.join("\n")}`;
}

export function alreadyQueuedReply({ title, priority }) {
  const head = priority
    ? `Запрос «${title}» уже в очереди с приоритетом.`
    : `Запрос «${title}» уже в очереди.`;
  return head;
}

export function acceptReply({ title, rows, total, priority, ahead }) {
  const head = priority
    ? `Запрос принят с приоритетом. «${title}» встанет в очередь сразу после набора, который уже загружается.`
    : `Запрос принят. «${title}» в очереди.`;
  const position =
    typeof ahead === "number"
      ? ahead === 0
        ? "\n\nСейчас перед вами никого — ждём свободный запуск Actions."
        : `\n\nПеред вами в очереди: ${ahead}.`
      : "";
  return `${head}${position}\n\n${rows.join("\n")}\n\nВсего ${total} стикеров.`;
}

export function queueItemSlug(item) {
  const id = String((item && item.id) || "next").replace(/[^A-Za-z0-9_-]/g, "");
  return (`request-${id}`).slice(0, 48);
}

/** Admin /status and /queue: only the queue row marked uploading counts as live work. */
export function activeUploadJob(queue, packProgress) {
  const item = ((queue && queue.items) || []).find((entry) => entry && entry.status === "uploading");
  if (!item) return { running: false };
  const pack = packProgress && typeof packProgress === "object" ? packProgress : null;
  const uploaded = pack && Number.isFinite(pack.uploaded) ? pack.uploaded : null;
  const total =
    pack && Number.isFinite(pack.total) && pack.total > 0
      ? pack.total
      : Number.isFinite(item.stickers) && item.stickers > 0
        ? item.stickers
        : null;
  if (uploaded != null && total != null) {
    return { running: true, pack: item.title, index: uploaded, total };
  }
  if (total != null) return { running: true, pack: item.title, index: null, total };
  return { running: true, pack: item.title };
}

export function adminQueueOverviewText(queue, activePack) {
  const items = (queue && queue.items) || [];
  const lines = ["Очередь переноса:", ""];
  const uploading = items.find((item) => item.status === "uploading");
  if (uploading) {
    let line = `Сейчас загружается: «${uploading.title}»`;
    if (uploading.chatId) line += ` (chat ${uploading.chatId})`;
    if (activePack && Number.isFinite(activePack.uploaded) && Number.isFinite(activePack.total)) {
      line += ` — стикер ${activePack.uploaded} из ${activePack.total}`;
    } else if (uploading.stickers) {
      line += ` — всего ${uploading.stickers} стикеров`;
    }
    lines.push(line);
  } else {
    lines.push("Сейчас никто не загружается.");
  }
  const waiting = sortQueuedItems(items);
  if (uploading && waiting.length) {
    lines.push("");
    lines.push(
      "Подсказка: в очереди есть ожидающие, а в списке ещё «загружается». Если Actions не идут — /unstick (снимет блокировку и запустит следующий пак).",
    );
  }
  lines.push("");
  if (!waiting.length) {
    lines.push("В очереди: пусто.");
  } else {
    lines.push("В очереди:");
    waiting.forEach((item, index) => {
      const pri = item.priority ? ", приоритет" : "";
      const who = item.chatId ? `, chat ${item.chatId}` : "";
      lines.push(`${index + 1}. «${item.title}»${pri}${who}`);
    });
  }
  const recent = items
    .filter((item) => item.status === "done" || item.status === "error")
    .sort((left, right) => -byTime(left, right))
    .slice(0, 5);
  lines.push("");
  if (!recent.length) {
    lines.push("Недавно: записей нет.");
  } else {
    lines.push("Недавно:");
    for (const item of recent) {
      const mark = item.status === "done" ? "готово" : "ошибка";
      lines.push(`• ${mark}: «${item.title}»`);
    }
  }
  return lines.join("\n");
}

function userCardKey(event) {
  return [
    event.phase || "",
    event.pack || "",
    Number(event.index),
    Number(event.total),
    Number(event.ahead),
    event.url || "",
    event.error || "",
  ].join("\0");
}

export function userRequestEvent({ item, pack, queue }) {
  const title = (pack && pack.title) || (item && item.title) || "";
  if (pack && pack.status === "error") {
    return {
      phase: "error",
      pack: title,
      index: pack.uploaded,
      total: pack.total,
      error: pack.error || "ошибка загрузки",
    };
  }
  if (pack && pack.status === "done" && pack.url) {
    return { phase: "done", pack: title, index: pack.total, total: pack.total, url: pack.url };
  }
  if (pack && (pack.status === "uploading" || pack.status === "done")) {
    return { phase: "uploading", pack: title, index: pack.uploaded, total: pack.total };
  }
  if (item && item.status === "uploading") {
    return { phase: "starting", pack: title, index: 0, total: item.stickers || null };
  }
  if (item && item.status === "queued" && queue) {
    return { phase: "queued", pack: title, ahead: aheadCount(queue, item) };
  }
  return { phase: "queued", pack: title, ahead: 0 };
}

export function formatUserRequestCard(event) {
  const title = event.pack || "пак";
  if (event.phase === "queued") {
    const ahead = Number(event.ahead) || 0;
    if (ahead === 0) return `«${title}»: в очереди, перед вами никого.`;
    return `«${title}»: в очереди, перед вами ${ahead}.`;
  }
  if (event.phase === "starting") {
    const total = Number(event.total);
    return Number.isFinite(total) && total > 0
      ? `«${title}»: загрузка в Телемост началась (0 из ${total}).`
      : `«${title}»: загрузка в Телемост началась.`;
  }
  if (event.phase === "uploading") {
    const index = Number(event.index) || 0;
    const total = Number(event.total) || 0;
    if (total) return `«${title}»: стикер ${index} из ${total}.`;
    return `«${title}»: загрузка идёт (${index}).`;
  }
  if (event.phase === "done" && event.url) {
    return `«${title}»: готово.\n${event.url}`;
  }
  if (event.phase === "error") {
    const index = Number(event.index) || 0;
    const total = Number(event.total) || 0;
    const where = total ? ` на ${index}/${total}` : "";
    return `«${title}»: ошибка${where}: ${event.error || "загрузка остановлена"}.`;
  }
  return `«${title}»: ${event.phase || "статус"}.`;
}

export function userRequestDelivery(prev, next) {
  if (!prev) return { action: "send" };
  if ((prev.pack || "") !== (next.pack || "")) return { action: "send" };
  if (userCardKey(prev) === userCardKey(next)) return { action: "skip" };
  return { action: "edit" };
}

export async function deliverUserRequestCard(io, chatId, prev, event) {
  const decision = userRequestDelivery(prev && prev.event, event);
  const text = formatUserRequestCard(event);
  if (decision.action === "skip") {
    return { action: "skip", messageId: prev && prev.messageId, event: prev.event, text: prev && prev.text };
  }
  if (decision.action === "edit" && prev && prev.messageId) {
    try {
      await io.edit(chatId, prev.messageId, text);
      return { action: "edit", messageId: prev.messageId, event, text };
    } catch {
      try {
        await io.delete(chatId, prev.messageId);
      } catch {
        // stale card
      }
      const messageId = messageIdOf(await io.send(chatId, text));
      return { action: "replace", messageId, event, text };
    }
  }
  const messageId = messageIdOf(await io.send(chatId, text));
  return { action: "send", messageId, event, text };
}

function messageIdOf(result) {
  if (result && typeof result === "object" && result.message_id) return result.message_id;
  if (typeof result === "number") return result;
  return null;
}

export function attachQueueNotifyMessage(queue, itemId, messageId) {
  const id = String(itemId || "");
  if (!id || !messageId) return { queue, changed: false };
  let changed = false;
  const items = queue.items.map((item) => {
    if (item.id !== id || item.notifyMessageId === messageId) return item;
    changed = true;
    return { ...item, notifyMessageId: messageId };
  });
  return { queue: changed ? { priority: queue.priority.slice(), items } : queue, changed };
}

export function queueItemByRequestId(queue, requestId) {
  const id = String(requestId || "");
  if (!id) return null;
  return ((queue && queue.items) || []).find((item) => item.id === id) || null;
}

export function queueItemBySlug(queue, slug) {
  const key = String(slug || "").trim();
  if (!key.startsWith("request-")) return null;
  return ((queue && queue.items) || []).find((item) => queueItemSlug(item) === key) || null;
}

// Queue KV is authoritative for who submitted the request. Progress may carry the
// admin chat id in `requester` when pack.json omitted requesterChatId.
export function resolveRequesterChatId(pack, item) {
  const fromItem = item && item.chatId != null ? String(item.chatId).trim() : "";
  if (/^[0-9]{1,16}$/.test(fromItem)) return fromItem;
  const explicit = pack && pack.requesterChatId != null ? String(pack.requesterChatId).trim() : "";
  if (/^[0-9]{1,16}$/.test(explicit)) return explicit;
  return null;
}

export function activeProgressPacks(packs) {
  return (packs || []).filter((pack) => pack && !terminalProgress(pack));
}

export function statusText(packs) {
  const sorted = activeProgressPacks(packs).sort((a, b) => String(a.slug).localeCompare(String(b.slug)));
  if (!sorted.length) return "Перенос в Телемост: активных паков нет.";
  const rows = sorted.map((pack) => {
    let line = `${STATUS_RU[pack.status] || pack.status}: «${pack.title}» — ${pack.uploaded}/${pack.total}`;
    if (pack.url) line += `\n   ${pack.url}`;
    return line;
  });
  const done = sorted.filter((pack) => pack.status === "done").length;
  return `Перенос в Телемост: готово ${done} из ${rows.length}\n\n${rows.join("\n")}`;
}
