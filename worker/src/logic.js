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
  "\n\nПришлите сообщение в таком виде — бот проверит название, ссылки и число стикеров." +
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

export const COMMANDS = [
  { command: "start", description: "Как пользоваться" },
  { command: "status", description: "Ход переноса" },
  { command: "format", description: "Формат запроса" },
  { command: "example", description: "Пример набора" },
  { command: "stop", description: "Отписаться" },
  { command: "login", description: "Войти в Яндекс" },
  { command: "connect", description: "Войти в аккаунт с меткой" },
  { command: "upload", description: "Загрузить паки этой сессией" },
];

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

export function normalizeProgress(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("body");
  const telemost = body.telemost && typeof body.telemost === "object" ? body.telemost : {};
  const slug = String(body.slug || "").trim();
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(slug)) throw new Error("slug");
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
  };
}

export function commandOf(text) {
  if (!text.startsWith("/")) return "";
  return text.split(/\s/)[0].split("@")[0].toLowerCase();
}

export function staticReply(cmd) {
  if (cmd === "/start" || cmd === "/help") return { subscribe: true, text: START };
  if (cmd === "/stop") return { subscribe: false, text: "Уведомления выключены. /start — включить снова." };
  if (cmd === "/format") return { text: FORMAT };
  if (cmd === "/example") return { text: "Пример:\n\n" + EXAMPLE };
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

export function statusText(packs) {
  const sorted = [...packs].sort((a, b) => String(a.slug).localeCompare(String(b.slug)));
  if (!sorted.length) return "Перенос в Телемост: паков пока нет.";
  const rows = sorted.map((pack) => {
    let line = `${STATUS_RU[pack.status] || pack.status}: «${pack.title}» — ${pack.uploaded}/${pack.total}`;
    if (pack.url) line += `\n   ${pack.url}`;
    return line;
  });
  const done = sorted.filter((pack) => pack.status === "done").length;
  return `Перенос в Телемост: готово ${done} из ${rows.length}\n\n${rows.join("\n")}`;
}
