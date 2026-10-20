// Telegram /letterboxd → wait for Letterboxd ZIP → GitHub Actions (Worker-safe).

import {
  assertRef,
  DEFAULT_REF,
  DEFAULT_REPO,
  dispatchUrl,
  githubHeaders,
  workflowRunsUrl,
} from "./dispatch.js";

export const LETTERBOXD_WORKFLOW = "letterboxd.yml";
/** @deprecated use LETTERBOXD_WORKFLOW */
export const LETTERBOXD_GENRES_WORKFLOW = LETTERBOXD_WORKFLOW;
export const AWAIT_LETTERBOXD_PREFIX = "await:letterboxd:";
/** @deprecated use AWAIT_LETTERBOXD_PREFIX */
export const AWAIT_GENRES_PREFIX = AWAIT_LETTERBOXD_PREFIX;
export const LETTERBOXD_JOB_PREFIX = "letterboxd:job:";
/** @deprecated use LETTERBOXD_JOB_PREFIX */
export const GENRES_JOB_PREFIX = LETTERBOXD_JOB_PREFIX;

const FILE_ID_RE = /^[A-Za-z0-9_-]{10,200}$/;

export function parseLetterboxdCommand(text) {
  const trimmed = String(text || "").trim();
  const match = trimmed.match(/^\/letterboxd(?:@[A-Za-z0-9_]+)?(?:\s+([\s\S]*))?$/i);
  if (!match) return null;
  const rest = (match[1] || "").trim();
  if (rest) return { error: "usage" };
  return { ok: true };
}

/** @deprecated use parseLetterboxdCommand */
export const parseGenresCommand = parseLetterboxdCommand;

export function awaitLetterboxdKey(chatId) {
  return `${AWAIT_LETTERBOXD_PREFIX}${chatId}`;
}

/** @deprecated use awaitLetterboxdKey */
export const awaitGenresKey = awaitLetterboxdKey;

export function letterboxdJobKey(jobId) {
  return `${LETTERBOXD_JOB_PREFIX}${jobId}`;
}

/** @deprecated use letterboxdJobKey */
export const genresJobKey = letterboxdJobKey;

export const LETTERBOXD_TOP_N_DEFAULT = 20;
export const LETTERBOXD_TOP_N_MIN = 1;
export const LETTERBOXD_TOP_N_MAX = 100;
export const LETTERBOXD_MIN_RATED_DEFAULT = 3;
export const LETTERBOXD_MIN_RATED_MIN = 1;
export const LETTERBOXD_MIN_RATED_MAX = 50;

export function defaultLetterboxdOptions() {
  return {
    topN: LETTERBOXD_TOP_N_DEFAULT,
    minRated: LETTERBOXD_MIN_RATED_DEFAULT,
    includeUSA: true,
    includeEnglish: true,
    dateFrom: "",
    dateTo: "",
    includeUndated: false,
  };
}

function clampInt(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isInteger(n)) return fallback;
  if (n < min || n > max) return fallback;
  return n;
}

export function normalizeLetterboxdOptions(options) {
  const src = options && typeof options === "object" ? options : {};
  const dateFrom = /^\d{4}-\d{2}-\d{2}$/.test(String(src.dateFrom || "")) ? String(src.dateFrom) : "";
  const dateTo = /^\d{4}-\d{2}-\d{2}$/.test(String(src.dateTo || "")) ? String(src.dateTo) : "";
  const windowOk = Boolean(dateFrom && dateTo && dateTo >= dateFrom);
  return {
    topN: clampInt(src.topN, LETTERBOXD_TOP_N_MIN, LETTERBOXD_TOP_N_MAX, LETTERBOXD_TOP_N_DEFAULT),
    minRated: clampInt(src.minRated, LETTERBOXD_MIN_RATED_MIN, LETTERBOXD_MIN_RATED_MAX, LETTERBOXD_MIN_RATED_DEFAULT),
    includeUSA: src.includeUSA == null ? true : Boolean(src.includeUSA),
    includeEnglish: src.includeEnglish == null ? true : Boolean(src.includeEnglish),
    dateFrom: windowOk ? dateFrom : "",
    dateTo: windowOk ? dateTo : "",
    includeUndated: windowOk ? Boolean(src.includeUndated) : false,
  };
}

