// Pack-format replies and Telemost progress notices for @tg2tmbot.
// The final "done" note and the channel post wait until packUrl is a real link.
// A completion note that already went out without a link is followed by that link once.

export const MAX_STICKERS = 150;
export const MAX_PACK_TITLE = 100;
export const BOT_NAME = "Telegram2Telemost";
// Call sign in user replies. The Telegram display name stays BOT_NAME.
export const OPERATOR = "TG2TM";
export const CHANNEL = "https://t.me/tg2tm";
export const CHANNEL_CHAT = "@tg2tm";
export const CHANNEL_TITLE = "Стикеры TG → Телемост";
export const CHANNEL_ABOUT = "Готовые наборы стикеров, перенесённые в Телемост. Каждый пост — один набор и ссылка на него.";
export const STEPS = [25, 50, 75];

// The number in parentheses is this ratio, not the 25/50/75 milestone.
// 92/92 used to print 75% because the milestone list stops at 75.
export function progressPercent(uploaded, total) {
  const up = Number(uploaded);
  const all = Number(total);
  if (!Number.isFinite(up) || !Number.isFinite(all) || all <= 0 || up <= 0) return 0;
  if (up >= all) return 100;
  return Math.round((100 * up) / all);
}
// Existing subscriber from the polling bot. Written to KV once; /stop is not undone.
export const INITIAL_SUBSCRIBER = 8502935020;

export const EXAMPLE =
  "Минто\n" +
  "\n" +
  "https://t.me/addstickers/minty_vk\n" +
  "https://t.me/addstickers/minty2_vk";

export const FORMAT =
  "Новый набор — четыре шага.\n" +
  "\n" +
  "1. /create.\n" +
  `2. Следующее сообщение — только название, без ссылок и не длиннее ${MAX_PACK_TITLE} символов.\n` +
  "3. Дальше стикер из набора или ссылки t.me/addstickers/…. Сообщений может быть несколько, порядок любой. Один стикер добавляет весь набор. Повтор того же набора не считается.\n" +
  `4. /done ставит собранное в очередь. Сумма стикеров — не больше ${MAX_STICKERS}.\n` +
  "\n" +
  "Пример диалога:\n" +
  "\n" +
  "/create\n" +
  "Минто\n" +
  "https://t.me/addstickers/minty_vk\n" +
  "/done";

const START_BODY =
  `${OPERATOR} на связи. ${BOT_NAME} (@tg2tmbot) переносит стикеры из Telegram в Телемост.\n` +
  "\n" +
  "Новый набор: /create. Дальше спрошу название, затем приму стикеры или ссылки. В очередь — после /done. Пример и лимит — /format.\n" +
  "\n" +
  `Готовые наборы публикуются в канале ${CHANNEL}` +
  "\n\nПишу только про ваш запрос: место в очереди, ход загрузки и ссылку на готовый пак. Чужие наборы не присылаю.";

// BotFather long description. Different sentences from /start: no call sign.
// Search words for Telegram: стикеры, Telegram, Телемост, перенос. The display name is set in BotFather.
export const DESCRIPTION =
  "Стикеры Telegram — в Телемост. Перенос наборов стикеров: обычные и анимированные (TGS) становятся набором в Телемосте.\n" +
  "\n" +
  `/create, затем название (до ${MAX_PACK_TITLE} символов). ` +
  "Дальше стикеры из наборов и ссылки t.me/addstickers — в любом порядке, " +
  `вместе не больше ${MAX_STICKERS} стикеров. /done отправляет набор в очередь.\n` +
  "\n" +
  "Пример сообщений:\n" +
  "/create\n" +
  "Минто\n" +
  "стикер или https://t.me/addstickers/minty_vk\n" +
  "/done\n" +
  "\n" +
  `Канал с готовыми наборами: ${CHANNEL}`;

export const ABOUT = "Стикеры Telegram → Телемост. Перенос наборов: /create, затем /done.";

export const CREATE_PROMPT =
  "Соединяю. Как назвать пак в Телемосте?\n\n" +
  `Пришлите только название, одним сообщением, без ссылок. Не длиннее ${MAX_PACK_TITLE} символов.`;

export function createLinksPrompt(title) {
  return (
    `Название: «${title}». Приняла.\n\n` +
    "Пришлите стикер из набора или ссылки t.me/addstickers/…. Один стикер добавляет весь его набор. " +
    "Можно прислать несколько стикеров и ссылок в любом порядке — порядок наборов сохранится.\n\n" +
    `Когда соберёте, отправьте /done — запрос встанет в очередь. Всего не больше ${MAX_STICKERS} стикеров.`
  );
}

export const STICKER_NOT_IN_PACK =
  "Этот стикер не из набора — в нём нет set_name. Пришлите стикер из набора или ссылку t.me/addstickers/….";

export const CREATE_DONE_EMPTY =
  "Пока ничего не собрано. Пришлите стикер из набора или ссылки t.me/addstickers/….";

