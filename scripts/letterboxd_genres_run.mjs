// GitHub Actions: download Letterboxd ZIP, rich HTML report + photos, then TMDB genres.
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

const GENRE_PNGS = [
  "genre_counts_by_viewing_year.png",
  "average_rating_by_genre.png",
  "genre_by_release_decade.png",
  "genre_share_by_viewing_year.png",
  "watches_by_country.png",
];

const CALENDAR_PNGS = [
  "views_by_weekday_month.png",
  "views_by_year.png",
  "extra_stats_decade_rating.png",
  "average_rating_by_year.png",
  "average_rating_by_release_decade.png",
  "top_rewatches.png",
];

const CALENDAR_CAPTIONS = {
  "views_by_weekday_month.png": "Дни недели и месяцы — стек по годам просмотра",
  "views_by_year.png": "Просмотры по годам",
  "extra_stats_decade_rating.png": "Десятилетия выхода и оценки",
  "average_rating_by_year.png": "Средняя оценка по годам просмотра",
  "average_rating_by_release_decade.png": "Средняя оценка по десятилетию выхода",
  "top_rewatches.png": "Чаще всего в дневнике",
};

const GENRE_CAPTIONS = {
  "genre_counts_by_viewing_year.png": "Жанры по годам просмотра",
  "average_rating_by_genre.png": "Средняя оценка по жанрам",
  "genre_by_release_decade.png": "Жанры по десятилетию выхода",
  "genre_share_by_viewing_year.png": "Доля жанров по годам",
  "watches_by_country.png": "Страны производства (TMDB)",
};

const __dirname = dirname(fileURLToPath(import.meta.url));
const GENRE_SCRIPT = join(__dirname, "letterboxd_genre_charts.py");
const CALENDAR_SCRIPT = join(__dirname, "letterboxd_calendar_charts.py");

function env(name) {
  return String(process.env[name] || "").trim();
}

function telegramApi(token, method) {
  return `https://api.telegram.org/bot${token}/${method}`;
}

/** Escape user/diary strings for Telegram HTML parse_mode. */
export function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