export function encodeAwaitLetterboxd(state = {}) {
  const out = {
    kind: "letterboxd",
    since: state.since || new Date().toISOString(),
    step: state.step || "zip",
  };
  if (state.fileId) out.fileId = String(state.fileId);
  if (state.topN != null) out.topN = state.topN;
  if (state.minRated != null) out.minRated = state.minRated;
  if (state.includeUSA != null) out.includeUSA = Boolean(state.includeUSA);
  if (state.includeEnglish != null) out.includeEnglish = Boolean(state.includeEnglish);
  if (state.dateFrom) out.dateFrom = String(state.dateFrom);
  if (state.dateTo) out.dateTo = String(state.dateTo);
  if (state.includeUndated != null) out.includeUndated = Boolean(state.includeUndated);
  return JSON.stringify(out);
}

/** @deprecated use encodeAwaitLetterboxd */
export const encodeAwaitGenres = encodeAwaitLetterboxd;

export function decodeAwaitLetterboxd(raw) {
  if (raw == null || raw === "") return null;
  try {
    const parsed = JSON.parse(String(raw));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    // Accept legacy "genres" kind from older workers during rollout.
    if (parsed.kind !== "letterboxd" && parsed.kind !== "genres") return null;
    return {
      kind: "letterboxd",
      since: String(parsed.since || ""),
      step: parsed.step || "zip",
      fileId: String(parsed.fileId || ""),
      topN: parsed.topN == null ? null : parsed.topN,
      minRated: parsed.minRated == null ? null : parsed.minRated,
      includeUSA: parsed.includeUSA == null ? null : Boolean(parsed.includeUSA),
      includeEnglish: parsed.includeEnglish == null ? null : Boolean(parsed.includeEnglish),
      dateFrom: String(parsed.dateFrom || ""),
      dateTo: String(parsed.dateTo || ""),
      includeUndated: parsed.includeUndated == null ? null : Boolean(parsed.includeUndated),
    };
  } catch {
    return null;
  }
}

/** @deprecated use decodeAwaitLetterboxd */
export const decodeAwaitGenres = decodeAwaitLetterboxd;

export function newLetterboxdJobId(now = () => new Date()) {
  const stamp = now().toISOString().replace(/[:.]/g, "-");
  return `lb-${stamp}`.slice(0, 80);
}

/** @deprecated use newLetterboxdJobId */
export const newGenresJobId = newLetterboxdJobId;

export function isZipDocument(document) {
  if (!document || typeof document !== "object") return false;
  const name = String(document.file_name || document.fileName || "").toLowerCase();
  const mime = String(document.mime_type || document.mimeType || "").toLowerCase();
  if (name.endsWith(".zip")) return true;
  if (mime === "application/zip" || mime === "application/x-zip-compressed") return true;
  return false;
}

export function normalizeTelegramFileId(raw) {
  const id = String(raw || "").trim();
  if (!FILE_ID_RE.test(id)) return "";
  return id;
}

export function letterboxdPromptText() {
  return (
    "Пришлите ZIP экспорта Letterboxd одним документом.\n\n" +
    "Letterboxd → Settings → Import & Export → Export Your Data.\n" +
    "В архиве нужен diary.csv; watched.csv и ratings.csv учтём в каталоге и средних оценках. Отмена — /stop."
  );
}

/** @deprecated use letterboxdPromptText */
export const genresPromptText = letterboxdPromptText;

export function letterboxdNeedZipText() {
  return "Нужен файл .zip экспорта Letterboxd (документ в чат). Отмена — /stop.";
}

/** @deprecated use letterboxdNeedZipText */
export const genresNeedZipText = letterboxdNeedZipText;

export function letterboxdInvalidZipText() {
  return "Это не ZIP Letterboxd. Пришлите файл .zip из Settings → Export. Отмена — /stop.";
}

/** @deprecated use letterboxdInvalidZipText */
export const genresInvalidZipText = letterboxdInvalidZipText;