export const CREATE_HOLD_OPEN =
  "Сначала напишите «да» или «нет» про набор с видео. /done его не добавляет и в очередь ничего не ставит.";

export function holdQuestion(hold) {
  return (
    `В наборе «${hold.name}» ${hold.unsupported} стикеров — видео WEBM, их не перевести в PNG. ` +
    `Остальные ${hold.supported} можно оставить.\n` +
    "Напишите «да», чтобы добавить только их, или «нет», чтобы набор не добавлять."
  );
}

export function addedSetsReply({ addedCount, total, duplicates, rejected, missing, animatedAdded, unconvertible, deferred, hold, declined }) {
  const lines = [];
  if (addedCount > 0) {
    const converted = animatedAdded > 0 ? ` ${addedCount} стикеров, в том числе анимация, переведу в PNG.` : "";
    lines.push(
      `Добавлено ${addedCount}, всего ${total} из ${MAX_STICKERS}.${converted} Пришлите ещё стикер или ссылку — или /done, чтобы поставить в очередь.`,
    );
  }
  if (duplicates.length) {
    const listed = duplicates.map((name) => `«${name}»`).join(", ");
    lines.push(
      duplicates.length === 1
        ? `Набор ${listed} уже в этом запросе.`
        : `Наборы ${listed} уже в этом запросе.`,
    );
  }
  if (missing.length) {
    lines.push(
      missing.length === 1
        ? `Набор «${missing[0]}» не найден.`
        : `Не найдены наборы: ${missing.map((name) => `«${name}»`).join(", ")}.`,
    );
  }
  if (rejected.length) {
    const listed = rejected.map((row) => `«${row.name}» (${row.count})`).join(", ");
    const batch = rejected.reduce((sum, row) => sum + row.count, 0);
    lines.push(
      rejected.length === 1
        ? `Набор ${listed} не добавлен: вышло бы ${total + batch} стикеров, лимит ${MAX_STICKERS}.`
        : `Ничего из этого сообщения не добавлено: ${listed} вместе дали бы ${total + batch} стикеров, лимит ${MAX_STICKERS}.`,
    );
  }
  for (const row of unconvertible || []) {
    lines.push(
      `Набор «${row.name}» не добавлен: все ${row.total} стикеров — видео WEBM, в PNG их не перевести.`,
    );
  }
  for (const row of deferred || []) {
    lines.push(
      `Набор «${row.name}» пока не добавлен: в нём есть видео WEBM. Пришлите его отдельным сообщением.`,
    );
  }
  if (hold) lines.push(holdQuestion(hold));
  if (declined) lines.push(`Набор «${declined}» не добавлен.`);
  if (!addedCount && (duplicates.length || missing.length || rejected.length || declined || (unconvertible || []).length || (deferred || []).length)) {
    const next = total > 0 ? "Пришлите другой стикер или ссылку — или /done." : "Пришлите другой стикер или ссылку.";
    lines.push(`Всего ${total} из ${MAX_STICKERS}. ${next}`);
  }
  if (!lines.length) return CREATE_DONE_EMPTY;
  return lines.join("\n\n");
}

// Telegram Bot API Sticker. is_animated is a TGS file: rlottie rasterizes one frame to PNG.
// is_video is WEBM. frame_from_webm needs ffmpeg, which is not installed, so video is not converted.
// Anything else is a static WEBP (or PNG), opened by Pillow and written as PNG.
export function classifyStickers(stickers) {
  let animated = 0;
  let video = 0;
  let staticCount = 0;
  for (const sticker of Array.isArray(stickers) ? stickers : []) {
    if (sticker && sticker.is_video) video += 1;
    else if (sticker && sticker.is_animated) animated += 1;
    else staticCount += 1;
  }
  return {
    static: staticCount,
    animated,
    video,
    supported: staticCount + animated,
    unsupported: video,
  };
}

// A bare count from older callers means every sticker is static and uploadable.
export function normalizeStickerLookup(value) {
  if (typeof value === "number" && Number.isFinite(value)) {
    const count = Math.max(0, Math.floor(value));
    return { static: count, animated: 0, video: 0, supported: count, unsupported: 0 };
  }
  if (value && typeof value === "object" && Array.isArray(value.stickers)) return classifyStickers(value.stickers);
  if (!value || typeof value !== "object" || !Number.isFinite(Number(value.supported))) return null;
  const supported = Math.max(0, Math.floor(Number(value.supported)));
  const unsupported = Math.max(0, Math.floor(Number(value.unsupported) || 0));
  const animated = Math.max(0, Math.floor(Number(value.animated) || 0));
  const video = Math.max(0, Math.floor(Number(value.video ?? unsupported)));
  return {
    static: Math.max(0, supported - Math.min(animated, supported)),
    animated: Math.min(animated, supported),
    video,
    supported,
    unsupported,
  };
}