export function readJsonFile(path) {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

function fmtPct(share) {
  const n = Number(share);
  if (!Number.isFinite(n)) return "—";
  return `${Math.round(n * 100)}%`;
}

function fmtNum(n) {
  if (n == null || !Number.isFinite(Number(n))) return "—";
  return String(Number(n));
}

function fmtRating(n) {
  if (n == null || !Number.isFinite(Number(n))) return "—";
  const v = Number(n);
  return Number.isInteger(v) ? String(v) : v.toFixed(2).replace(/\.?0+$/, "") || String(v);
}

/**
 * Calendar-section HTML report (parse_mode=HTML). Prefer HTML over MarkdownV2:
 * film titles only need &lt; &gt; &amp; escapes.
 */
export function buildCalendarReportHtml(summary) {
  const s = summary && typeof summary === "object" ? summary : {};
  const entries = fmtNum(s.entries);
  const films = fmtNum(s.unique_films);
  let years = "—";
  if (s.year_min != null && s.year_max != null) {
    years = s.year_min === s.year_max ? String(s.year_min) : `${s.year_min}–${s.year_max}`;
  }
  const lines = [
    "<b>Letterboxd</b>",
    `Дневник: <b>${escapeHtml(entries)}</b> записей · <b>${escapeHtml(films)}</b> фильмов · ${escapeHtml(years)}`,
  ];

  if (s.peak_year != null) {
    lines.push(
      `Пик: <b>${escapeHtml(s.peak_year)}</b> — <b>${escapeHtml(fmtNum(s.peak_year_count))}</b> просмотров`,
    );
  }
  if (s.favorite_weekday) {
    lines.push(
      `День: <b>${escapeHtml(s.favorite_weekday)}</b> (${escapeHtml(fmtNum(s.favorite_weekday_count))})`,
    );
  }
  if (s.favorite_month) {
    lines.push(
      `Месяц: <b>${escapeHtml(s.favorite_month)}</b> (${escapeHtml(fmtNum(s.favorite_month_count))})`,
    );
  }

  const ratedShare = fmtPct(s.rated_share);
  if (s.rated_count != null) {
    let ratingLine = `Оценки: <b>${escapeHtml(fmtNum(s.rated_count))}</b> (${escapeHtml(ratedShare)})`;
    if (s.rating_avg != null) {
      ratingLine += ` · средняя <b>${escapeHtml(fmtRating(s.rating_avg))}</b>`;
    }
    if (s.rating_mode != null) {
      ratingLine += ` · чаще <b>${escapeHtml(fmtRating(s.rating_mode))}</b>`;
    }
    lines.push(ratingLine);
  }

  const rewatches = Array.isArray(s.top_rewatches) ? s.top_rewatches.slice(0, 3) : [];
  if (rewatches.length) {
    lines.push("<b>Повторы</b>");
    for (const row of rewatches) {
      const title = escapeHtml(row.name || "?");
      const year = row.year != null ? ` (${escapeHtml(row.year)})` : "";
      lines.push(`• ${title}${year} — <b>${escapeHtml(fmtNum(row.count))}</b>`);
    }
  }

  const watchedYears = Array.isArray(s.top_release_years_by_count)
    ? s.top_release_years_by_count.slice(0, 10)
    : [];
  if (watchedYears.length) {
    lines.push("<b>Годы выхода — больше просмотров</b>");
    for (const row of watchedYears) {
      lines.push(
        `• <b>${escapeHtml(row.year)}</b> — <b>${escapeHtml(fmtNum(row.count))}</b>`,
      );
    }
  }

  const ratedYears = Array.isArray(s.top_rated_release_years)
    ? s.top_rated_release_years.slice(0, 10)
    : [];
  if (ratedYears.length) {
    lines.push("<b>Годы выхода — выше оценка</b> <i>(больше 3 оценок)</i>");
    for (const row of ratedYears) {
      lines.push(
        `• <b>${escapeHtml(row.year)}</b> — ср. <b>${escapeHtml(fmtRating(row.avg))}</b> (n=${escapeHtml(fmtNum(row.rated))})`,
      );
    }
  }

  return lines.join("\n");
}

const LANG_LABELS = {
  en: "английский",
  ru: "русский",
  fr: "французский",
  de: "немецкий",
  it: "итальянский",
  es: "испанский",
  ja: "японский",
  ko: "корейский",
  zh: "китайский",
  sv: "шведский",
  pl: "польский",
  pt: "португальский",
  hi: "хинди",
  tr: "турецкий",
  uk: "украинский",
  da: "датский",
  no: "норвежский",
  nl: "нидерландский",
  cs: "чешский",
  hu: "венгерский",
};

function displayLang(code) {
  const key = String(code || "")
    .trim()
    .toLowerCase();
  return LANG_LABELS[key] || key || "?";
}

function formatNamedRankLine(row, { language = false, byRating = false } = {}) {
  const raw = row.name || "?";
  const name = escapeHtml(language ? displayLang(raw) : raw);
  if (byRating) {
    const avg = escapeHtml(fmtRating(row.avg));
    const rated = escapeHtml(fmtNum(row.rated != null ? row.rated : row.count));
    return `• <b>${name}</b> — ср. <b>${avg}</b> (n=${rated})`;
  }
  const count = escapeHtml(fmtNum(row.count));
  const pct =
    row.pct != null && Number.isFinite(Number(row.pct)) ? ` · ${escapeHtml(String(row.pct))}%` : "";
  return `• <b>${name}</b> — ${count}${pct}`;
}

function appendPairedTops(lines, title, countRows, ratingRows, opts = {}) {
  const countList = Array.isArray(countRows) ? countRows : [];
  const ratingList = Array.isArray(ratingRows) ? ratingRows : [];
  if (countList.length) {
    const hint = opts.countHint ? ` <i>${escapeHtml(opts.countHint)}</i>` : "";
    lines.push(`<b>${title}</b>${hint}`);
    for (const row of countList) {
      lines.push(formatNamedRankLine(row, { language: !!opts.language, byRating: false }));
    }
  }
  if (ratingList.length) {
    lines.push(`<b>${title} — выше оценка</b> <i>(больше 3 оценок)</i>`);
    for (const row of ratingList) {
      lines.push(formatNamedRankLine(row, { language: !!opts.language, byRating: true }));
    }
  }
}

/**
 * TMDB genre + people/country HTML after enrichment.
 * Returns one or two messages to stay under Telegram's ~4096 limit.
 */
export function buildGenreReportMessages(summary, unmatchedFallback = 0) {
  const s = summary && typeof summary === "object" ? summary : {};
  const unmatched =
    s.unmatched != null && Number.isFinite(Number(s.unmatched))
      ? Number(s.unmatched)
      : Number(unmatchedFallback) || 0;

  const genreLines = [];
  appendPairedTops(
    genreLines,
    "Жанры (TMDB)",
    Array.isArray(s.top_genres) ? s.top_genres.slice(0, 6) : [],
    Array.isArray(s.top_genres_by_rating) ? s.top_genres_by_rating.slice(0, 6) : [],
  );
  if (!genreLines.length) {
    genreLines.push("<b>Жанры (TMDB)</b>", "Топ жанров пуст.");
  }
  if (unmatched > 0) {
    genreLines.push(`Без жанров TMDB: <b>${escapeHtml(String(unmatched))}</b>`);
  }

  const deepLines = [];
  const min = s.min_person_count != null ? fmtNum(s.min_person_count) : "3";
  appendPairedTops(
    deepLines,
    "Страны",
    Array.isArray(s.countries) ? s.countries.slice(0, 8) : [],
    Array.isArray(s.countries_by_rating) ? s.countries_by_rating.slice(0, 8) : [],
  );
  appendPairedTops(
    deepLines,
    "Режиссёры",
    Array.isArray(s.directors) ? s.directors.slice(0, 6) : [],
    Array.isArray(s.directors_by_rating) ? s.directors_by_rating.slice(0, 6) : [],
    { countHint: `(от ${min} просмотров)` },
  );
  appendPairedTops(
    deepLines,
    "Актёры",
    Array.isArray(s.actors) ? s.actors.slice(0, 6) : [],
    Array.isArray(s.actors_by_rating) ? s.actors_by_rating.slice(0, 6) : [],
    { countHint: `(от ${min} просмотров)` },
  );
  appendPairedTops(
    deepLines,
    "Язык оригинала",
    Array.isArray(s.languages) ? s.languages.slice(0, 6) : [],
    Array.isArray(s.languages_by_rating) ? s.languages_by_rating.slice(0, 6) : [],
    { language: true },
  );
  appendPairedTops(
    deepLines,
    "Студии",
    Array.isArray(s.companies) ? s.companies.slice(0, 5) : [],
    Array.isArray(s.companies_by_rating) ? s.companies_by_rating.slice(0, 5) : [],
  );

  const messages = [genreLines.join("\n")];
  if (deepLines.length) messages.push(deepLines.join("\n"));
  return messages;
}

/** Genre-section HTML after TMDB enrichment (single string; tests / simple callers). */
export function buildGenreReportHtml(summary, unmatchedFallback = 0) {
  return buildGenreReportMessages(summary, unmatchedFallback).join("\n\n");
}

export function mapScriptError(stderr, stdout, status) {
  const text = `${stderr || ""}\n${stdout || ""}`;
  if (/TMDB_BEARER_TOKEN/i.test(text)) {
    return "Не задан TMDB_BEARER_TOKEN (Read Access Token). Нужен секрет GitHub Actions TMDB_BEARER_TOKEN.";
  }
  if (/diary\.csv/i.test(text)) {
    return "В ZIP нет diary.csv. Экспорт: Letterboxd → Settings → Import & Export → Export Your Data.";
  }
  if (/Watched Date/i.test(text) && /нет колонки|не содержит/i.test(text)) {
    return "diary.csv без колонки Watched Date. Пришлите полный экспорт Letterboxd.";
  }
  if (/не хватает колонок/i.test(text)) {
    return "diary.csv без нужных колонок (Name, Year, Watched Date). Пришлите полный экспорт Letterboxd.";
  }
  if (/BadZipFile|не похож на ZIP/i.test(text)) {
    return "Файл не похож на ZIP Letterboxd.";
  }
  if (/401|unauthorized|invalid api/i.test(text)) {
    return "TMDB отклонил токен. Проверьте TMDB_BEARER_TOKEN (не печатайте его в чат).";
  }
  if (status !== 0) {
    const line = text
      .split(/\r?\n/)
      .map((row) => row.trim())
      .filter(Boolean)
      .slice(-3)
      .join(" ");
    return line
      ? `Не удалось построить графики: ${line.slice(0, 350)}`
      : "Не удалось построить графики Letterboxd.";
  }
  return "";
}

export function unmatchedFromWorkdir(workdir, stdout = "") {
  const csvPath = join(workdir, "tmdb_unmatched.csv");
  if (existsSync(csvPath)) {
    const lines = readFileSync(csvPath, "utf8")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    if (lines.length > 1) return lines.length - 1;
  }
  const match = String(stdout || "").match(/без найденных жанров:\s*(\d+)/i);
  if (match) return Number(match[1]);
  return 0;
}

export function existingPngs(workdir, names) {
  return names.filter((name) => {
    const path = join(workdir, name);
    return existsSync(path) && readFileSync(path).byteLength > 32;
  });
}

export function calendarReadyText() {
  return "Календарные графики готовы, сейчас подробности из TMDB (жанры, страны, режиссёры, актёры)…";
}

async function sendTelegramText(token, chatId, text, parseMode = "") {
  const payload = {
    chat_id: chatId,
    text,
    link_preview_options: { is_disabled: true },
  };
  if (parseMode) payload.parse_mode = parseMode;
  const res = await fetch(telegramApi(token, "sendMessage"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) console.error("sendMessage", res.status, parseMode || "plain");
  return res.ok;
}

async function sendTelegramHtml(token, chatId, html) {
  return sendTelegramText(token, chatId, html, "HTML");
}

async function sendTelegramPhoto(token, chatId, filePath, filename, caption = "") {
  const bytes = readFileSync(filePath);
  const form = new FormData();
  form.set("chat_id", String(chatId));
  if (caption) {
    form.set("caption", caption);
    form.set("parse_mode", "HTML");
  }
  form.set("photo", new Blob([bytes], { type: "image/png" }), filename);
  const res = await fetch(telegramApi(token, "sendPhoto"), {
    method: "POST",
    body: form,
  });
  if (!res.ok) {
    console.error("sendPhoto", filename, res.status);
    // Fallback: document keeps full resolution if photo reject (size/dimensions).
    return sendTelegramDocument(token, chatId, filePath, filename, caption);
  }
  return true;
}

async function sendTelegramDocument(token, chatId, filePath, filename, caption = "") {
  const bytes = readFileSync(filePath);
  const form = new FormData();
  form.set("chat_id", String(chatId));
  if (caption) {
    form.set("caption", caption);
    form.set("parse_mode", "HTML");
  }
  form.set("document", new Blob([bytes], { type: "image/png" }), filename);
  const res = await fetch(telegramApi(token, "sendDocument"), {
    method: "POST",
    body: form,
  });
  if (!res.ok) console.error("sendDocument", filename, res.status);
  return res.ok;
}

async function sendCaptionedPhotos(token, chatId, workdir, names, captions) {
  let sent = 0;
  for (const name of names) {
    const caption = captions[name] ? `<i>${escapeHtml(captions[name])}</i>` : "";
    const ok = await sendTelegramPhoto(token, chatId, join(workdir, name), name, caption);
    if (!ok) {
      await sendTelegramText(token, chatId, `Не удалось отправить ${name}.`);
    } else {
      sent += 1;
    }
  }
  return sent;
}

async function downloadTelegramFile(token, fileId, destPath) {
  const metaRes = await fetch(telegramApi(token, "getFile"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ file_id: fileId }),
  });
  if (!metaRes.ok) throw new Error(`getFile http ${metaRes.status}`);
  const meta = await metaRes.json();
  if (!meta.ok || !meta.result || !meta.result.file_path) {
    throw new Error("getFile missing path");
  }
  const filePath = String(meta.result.file_path);
  const fileRes = await fetch(`https://api.telegram.org/file/bot${token}/${filePath}`);
  if (!fileRes.ok) throw new Error(`file download http ${fileRes.status}`);
  const buf = Buffer.from(await fileRes.arrayBuffer());
  writeFileSync(destPath, buf);
  return destPath;
}