export function letterboxdAckText(jobId, options) {
  const opts = normalizeLetterboxdOptions(options);
  const period = opts.dateFrom ? `${opts.dateFrom} — ${opts.dateTo}` : "весь";
  const undated = opts.dateFrom
    ? `\nБез даты в дневнике: ${opts.includeUndated ? "да" : "нет"}.`
    : "";
  return (
    "ZIP принят. Строю графики Letterboxd через GitHub Actions — пришлю PNG в этот чат " +
    "(календарь, доп. статистика, жанры).\n\n" +
    `Топы: ${opts.topN}. Минимум оценок: ${opts.minRated}. ` +
    `USA: ${opts.includeUSA ? "да" : "нет"}. Английский: ${opts.includeEnglish ? "да" : "нет"}. ` +
    `Период: ${period}.` +
    undated +
    `\n\nid: ${jobId}`
  );
}

/** @deprecated use letterboxdAckText */
export const genresAckText = letterboxdAckText;

export function letterboxdStartingText() {
  return "⏳ Запускаю letterboxd…";
}

/** @deprecated use letterboxdStartingText */
export const genresStartingText = letterboxdStartingText;

export function letterboxdDispatchedText({ jobId, runUrl }) {
  if (runUrl) {
    return `✅ Запуск принят.\n\n${runUrl}\n\nid: ${jobId}`;
  }
  return `✅ Запуск принят. Графики придут отдельными сообщениями.\n\nid: ${jobId}`;
}

/** @deprecated use letterboxdDispatchedText */
export const genresDispatchedText = letterboxdDispatchedText;

export function letterboxdDispatchFailText(status) {
  return `Не удалось запустить letterboxd: GitHub ответил ${status}. Проверьте GH_DISPATCH_TOKEN и workflow letterboxd.yml в main.`;
}

/** @deprecated use letterboxdDispatchFailText */
export const genresDispatchFailText = letterboxdDispatchFailText;

export function letterboxdUsageText() {
  return "Команда без аргументов: /letterboxd — затем пришлите ZIP экспорта Letterboxd.";
}

/** @deprecated use letterboxdUsageText */
export const genresUsageText = letterboxdUsageText;

export function letterboxdStopClearedHead() {
  return "Ввод прерван, ожидание Letterboxd сброшено.";
}

/** @deprecated use letterboxdStopClearedHead */
export const genresStopClearedHead = letterboxdStopClearedHead;

function normReply(text) {
  return String(text || "")
    .trim()
    .toLowerCase()
    .replace(/[.!?]+$/g, "")
    .replace(/\s+/g, " ");
}

const RU_MONTHS = {
  январь: 1,
  янв: 1,
  февраль: 2,
  фев: 2,
  март: 3,
  мар: 3,
  апрель: 4,
  апр: 4,
  май: 5,
  июнь: 6,
  июн: 6,
  июль: 7,
  июл: 7,
  август: 8,
  авг: 8,
  сентябрь: 9,
  сен: 9,
  октябрь: 10,
  окт: 10,
  ноябрь: 11,
  ноя: 11,
  декабрь: 12,
  дек: 12,
};