function intakeSet(row) {
  const name = String((row && row.name) || "").trim();
  if (!name) return null;
  if (row.missing) return { name, missing: true };
  const brokenOut = row.supported != null || row.unsupported != null || row.animated != null;
  const supported = Math.floor(Number(brokenOut ? row.supported : row.count));
  const unsupported = brokenOut ? Math.floor(Number(row.unsupported) || 0) : 0;
  const animated = brokenOut ? Math.floor(Number(row.animated) || 0) : 0;
  if (!Number.isFinite(supported) || supported < 0 || unsupported < 0) return { name, missing: true };
  return { name, supported, unsupported, animated, count: supported };
}

// One message is atomic for sets that convert entirely: they are all added, in order, or none are.
// A set with video WEBM and some convertible stickers is not added here. One such set becomes `hold`
// (the user answers «да» or «нет»). Several in one message are deferred, not asked about together.
// A set with nothing convertible is refused. The 150 limit counts only stickers that will be uploaded.
export function collectSets(existing, incoming) {
  const sets = [];
  for (const row of Array.isArray(existing) ? existing : []) {
    const name = String((row && row.name) || "").trim();
    const count = Math.floor(Number(row && row.count));
    if (!/^[A-Za-z0-9_]+$/.test(name) || !Number.isFinite(count) || count < 0) continue;
    if (sets.some((item) => item.name === name)) continue;
    sets.push({ name, count });
  }
  let total = sets.reduce((sum, row) => sum + row.count, 0);
  const duplicates = [];
  const missing = [];
  const fresh = [];
  const partial = [];
  const unconvertible = [];
  const seen = () => [...sets, ...fresh, ...partial, ...unconvertible];
  for (const raw of Array.isArray(incoming) ? incoming : []) {
    const row = intakeSet(raw);
    if (!row) continue;
    if (row.missing) {
      missing.push(row.name);
      continue;
    }
    if (seen().some((item) => item.name === row.name)) {
      duplicates.push(row.name);
      continue;
    }
    if (row.supported === 0) {
      unconvertible.push({ name: row.name, total: row.unsupported });
      continue;
    }
    if (row.unsupported > 0) {
      partial.push(row);
      continue;
    }
    fresh.push(row);
  }
  const batch = fresh.reduce((sum, row) => sum + row.supported, 0);
  const rejected = total + batch > MAX_STICKERS ? fresh : [];
  const added = rejected.length ? [] : fresh;
  if (!rejected.length) {
    for (const row of added) {
      sets.push({ name: row.name, count: row.supported });
      total += row.supported;
    }
  }
  const deferred = rejected.length ? partial : partial.length === 1 ? [] : partial;
  const hold = !rejected.length && partial.length === 1
    ? {
        name: partial[0].name,
        supported: partial[0].supported,
        unsupported: partial[0].unsupported,
        animated: partial[0].animated,
      }
    : null;
  return {
    sets,
    added,
    addedCount: added.reduce((sum, row) => sum + row.supported, 0),
    animatedAdded: added.reduce((sum, row) => sum + row.animated, 0),
    duplicates,
    rejected,
    missing,
    unconvertible,
    deferred,
    hold,
    total,
  };
}

// «да» adds only the convertible stickers. «нет» leaves the set out. The question does not stay open.
export function answerHold(sets, hold, yes) {
  if (!yes) {
    const total = (sets || []).reduce((sum, row) => sum + row.count, 0);
    return {
      sets: sets || [],
      added: [],
      addedCount: 0,
      animatedAdded: 0,
      duplicates: [],
      rejected: [],
      missing: [],
      unconvertible: [],
      deferred: [],
      hold: null,
      declined: hold && hold.name,
      total,
    };
  }
  const collected = collectSets(sets, [{
    name: hold.name,
    supported: hold.supported,
    unsupported: 0,
    animated: hold.animated,
    count: hold.supported,
  }]);
  return { ...collected, declined: null, hold: null };
}

// Bot API Sticker.set_name — the sticker set this sticker belongs to. Absent when it is not in a set.
export function stickerSetName(sticker) {
  if (!sticker || typeof sticker !== "object") return null;
  if (typeof sticker.set_name !== "string") return null;
  const name = sticker.set_name.trim();
  if (!/^[A-Za-z0-9_]+$/.test(name)) return null;
  return name;
}

export const NEED_CREATE =
  "Сначала /create. Спрошу название, затем стикер из набора или ссылки t.me/addstickers/…. /done ставит в очередь.\n\nПодробнее — /format.";

const STOP_CLEARED_HEAD = "Ввод прерван, незаконченный /create сброшен.";
const STOP_LETTERBOXD_CLEARED_HEAD = "Ввод прерван, ожидание Letterboxd сброшено.";
const STOP_IDLE_HEAD = "Линия свободна: сейчас нечего прерывать.";

export const AWAIT_CREATE_PREFIX = "await:";