function runPython(script, zipPath, workdir) {
  const result = spawnSync("python3", [script, zipPath], {
    cwd: workdir,
    encoding: "utf8",
    env: {
      ...process.env,
      MPLBACKEND: "Agg",
    },
    timeout: 1000 * 60 * 45,
    maxBuffer: 8 * 1024 * 1024,
  });
  return {
    status: result.status ?? 1,
    stdout: result.stdout || "",
    stderr: result.stderr || "",
    error: result.error,
  };
}

export async function main() {
  const token = env("TG2TMBOT_TOKEN") || env("TELEGRAM_BOT_TOKEN");
  const chatId = env("CHAT_ID") || env("INPUT_CHAT_ID");
  const fileId = env("FILE_ID") || env("INPUT_FILE_ID");
  const jobId = env("JOB_ID") || env("INPUT_JOB_ID") || "lb";
  const bearer = env("TMDB_BEARER_TOKEN");

  if (!token) throw new Error("TG2TMBOT_TOKEN missing");
  if (!chatId) throw new Error("CHAT_ID missing");
  if (!fileId) throw new Error("FILE_ID missing");
  if (!bearer) {
    await sendTelegramText(
      token,
      chatId,
      "Не задан TMDB_BEARER_TOKEN. Нужен Read Access Token как секрет GitHub Actions (не API Key).",
    );
    throw new Error("TMDB_BEARER_TOKEN missing");
  }

  const workdir = join(tmpdir(), `letterboxd-${jobId}`);
  mkdirSync(workdir, { recursive: true });
  const zipPath = join(workdir, "export.zip");

  try {
    await downloadTelegramFile(token, fileId, zipPath);
  } catch (err) {
    const msg = `Не удалось скачать ZIP из Telegram: ${err && err.message ? err.message : err}`;
    await sendTelegramText(token, chatId, msg);
    throw err;
  }

  // 1) Light charts first (no TMDB) — summary + photos.
  const calendar = runPython(CALENDAR_SCRIPT, zipPath, workdir);
  if (calendar.stdout) process.stdout.write(calendar.stdout);
  if (calendar.stderr) process.stderr.write(calendar.stderr);

  const calendarPngs = existingPngs(workdir, CALENDAR_PNGS);
  if (!calendarPngs.length) {
    const mapped =
      mapScriptError(calendar.stderr, calendar.stdout, calendar.status) ||
      "Календарные графики не созданы. Проверьте diary.csv.";
    await sendTelegramText(token, chatId, mapped);
    throw new Error(mapped);
  }

  const diarySummary = readJsonFile(join(workdir, "diary_summary.json"));
  await sendTelegramHtml(token, chatId, buildCalendarReportHtml(diarySummary || {}));
  await sendCaptionedPhotos(token, chatId, workdir, calendarPngs, CALENDAR_CAPTIONS);
  await sendTelegramText(token, chatId, calendarReadyText());

  // 2) Slow TMDB genre enrichment — script edits one progress message, then genre report + PNGs.
  const genres = runPython(GENRE_SCRIPT, zipPath, workdir);
  if (genres.stdout) process.stdout.write(genres.stdout);
  if (genres.stderr) process.stderr.write(genres.stderr);

  const genrePngs = existingPngs(workdir, GENRE_PNGS);
  if (!genrePngs.length) {
    const mapped =
      mapScriptError(genres.stderr, genres.stdout, genres.status) ||
      "Жанровые графики не созданы. Проверьте TMDB_BEARER_TOKEN и diary.csv.";
    await sendTelegramText(token, chatId, mapped);
    throw new Error(mapped);
  }

  const unmatched = unmatchedFromWorkdir(workdir, genres.stdout);
  const genreSummary = readJsonFile(join(workdir, "genre_summary.json"));
  const tmdbMessages = buildGenreReportMessages(genreSummary || {}, unmatched);
  for (const html of tmdbMessages) {
    await sendTelegramHtml(token, chatId, html);
  }
  await sendCaptionedPhotos(token, chatId, workdir, genrePngs, GENRE_CAPTIONS);

  console.log("calendar pngs", calendarPngs.join(","));
  console.log("genre pngs", genrePngs.join(","));
  console.log("workdir files", readdirSync(workdir).join(","));
  console.log("unmatched", unmatched);
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  main().catch((err) => {
    console.error(err && err.message ? err.message : err);
    process.exit(1);
  });
}