function isoDate(year, month, day) {
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function daysInMonth(year, month) {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function yearOk(year) {
  return year >= 1900 && year <= 2100;
}

export const LETTERBOXD_DATE_RETRY =
  "Дата не разобрана. Год: 2012. Месяц: 06-2012. День: 15-06-2012 или 15.06.2012. Два края: 2018 2020 или 2021-06.2022. Запуск не начат.";

/**
 * One typed bound → inclusive YYYY-MM-DD edge.
 * Month is always before year: MM-YYYY, MM.YYYY, «март 2012».
 * Day is day-month-year: DD-MM-YYYY or DD.MM.YYYY.
 * Year-first forms (2012-06, 2012-06-15) are rejected.
 * edge "start" is the first day of that period; "end" is the last day.
 */
export function parseWatchBound(text, edge = "start") {
  const raw = String(text || "").trim().toLowerCase().replace(/\s+/g, " ");
  const end = edge === "end";
  const emit = (year, month, day, precision) => {
    if (!yearOk(year) || month < 1 || month > 12) return "";
    if (precision === "year") return end ? isoDate(year, 12, 31) : isoDate(year, 1, 1);
    if (precision === "month") {
      return end ? isoDate(year, month, daysInMonth(year, month)) : isoDate(year, month, 1);
    }
    if (day < 1 || day > daysInMonth(year, month)) return "";
    return isoDate(year, month, day);
  };

  let match = raw.match(/^(\d{4})$/);
  if (match) return emit(Number(match[1]), 1, 1, "year");

  match = raw.match(/^(\d{2})[-.](\d{4})$/);
  if (match) return emit(Number(match[2]), Number(match[1]), 1, "month");

  match = raw.match(/^([а-яё]+)\s+(\d{4})$/);
  if (match && RU_MONTHS[match[1]]) return emit(Number(match[2]), RU_MONTHS[match[1]], 1, "month");

  match = raw.match(/^(\d{2})[-.](\d{2})[-.](\d{4})$/);
  if (match) return emit(Number(match[3]), Number(match[2]), Number(match[1]), "day");

  return "";
}

function pairWatchBounds(left, right) {
  const dateFrom = parseWatchBound(left, "start");
  const dateTo = parseWatchBound(right, "end");
  if (!dateFrom || !dateTo) return null;
  return { dateFrom, dateTo };
}

/**
 * One value is the whole interval. Two bounds are an explicit start–end.
 * A hyphen, dash, or space splits the bounds. A dot or hyphen inside one
 * bound stays part of that date (06.2022, 15-06-2022). The first split
 * where both sides are valid month-before-year bounds wins.
 * Year-before-month (2021-06, 2021.06) is not a bound.
 */
export function parseWatchInterval(text) {
  const raw = String(text || "").trim().replace(/\s+/g, " ");
  if (!raw) return null;
  if (parseWatchBound(raw, "start")) {
    return { dateFrom: parseWatchBound(raw, "start"), dateTo: parseWatchBound(raw, "end") };
  }
  for (let i = 0; i < raw.length; i += 1) {
    const ch = raw[i];
    if (ch !== "-" && ch !== "–" && ch !== "—") continue;
    const found = pairWatchBounds(raw.slice(0, i), raw.slice(i + 1));
    if (found) return found;
  }
  const bits = raw.split(" ");
  if (bits.length === 2) return pairWatchBounds(bits[0], bits[1]);
  return null;
}

export function utcDateStamp(date) {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, "0");
  const d = String(date.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

export function shiftUtcYears(date, deltaYears) {
  const year = date.getUTCFullYear() + deltaYears;
  const month = date.getUTCMonth();
  const day = date.getUTCDate();
  const dim = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return new Date(Date.UTC(year, month, Math.min(day, dim)));
}

export function presetWatchRange(years, now = new Date()) {
  return {
    dateFrom: utcDateStamp(shiftUtcYears(now, -years)),
    dateTo: utcDateStamp(now),
  };
}

function button(text, data) {
  return { text, callback_data: data };
}

function withDefaultButton(rows, label, data) {
  return { inline_keyboard: [...rows, [button(label, data)]] };
}

export function letterboxdModeKeyboard() {
  return {
    inline_keyboard: [[button("✅ По умолчанию", "lb:def"), button("Настроить", "lb:cus")]],
  };
}

export function letterboxdTopKeyboard() {
  return withDefaultButton(
    [[
      button("10", "lb:n:10"),
      button("20", "lb:n:20"),
      button("30", "lb:n:30"),
      button("50", "lb:n:50"),
    ]],
    "✅ По умолчанию (20)",
    "lb:n:20",
  );
}

export function letterboxdMinKeyboard() {
  return withDefaultButton(
    [[button("3", "lb:m:3"), button("5", "lb:m:5"), button("10", "lb:m:10")]],
    "✅ По умолчанию (3)",
    "lb:m:3",
  );
}

export function letterboxdYesNoKeyboard(prefix, fallback = "да") {
  const data = fallback === "нет" ? `${prefix}:0` : `${prefix}:1`;
  return withDefaultButton(
    [[button("Да", `${prefix}:1`), button("Нет", `${prefix}:0`)]],
    `По умолчанию: ${fallback}`,
    data,
  );
}

export function letterboxdPeriodKeyboard() {
  return withDefaultButton(
    [[button("Весь период", "lb:span"), button("Свой диапазон", "lb:rng")]],
    "По умолчанию: весь период",
    "lb:span",
  );
}

export function recentWatchYears(now = new Date(), count = 5) {
  const year = now.getUTCFullYear();
  const years = [];
  for (let i = 0; i < count; i += 1) years.push(year - i);
  return years;
}

export function letterboxdRangeKeyboard(now = new Date()) {
  const years = recentWatchYears(now, 5).map((year) => button(String(year), `lb:yr:${year}`));
  return {
    inline_keyboard: [
      years.slice(0, 3),
      years.slice(3),
      [button("Последние 3 года", "lb:y:3"), button("Последние 5 лет", "lb:y:5")],
      [button("По умолчанию: весь период", "lb:full")],
    ],
  };
}

export function letterboxdUndatedKeyboard() {
  return withDefaultButton(
    [[button("Нет", "lb:und:0"), button("Да", "lb:und:1")]],
    "По умолчанию: нет",
    "lb:und:0",
  );
}

function htmlEscape(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function wizardPrompt(heading, body, example, fallback) {
  return [`<b>${heading}</b>`, "", body, "", `Например: ${example}`, "", `По умолчанию: ${fallback}`].join("\n");
}

function choicePrompt(heading, body) {
  return [`<b>${heading}</b>`, "", body].join("\n");
}

export function letterboxdModePrompt() {
  return {
    text: [
      "<b>Как строим графики?</b>",
      "",
      "ZIP принят. «По умолчанию» сразу собирает обычный набор. «Настроить» — размер топа, страны, язык и даты.",
      "",
      "Кнопки ниже или ответ текстом. Отмена — /stop.",
    ].join("\n"),
    reply_markup: letterboxdModeKeyboard(),
  };
}

function promptFor(step, state, now = new Date()) {
  if (step === "mode") return letterboxdModePrompt();
  if (step === "top_n") {
    return {
      text: wizardPrompt(
        "Сколько позиций в топах?",
        "Сколько строк показать в каждом топе. Кнопки или своё число от 1 до 100.",
        "20, 7, 100",
        "20",
      ),
      reply_markup: letterboxdTopKeyboard(),
    };
  }
  if (step === "min_rated") {
    return {
      text: wizardPrompt(
        "Минимум оценённых фильмов",
        "Это порог для топов по средней оценке: режиссёры, актёры, жанры, страны и остальные. Строка попадает в топ, только если в ней столько фильмов с оценкой или больше. При 3 режиссёр с двумя оценёнными фильмами в топ не попадёт. Графики по числу просмотров этот порог не используют. Кнопки или число от 1 до 50.",
        "3, 5, 10",
        "3",
      ),
      reply_markup: letterboxdMinKeyboard(),
    };
  }
  if (step === "usa") {
    return {
      text: choicePrompt(
        "Показывать USA в топе стран?",
        "США часто занимают первую строку. «Нет» уберёт их из топа стран.",
      ),
      reply_markup: letterboxdYesNoKeyboard("lb:usa"),
    };
  }
  if (step === "english") {
    return {
      text: choicePrompt(
        "Показывать английский в топе языков?",
        "Английский часто на первом месте. «Нет» уберёт его из топа языков.",
      ),
      reply_markup: letterboxdYesNoKeyboard("lb:en"),
    };
  }
  if (step === "period") {
    return {
      text: choicePrompt(
        "Весь период или свой диапазон?",
        "Весь период — от первого просмотра до последнего. Свой диапазон — только выбранные даты, включительно.",
      ),
      reply_markup: letterboxdPeriodKeyboard(),
    };
  }
  if (step === "range_start") {
    return {
      text: wizardPrompt(
        "Какой период взять?",
        "Одна строка, даты включительно. Одно значение — весь этот кусок. Два края — начало и конец. Месяц пишется перед годом. Кнопки ниже — готовые отрезки.",
        "2012, 06-2012, 15-06-2012, 2021-06.2022, 15.06.2021 - 20.08.2022",
        "весь период",
      ),
      reply_markup: letterboxdRangeKeyboard(now),
    };
  }
  if (step === "range_end") {
    return {
      text: wizardPrompt(
        "Конец диапазона",
        `Начало уже ${htmlEscape(state.dateFrom)}. Конец включительно, точность может быть другой: год, месяц или день.`,
        "2012, 06-2012, 15-06-2012",
        "весь период",
      ),
      reply_markup: {
        inline_keyboard: [[button("По умолчанию: весь период", "lb:endfull")]],
      },
    };
  }
  if (step === "undated") {
    return {
      text: choicePrompt(
        "Добавить фильмы без даты в дневнике?",
        "Нет — только записи с датой внутри периода. Да — ещё фильмы из watched и ratings, у которых в дневнике даты нет. В календарные графики они не попадут.",
      ),
      reply_markup: letterboxdUndatedKeyboard(),
    };
  }
  return letterboxdModePrompt();
}

function withText(step, state, text, now = new Date()) {
  const base = promptFor(step, state, now);
  return { text, reply_markup: base.reply_markup };
}

export function parseLetterboxdCallback(data) {
  const raw = String(data || "");
  if (raw === "lb:def") return { step: "mode", choice: "defaults" };
  if (raw === "lb:cus") return { step: "mode", choice: "custom" };
  let match = raw.match(/^lb:n:(10|20|30|50)$/);
  if (match) return { step: "top_n", value: Number(match[1]) };
  match = raw.match(/^lb:m:(3|5|10)$/);
  if (match) return { step: "min_rated", value: Number(match[1]) };
  if (raw === "lb:usa:1" || raw === "lb:usa:0") return { step: "usa", value: raw.endsWith("1") };
  if (raw === "lb:en:1" || raw === "lb:en:0") return { step: "english", value: raw.endsWith("1") };
  if (raw === "lb:span") return { step: "period", choice: "full" };
  if (raw === "lb:rng") return { step: "period", choice: "custom" };
  if (raw === "lb:y:1" || raw === "lb:y:3" || raw === "lb:y:5") {
    return { step: "range_start", preset: Number(raw.slice(5)) };
  }
  match = raw.match(/^lb:yr:(19\d{2}|20\d{2})$/);
  if (match) return { step: "range_start", year: Number(match[1]) };
  if (raw === "lb:full") return { step: "range_start", choice: "full" };
  if (raw === "lb:endfull") return { step: "range_end", choice: "full" };
  if (raw === "lb:und:1" || raw === "lb:und:0") return { step: "undated", value: raw.endsWith("1") };
  return null;
}

function parseModeText(text) {
  const t = normReply(text);
  if (["по умолчанию", "умолчанию", "default", "defaults"].includes(t)) return "defaults";
  if (["настроить", "настройка", "customize"].includes(t)) return "custom";
  return "";
}

function parseYesNoText(text) {
  const t = normReply(text);
  if (["да", "yes", "y"].includes(t)) return true;
  if (["нет", "no", "n"].includes(t)) return false;
  return null;
}

function parsePeriodText(text) {
  const t = normReply(text);
  if (["весь период", "весь", "все", "полный", "full"].includes(t)) return "full";
  if (["свой диапазон", "свой", "диапазон", "custom"].includes(t)) return "custom";
  return "";
}

function parsePresetYears(text) {
  const t = normReply(text);
  if (["последний год", "за год", "last year", "1"].includes(t)) return 1;
  if (["последние 3 года", "3 года", "last 3 years", "3"].includes(t)) return 3;
  if (["последние 5 лет", "5 лет", "last 5 years", "5"].includes(t)) return 5;
  return 0;
}

function parseBounded(text, min, max) {
  const t = String(text || "").trim();
  if (!/^\d{1,3}$/.test(t)) return null;
  const n = Number(t);
  if (n < min || n > max) return null;
  return n;
}

function go(state, step, now = new Date()) {
  return { state: { ...state, step }, messages: [promptFor(step, { ...state, step }, now)] };
}

function retry(state, text, now = new Date()) {
  return { state, messages: [withText(state.step, state, text, now)] };
}

function finish(state, patch) {
  const merged = { ...state, ...patch };
  return {
    clear: true,
    dispatch: {
      fileId: merged.fileId,
      options: normalizeLetterboxdOptions(merged),
    },
    messages: [],
  };
}

/**
 * One wizard step. Returns { state, messages, clear?, dispatch?, stale? }.
 * Invalid input stays on the step and does not dispatch.
 */
export function advanceLetterboxdWizard(state, input, now = new Date()) {
  const step = state.step || "zip";
  const kind = input && input.kind;
  if (kind === "callback" && input.step !== step) {
    return { state, messages: [], stale: true };
  }
  if (step === "mode") {
    const choice = kind === "callback" ? input.choice : parseModeText(input.text);
    if (choice === "defaults") return finish(state, defaultLetterboxdOptions());
    if (choice === "custom") return go(state, "top_n", now);
    return retry(state, "Нужно «по умолчанию» или «настроить». Запуск не начат.");
  }
  if (step === "top_n") {
    const value = kind === "callback" ? input.value : parseBounded(input.text, LETTERBOXD_TOP_N_MIN, LETTERBOXD_TOP_N_MAX);
    if (value == null) return retry(state, "Нужно число от 1 до 100. Кнопки: 10, 20, 30, 50. Запуск не начат.");
    return go({ ...state, topN: value }, "min_rated", now);
  }
  if (step === "min_rated") {
    const value = kind === "callback" ? input.value : parseBounded(input.text, LETTERBOXD_MIN_RATED_MIN, LETTERBOXD_MIN_RATED_MAX);
    if (value == null) return retry(state, "Нужно число от 1 до 50. Кнопки: 3, 5, 10. Запуск не начат.");
    return go({ ...state, minRated: value }, "usa", now);
  }
  if (step === "usa") {
    const value = kind === "callback" ? input.value : parseYesNoText(input.text);
    if (value == null) return retry(state, "Нужно «да» или «нет». Запуск не начат.");
    return go({ ...state, includeUSA: value }, "english", now);
  }
  if (step === "english") {
    const value = kind === "callback" ? input.value : parseYesNoText(input.text);
    if (value == null) return retry(state, "Нужно «да» или «нет». Запуск не начат.");
    return go({ ...state, includeEnglish: value }, "period", now);
  }
  if (step === "period") {
    const choice = kind === "callback" ? input.choice : parsePeriodText(input.text);
    if (choice === "full") {
      return finish(state, { dateFrom: "", dateTo: "", includeUndated: false });
    }
    if (choice === "custom") return go(state, "range_start", now);
    return retry(state, "Нужно «весь период» или «свой диапазон». Запуск не начат.");
  }
  if (step === "range_start") {
    const full = kind === "callback" ? input.choice === "full" : parsePeriodText(input.text) === "full";
    if (full) return finish(state, { dateFrom: "", dateTo: "", includeUndated: false });
    if (kind === "callback" && input.year) {
      const year = input.year;
      return go({ ...state, dateFrom: `${year}-01-01`, dateTo: `${year}-12-31` }, "undated", now);
    }
    const preset = kind === "callback" ? input.preset : parsePresetYears(input.text);
    if (preset === 1 || preset === 3 || preset === 5) {
      const range = presetWatchRange(preset, now);
      return go({ ...state, dateFrom: range.dateFrom, dateTo: range.dateTo }, "undated", now);
    }
    if (kind === "callback") return retry(state, "Этот шаг уже не про кнопки периода. Запуск не начат.", now);
    const interval = parseWatchInterval(input.text);
    if (!interval) return retry(state, LETTERBOXD_DATE_RETRY, now);
    if (interval.dateTo < interval.dateFrom) {
      return retry(state, `Конец ${interval.dateTo} раньше начала ${interval.dateFrom}. Напишите период ещё раз.`, now);
    }
    return go({ ...state, dateFrom: interval.dateFrom, dateTo: interval.dateTo }, "undated", now);
  }
  if (step === "range_end") {
    if (kind === "callback" && input.choice === "full") {
      return finish(state, { dateFrom: "", dateTo: "", includeUndated: false });
    }
    if (kind === "callback") return retry(state, LETTERBOXD_DATE_RETRY, now);
    const interval = parseWatchInterval(input.text);
    if (!interval) return retry(state, LETTERBOXD_DATE_RETRY);
    if (interval.dateTo < interval.dateFrom) {
      return retry(state, `Конец ${interval.dateTo} раньше начала ${interval.dateFrom}. Напишите период ещё раз.`);
    }
    return go({ ...state, dateFrom: interval.dateFrom, dateTo: interval.dateTo }, "undated", now);
  }
  if (step === "undated") {
    const value = kind === "callback" ? input.value : parseYesNoText(input.text);
    if (value == null) return retry(state, "Нужно «да» или «нет». Запуск не начат.");
    return finish(state, { includeUndated: value });
  }
  return { state, messages: [] };
}

export function buildLetterboxdDispatch({ repo, workflow, ref, jobId, chatId, fileId, options }) {
  const id = String(jobId || "").trim();
  const chat = String(chatId ?? "").trim();
  const file = normalizeTelegramFileId(fileId);
  if (!id || id.length > 80) throw new Error("jobId");
  if (!chat || !/^-?[0-9]{1,16}$/.test(chat)) throw new Error("chatId");
  if (!file) throw new Error("fileId");
  const opts = normalizeLetterboxdOptions(options);
  return {
    url: dispatchUrl(repo, workflow || LETTERBOXD_WORKFLOW),
    body: {
      ref: assertRef(ref || DEFAULT_REF),
      inputs: {
        job_id: id,
        chat_id: chat,
        file_id: file,
        top_n: String(opts.topN),
        min_rated: String(opts.minRated),
        include_usa: opts.includeUSA ? "true" : "false",
        include_english: opts.includeEnglish ? "true" : "false",
        date_from: opts.dateFrom,
        date_to: opts.dateTo,
        include_undated: opts.includeUndated ? "true" : "false",
      },
    },
  };
}

/** @deprecated use buildLetterboxdDispatch */
export const buildGenresDispatch = buildLetterboxdDispatch;

export async function dispatchLetterboxdWorkflow(fetchImpl, { token, repo, workflow, ref, jobId, chatId, fileId, options }) {
  const built = buildLetterboxdDispatch({ repo, workflow, ref, jobId, chatId, fileId, options });
  const res = await fetchImpl(built.url, {
    method: "POST",
    headers: githubHeaders(token),
    body: JSON.stringify(built.body),
  });
  return { ok: res.status === 204, status: res.status };
}

/** @deprecated use dispatchLetterboxdWorkflow */
export const dispatchGenresWorkflow = dispatchLetterboxdWorkflow;

async function readJsonBody(response) {
  if (!response || typeof response.json !== "function") return {};
  try {
    return await response.json();
  } catch {
    return {};
  }
}

export async function findLetterboxdRunUrl(
  fetchImpl,
  { token, repo, workflow, startedAt, sleep, attempts = 5 },
) {
  const headers = githubHeaders(token);
  const listUrl = workflowRunsUrl(repo, workflow || LETTERBOXD_WORKFLOW);
  const since = typeof startedAt === "number" ? startedAt : Date.now();
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (sleep && attempt) await sleep(800);
    const res = await fetchImpl(listUrl, { headers });
    if (res.status !== 200) continue;
    const body = await readJsonBody(res);
    const runs = (body.workflow_runs || []).filter((run) => run && run.html_url);
    const fresh = runs.find((run) => Date.parse(run.created_at) >= since - 20_000);
    if (fresh) return fresh.html_url;
  }
  return "";
}

/** @deprecated use findLetterboxdRunUrl */
export const findGenresRunUrl = findLetterboxdRunUrl;

export { DEFAULT_REF, DEFAULT_REPO };