export function awaitCreateKey(chatId) {
  return `${AWAIT_CREATE_PREFIX}${chatId}`;
}

// Telegram menu (BotFather / setMyCommands). Admin-only rows — ADMIN_ONLY_COMMANDS.
export const USER_COMMANDS = [
  { command: "start", description: "Как пользоваться" },
  { command: "create", description: "Начать новый набор" },
  { command: "format", description: "Формат и пример пака" },
  { command: "status", description: "Ваши запросы в очереди" },
  { command: "stop", description: "Прервать ввод и вернуться к командам" },
];

export const ADMIN_ONLY_COMMANDS = [
  { command: "queue", description: "Очередь и прогресс" },
  { command: "skip", description: "Пропустить текущий пак" },
  { command: "restart", description: "Перезапустить загрузку" },
  { command: "project", description: "Вопрос или задача для Cursor Cloud Agent" },
  { command: "ghrun", description: "Запустить GitHub workflow" },
  { command: "letterboxd", description: "Графики Letterboxd (доступно всем)" },
  { command: "login", description: "Войти в Яндекс" },
];

export const RETIRED_COMMAND = "Эта команда больше не доступна.";

export const ADMIN_COMMANDS = USER_COMMANDS.concat(ADMIN_ONLY_COMMANDS);

const COMMAND_LABELS = {
  start: "как пользоваться",
  create: "создать пак",
  format: "формат и пример",
  status: "ваши запросы",
  stop: "прервать ввод",
  queue: "очередь",
  skip: "пропустить пак",
  restart: "перезапустить загрузку",
  project: "задача для агента",
  ghrun: "запустить workflow",
  letterboxd: "Letterboxd",
  login: "войти в Яндекс",
};

// One line per command this chat can actually run. No retired commands, no /connect.
export function commandList(admin) {
  return (admin ? ADMIN_COMMANDS : USER_COMMANDS)
    .map((row) => `/${row.command} — ${COMMAND_LABELS[row.command]}`)
    .join("\n");
}

export function startText(admin) {
  return `${START_BODY}\n\n${commandList(admin)}`;
}

/** @param {boolean} cleared
 *  @param {boolean} admin
 *  @param {"create"|"letterboxd"|""} [kind]
 */
export function stopReply(cleared, admin, kind = "create") {
  let head = STOP_IDLE_HEAD;
  if (cleared) {
    head = kind === "letterboxd" ? STOP_LETTERBOXD_CLEARED_HEAD : STOP_CLEARED_HEAD;
  }
  return `${head}\n\n${commandList(admin)}`;
}

export const START = startText(false);
export const STOP_CLEARED = stopReply(true, false);
export const STOP_IDLE = stopReply(false, false);

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

// Russian count: 1 стикер, 2 стикера, 5 стикеров, 11 стикеров, 21 стикер.
export function stickerCountLabel(count) {
  const n = Math.floor(Number(count));
  if (!Number.isFinite(n) || n <= 0) return "";
  const abs = Math.abs(n) % 100;
  const last = abs % 10;
  let word = "стикеров";
  if (abs < 11 || abs > 14) {
    if (last === 1) word = "стикер";
    else if (last >= 2 && last <= 4) word = "стикера";
  }
  return `${n} ${word}`;
}

function channelStickerCount(pack) {
  const total = Number(pack && pack.total);
  const uploaded = Number(pack && pack.uploaded);
  if (Number.isFinite(total) && total > 0) return total;
  if (Number.isFinite(uploaded) && uploaded > 0) return uploaded;
  return 0;
}

// Public channel post. Title is escaped HTML. One # per original t.me/addstickers
// link, in the order they were collected. No sources line when those links are missing.
export function channelPost(pack) {
  const rawTitle = String((pack && pack.title) || "").replace(/\s+/g, " ").trim();
  const title = htmlEscape(rawTitle || "пак");
  const count = stickerCountLabel(channelStickerCount(pack));
  const countBit = count ? ` · ${count}` : "";
  const url = htmlEscape((pack && pack.url) || "");
  const sources = stickerSourceUrls(pack && pack.links);
  const sourceBit = sources.length
    ? ` · из тг ${sources.map((href) => `<a href="${htmlEscape(href)}">#</a>`).join(" ")}`
    : "";
  return `📞 <b>${title}</b>${countBit}\n<a href="${url}">Открыть в Телемосте</a>${sourceBit}`;
}

// Queue row wins over the progress title: that title is what the user typed.
// Source hashes come from the row's links. A catalog pack with no row keeps
// the progress title and omits sources.
export function queueItemForChannel(queue, pack) {
  if (!pack || !queue) return null;
  const bySlug = queueItemBySlug(queue, pack.slug);
  if (bySlug) return bySlug;
  if (pack.queueRequestId) return queueItemByRequestId(queue, pack.queueRequestId);
  return null;
}

export function channelPack(pack, queue) {
  const item = queueItemForChannel(queue, pack);
  const queuedTitle = item && String(item.title || "").replace(/\s+/g, " ").trim();
  const queuedLinks = item ? stickerSourceUrls(item.links) : [];
  const fallbackLinks = stickerSourceUrls(pack && pack.links);
  return {
    ...pack,
    title: queuedTitle || (pack && pack.title) || "",
    links: queuedLinks.length ? queuedLinks : fallbackLinks,
  };
}

// HTML for messages this bot built with anchors or its own <b> markup.
// Plain chat text stays plain.
export function telegramParseMode(text) {
  const value = String(text ?? "");
  if (/<a href="https?:\/\/t\.me\/addstickers\//.test(value)) return "HTML";
  if (/<a href="https?:\/\/[^"]+">Открыть в Телемосте<\/a>/.test(value)) return "HTML";
  if (/<b>[\s\S]*<\/b>/.test(value)) return "HTML";
  return undefined;
}

export function doneNotice(title, total, url, followUp) {
  const head = followUp
    ? `Ссылка на пак «${title}» в Телемосте:\n${url}`
    : `Готово: пак «${title}» принят в Телемост, ${total} стикеров.\n${url}`;
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
  const percent = progressPercent(uploaded, total);
  const url = realPackUrl(pack.url);

  if ((pack.status === "uploading" || pack.status === "done") && !state.started && total > 0) {
    state.started = true;
    steps.push({
      kind: "subscribers",
      text: `Начата загрузка пака «${title}» в Телемост: 0/${total}.`,
      state: snapshot(state),
    });
  }

  if (pack.status === "uploading") {
    const reached = STEPS.reduce((max, step) => (percent >= step ? step : max), 0);
    const announce = percent >= 100 ? 100 : reached;
    if (announce > state.step) {
      state.step = announce;
      steps.push({
        kind: "subscribers",
        text: `«${title}»: ${uploaded}/${total} (${percent} %).`,
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

function optionalCount(value) {
  if (value == null || value === "") return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0 || n > 100000) return null;
  return Math.floor(n);
}

function clockStamp(value) {
  const text = String(value || "").trim();
  return /^\d{2}:\d{2}$/.test(text) ? text : null;
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
    seconds: optionalCount(body.seconds),
    attempt: optionalCount(body.attempt),
    at: clockStamp(body.at),
    step: body.step ? String(body.step).slice(0, 80) : null,
    next: body.next ? String(body.next).slice(0, 300) : null,
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

// await:<chatId> is either {"step":"name"} or {"step":"links","title":"…","sets":[{"name","count"}]}.
// Legacy value "1" (one combined pack message) is the name step.
export function encodeAwaitCreate(state) {
  if (!state || state.step !== "links") return JSON.stringify({ step: "name" });
  const title = String(state.title || "").replace(/\s+/g, " ").trim();
  const sets = [];
  for (const row of Array.isArray(state.sets) ? state.sets : []) {
    const name = String((row && row.name) || "").trim();
    const count = Math.floor(Number(row && row.count));
    if (!/^[A-Za-z0-9_]+$/.test(name) || !Number.isFinite(count) || count < 0) continue;
    if (sets.some((item) => item.name === name)) continue;
    sets.push({ name, count });
  }
  const stored = { step: "links", title, sets };
  const hold = cleanHold(state.hold);
  if (hold) stored.hold = hold;
  return JSON.stringify(stored);
}

function cleanHold(hold) {
  if (!hold || typeof hold !== "object") return null;
  const name = String(hold.name || "").trim();
  const supported = Math.floor(Number(hold.supported));
  const unsupported = Math.floor(Number(hold.unsupported));
  const animated = Math.floor(Number(hold.animated) || 0);
  if (!/^[A-Za-z0-9_]+$/.test(name) || !(supported > 0) || !(unsupported > 0)) return null;
  return { name, supported, unsupported, animated };
}

export function decodeAwaitCreate(raw) {
  if (raw == null || raw === "") return null;
  const text = String(raw);
  if (text === "1") return { step: "name" };
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  if (parsed.step === "name") return { step: "name" };
  if (parsed.step === "links") {
    const title = String(parsed.title || "").replace(/\s+/g, " ").trim();
    if (!title || title.length > MAX_PACK_TITLE) return { step: "name" };
    const sets = [];
    for (const row of Array.isArray(parsed.sets) ? parsed.sets : []) {
      const name = String((row && row.name) || "").trim();
      const count = Math.floor(Number(row && row.count));
      if (!/^[A-Za-z0-9_]+$/.test(name) || !Number.isFinite(count) || count < 0) continue;
      if (sets.some((item) => item.name === name)) continue;
      sets.push({ name, count });
    }
    const decoded = { step: "links", title, sets };
    const hold = cleanHold(parsed.hold);
    if (hold) decoded.hold = hold;
    return decoded;
  }
  return null;
}

export function nameStepResult(text) {
  const raw = String(text ?? "");
  if (/(?:https?:\/\/)?t\.me\/addstickers\/[A-Za-z0-9_]+/i.test(raw) || /https?:\/\//i.test(raw)) {
    return {
      ok: false,
      reason: "links",
      text:
        "На этом шаге нужно только название пака, без ссылок.\n\n" +
        "Пришлите название одним сообщением. Стикер или ссылки — следующим шагом.",
    };
  }
  const title = raw.replace(/\s+/g, " ").trim();
  if (!title) return { ok: false, reason: "empty", text: CREATE_PROMPT };
  if (title.length > MAX_PACK_TITLE) {
    return {
      ok: false,
      reason: "long",
      text:
        `Название — ${title.length} ${ruChars(title.length)}, лимит ${MAX_PACK_TITLE}.\n\n` +
        "Пришлите название ещё раз, без ссылок.",
    };
  }
  return { ok: true, title };
}

function ruChars(n) {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return "символ";
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return "символа";
  return "символов";
}

export function parseStickerSetNames(text) {
  const names = [];
  const re = /(?:https?:\/\/)?t\.me\/addstickers\/([A-Za-z0-9_]+)/gi;
  for (const match of String(text || "").matchAll(re)) {
    if (!names.includes(match[1])) names.push(match[1]);
  }
  return names;
}

function linksAgain(title, problem) {
  return (
    `${problem}\n\n` +
    `Пришлите ссылки t.me/addstickers/… ещё раз — одну или несколько. Название «${title}» сохранено.`
  );
}

// names are the sets in the message; lookups are { name, count } or { name, missing: true }.
export function judgeCreateLinks(title, names, lookups) {
  const list = Array.isArray(names) ? names : [];
  const found = new Map();
  for (const row of Array.isArray(lookups) ? lookups : []) {
    if (row && row.name) found.set(row.name, row);
  }
  if (!list.length) {
    return {
      ok: false,
      reason: "no-links",
      missing: [],
      total: 0,
      rows: [],
      text: linksAgain(title, "В сообщении нет ссылок t.me/addstickers/…."),
    };
  }
  const rows = [];
  const missing = [];
  let total = 0;
  for (const name of list) {
    const row = found.get(name);
    const count = row && Number.isFinite(Number(row.count)) ? Math.floor(Number(row.count)) : NaN;
    if (!row || row.missing || !Number.isFinite(count) || count < 0) {
      missing.push(name);
      rows.push(`• ${name} — набор не найден`);
    } else {
      total += count;
      rows.push(`• ${name} — ${count}`);
    }
  }
  if (missing.length) {
    const which =
      missing.length === 1
        ? `Набор «${missing[0]}» не найден.`
        : `Не найдены наборы: ${missing.map((name) => `«${name}»`).join(", ")}.`;
    return {
      ok: false,
      reason: "missing",
      missing,
      total,
      rows,
      text: linksAgain(title, `${which}\n\n${rows.join("\n")}`),
    };
  }
  if (total <= 0) {
    return {
      ok: false,
      reason: "empty",
      missing: [],
      total,
      rows,
      text: linksAgain(title, `Всего ${total} стикеров — нужен набор, в котором есть стикеры.\n\n${rows.join("\n")}`),
    };
  }
  if (total > MAX_STICKERS) {
    return {
      ok: false,
      reason: "over",
      missing: [],
      total,
      rows,
      text: linksAgain(
        title,
        `Всего ${total} стикеров — больше лимита ${MAX_STICKERS} (всего ${total} > ${MAX_STICKERS}).\n\n${rows.join("\n")}`,
      ),
    };
  }
  return { ok: true, reason: null, missing: [], total, rows, text: null };
}

export const QUEUE_KEY = "queue";

export function emptyQueue() {
  return { priority: [], items: [] };
}

function sameLinks(left, right) {
  return left.length === right.length && left.every((link, index) => link === right[index]);
}

// Sticker-set names, unique and ordered, so https and bare t.me forms match.
export function linkSetNames(links) {
  const names = [];
  const re = /(?:https?:\/\/)?t\.me\/addstickers\/([A-Za-z0-9_]+)/gi;
  for (const link of Array.isArray(links) ? links : []) {
    const text = String(link || "");
    let found = false;
    for (const match of text.matchAll(re)) {
      found = true;
      if (!names.includes(match[1])) names.push(match[1]);
    }
    if (!found) {
      const plain = text.trim();
      if (plain && !names.includes(plain)) names.push(plain);
    }
  }
  names.sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
  return names;
}

function sameLinkSet(left, right) {
  const a = linkSetNames(left);
  const b = linkSetNames(right);
  return a.length > 0 && a.length === b.length && a.every((name, index) => name === b[index]);
}

function sameTitle(left, right) {
  return String(left || "").replace(/\s+/g, " ").trim() === String(right || "").replace(/\s+/g, " ").trim();
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
    if (item.error) row.error = String(item.error).slice(0, 300);
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

// A finished request blocks a new one only when the trimmed title and the link set both match.
function duplicateDoneRequest(queue, request) {
  return queue.items.find(
    (item) =>
      item.status === "done" &&
      sameTitle(item.title, request.title) &&
      sameLinkSet(item.links, request.links),
  );
}

export function finishedDuplicateText(title, links) {
  const names = linkSetNames(links);
  const listed = names.length ? names.map((name) => `t.me/addstickers/${name}`).join("\n") : "те же ссылки";
  const shown = String(title || "").replace(/\s+/g, " ").trim();
  return (
    `Уже переносился набор «${shown}» с этими же ссылками:\n` +
    `${listed}\n\n` +
    `Совпадают и название, и ссылки. Повторно не передаю.`
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

export function duplicateRequestReply({ title, duplicate, priority, links }) {
  if (duplicate === "done") return finishedDuplicateText(title, links);
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

// A finished pack is not a skip target. Live sticker progress is.
export function currentPackAlreadyDone(pack) {
  return Boolean(pack && pack.status === "done" && pack.url);
}

export const SKIP_REASON = "пропущено: /skip остановил загрузку";

// Admin /skip: drop the current uploading row and advance the queue.
export function skipUploadingQueue(queue, reason, { ids } = {}) {
  const allow = ids ? new Set(ids.map((id) => String(id))) : null;
  const stuck = (queue.items || []).filter((item) => item.status === "uploading" && (!allow || allow.has(String(item.id))));
  if (!stuck.length) return { queue, changed: false, reason: "none", skipped: [] };
  const error = String(reason || "пропущено").slice(0, 300);
  let changed = false;
  const skipped = [];
  const items = queue.items.map((item) => {
    if (item.status !== "uploading") return item;
    if (allow && !allow.has(String(item.id))) return item;
    changed = true;
    const next = { ...item, status: "error", error };
    skipped.push(next);
    return next;
  });
  return {
    queue: changed ? { priority: queue.priority.slice(), items } : queue,
    changed,
    reason: "skipped",
    skipped,
  };
}

export function skipReply({ reason, skipped }) {
  if (reason === "done") {
    const titles = (skipped || []).map((item) => `«${item.title}»`).join(", ") || "пак";
    return `Пак ${titles} уже готов — /skip его не снимает.`;
  }
  if (reason === "none" || !skipped || !skipped.length) {
    return "Нет текущего пака — /skip не к чему применить.";
  }
  const titles = skipped.map((item) => `«${item.title}»`).join(", ");
  const why = skipped.map((item) => item.error).find((text) => text && text !== "пропущено") || "ошибка в очереди";
  return `Пропустил ${titles}: ${why}. Запускаю следующий пак, если очередь не пуста.`;
}

export function unstickReply({ reason, released, finished, actionsRunning, cleanedWhileRunning = false }) {
  if (actionsRunning) {
    if (cleanedWhileRunning && (finished || []).length) {
      const titles = finished.map((item) => `«${item.title}»`).join(", ");
      return `Сейчас идёт Actions — строку «загружается» не снимаю. Закрыл в очереди как готовый: ${titles} (прогресс в KV уже был завершён).`;
    }
    return "Сейчас идёт запуск Actions — строку «загружается» не трогаю.";
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

// Drop GitHub and Actions run links. Sticker counts and pack titles stay.
export function stripGithubPointers(text) {
  const raw = String(text ?? "");
  const without = raw
    .replace(/<a\b[^>]*href=["']https?:\/\/(?:www\.)?github\.com[^"']*["'][^>]*>[\s\S]*?<\/a>/gi, "")
    .replace(/(?:https?:\/\/)?(?:www\.)?github\.com\/[^\s<>"')\]]+/gi, "")
    .replace(/\bactions\/runs\/\d+\b/gi, "");
  const lines = without.split("\n").flatMap((line) => {
    const cleaned = line.replace(/\s+\|\s*$/g, "").replace(/\s+—\s*$/g, "").replace(/[ \t]{2,}/g, " ").trim();
    if (!cleaned && line.trim()) return [];
    return [line.trim() ? cleaned : ""];
  });
  return lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

export function htmlEscape(text) {
  return String(text ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// One https URL per supplied link, in the user's order. Non-links are skipped.
export function stickerSourceUrls(links) {
  const urls = [];
  const re = /(?:https?:\/\/)?t\.me\/addstickers\/([A-Za-z0-9_]+)/i;
  for (const link of Array.isArray(links) ? links : []) {
    const match = String(link || "").match(re);
    if (!match) continue;
    urls.push(`https://t.me/addstickers/${match[1]}`);
  }
  return urls;
}

// User-entered title plus one clickable # per source pack. HTML for Telegram.
export function requestSourceLine(item, { index } = {}) {
  const rawTitle = String((item && item.title) || "").replace(/\s+/g, " ").trim();
  const title = htmlEscape(rawTitle || "пак");
  const hashes = stickerSourceUrls(item && item.links).map(
    (url) => `<a href="${htmlEscape(url)}">#</a>`,
  );
  const prefix = index ? `${index}. ` : "";
  const head = `${prefix}«${title}»`;
  const linked = hashes.length ? `${head} ${hashes.join(" ")}` : head;
  const stickers = Number(item && item.stickers);
  return Number.isFinite(stickers) && stickers > 0 ? `${linked} — ${stickers}` : linked;
}

export function queueStatusText(queue, chatId) {
  const mine = queue.items.filter((item) => item.chatId === String(chatId));
  if (!mine.length) return null;
  const lines = mine.map((item) => {
    const label = requestSourceLine(item);
    const priority = item.priority ? " с приоритетом" : "";
    if (item.status === "uploading") return `${label}${priority}: загружается`;
    if (item.status === "done") return `${label}${priority}: готов`;
    if (item.status === "error") return `${label}${priority}: ошибка, можно прислать набор ещё раз`;
    const ahead = aheadCount(queue, item);
    return `${label}${priority}: в очереди, перед ним ${ahead}`;
  });
  return `Ваши запросы:\n\n${lines.join("\n")}`;
}

export function alreadyQueuedReply({ title, priority }) {
  const head = priority
    ? `Запрос «${title}» уже в очереди с приоритетом. Повторно не передаю.`
    : `Запрос «${title}» уже в очереди. Повторно не передаю.`;
  return head;
}

export function acceptReply({ title, links, rows, total, priority, ahead }) {
  const head = priority
    ? `Передаю в очередь с приоритетом «${htmlEscape(title)}»: сразу после набора, который уже загружается.`
    : `Передаю в очередь «${htmlEscape(title)}».`;
  const position =
    typeof ahead === "number"
      ? ahead === 0
        ? "\n\nСейчас перед вами никого."
        : `\n\nПеред вами в очереди: ${ahead}.`
      : "";
  const sources = Array.isArray(links) && links.length
    ? requestSourceLine({ title, links, stickers: total })
    : (rows || []).map((row) => htmlEscape(row)).join("\n");
  return `${head}${position}\n\n${sources}\n\nВсего ${total} стикеров.`;
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
    let line = `Сейчас загружается: ${requestSourceLine(uploading)}`;
    if (uploading.chatId) line += ` (chat ${htmlEscape(uploading.chatId)})`;
    if (activePack && Number.isFinite(activePack.uploaded) && Number.isFinite(activePack.total)) {
      line += ` — стикер ${activePack.uploaded} из ${activePack.total}`;
    }
    lines.push(line);
  } else {
    lines.push("Сейчас никто не загружается.");
  }
  const waiting = sortQueuedItems(items);
  lines.push("");
  if (!waiting.length) {
    lines.push("В очереди: пусто.");
  } else {
    lines.push("В очереди:");
    waiting.forEach((item, index) => {
      const pri = item.priority ? ", приоритет" : "";
      const who = item.chatId ? `, chat ${htmlEscape(item.chatId)}` : "";
      lines.push(`${requestSourceLine(item, { index: index + 1 })}${pri}${who}`);
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
      lines.push(`• ${mark}: ${requestSourceLine(item)}`);
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
  const title = (item && item.title) || (pack && pack.title) || "";
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
    const url = stripGithubPointers(event.url);
    const done = `Готово: «${title}».`;
    if (!url || /github\.com/i.test(event.url)) return done;
    return `${done}\n${url}`;
  }
  if (event.phase === "error") {
    const index = Number(event.index) || 0;
    const total = Number(event.total) || 0;
    const where = total ? ` на ${index}/${total}` : "";
    const detail = stripGithubPointers(event.error || "") || "загрузка остановлена";
    return `«${title}»: ошибка${where}: ${detail}.`;
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

// User progress is delivered only when requesterChatId is the chat that owns
// queueRequestId and the slug is that row. A missing id, a mismatch, or a slug
// from another pack is not a recipient — never a subscriber list or a previous row.
export function resolveRequesterChatId(pack, item) {
  const explicit = pack && pack.requesterChatId != null ? String(pack.requesterChatId).trim() : "";
  const requestId = pack && pack.queueRequestId ? String(pack.queueRequestId).trim() : "";
  if (!item || !requestId || String(item.id) !== requestId) return null;
  if (!/^[0-9]{1,16}$/.test(explicit) || String(item.chatId) !== explicit) return null;
  if (!pack.slug || pack.slug !== queueItemSlug(item)) return null;
  return explicit;
}

export function matchedProgressRequester(pack, queue) {
  const requestId = pack && pack.queueRequestId ? String(pack.queueRequestId).trim() : "";
  if (!requestId) return null;
  const item = queueItemByRequestId(queue, requestId);
  const chatId = resolveRequesterChatId(pack, item);
  if (!chatId) return null;
  return { item, chatId };
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
