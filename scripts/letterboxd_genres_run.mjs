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
  "watches_by_country.png",
  "average_rating_by_country.png",
  "watches_by_director.png",
  "average_rating_by_director.png",
  "watches_by_actor.png",
  "average_rating_by_actor.png",
  "watches_by_language.png",
  "average_rating_by_language.png",
  "watches_by_studio.png",
  "average_rating_by_studio.png",
];

const CALENDAR_PNGS = [
  "views_by_weekday_month.png",
  "views_by_year.png",
  "extra_stats_decade_rating.png",
  "average_rating_by_year.png",
  "average_rating_by_release_decade.png",
  "top_rewatches.png",
  "watches_by_release_year.png",
  "average_rating_by_release_year.png",
];

const CALENDAR_CAPTIONS = {
  "views_by_weekday_month.png": "Дни недели и месяцы — стек по годам просмотра",
  "views_by_year.png": "Просмотры по годам",
  "extra_stats_decade_rating.png": "Десятилетия выхода и оценки",
  "average_rating_by_year.png": "Средняя оценка по годам просмотра",
  "average_rating_by_release_decade.png": "Средняя оценка по десятилетию выхода",
  "top_rewatches.png": "Чаще всего в дневнике",
  "watches_by_release_year.png": "Годы выхода — больше просмотров",
  "average_rating_by_release_year.png": "Годы выхода — выше оценка",
};

const GENRE_CAPTIONS = {
  "genre_counts_by_viewing_year.png": "Жанры по годам просмотра",
  "average_rating_by_genre.png": "Средняя оценка по жанрам",
  "genre_by_release_decade.png": "Жанры по десятилетию выхода",
  "watches_by_country.png": "Страны производства (TMDB)",
  "average_rating_by_country.png": "Страны — выше оценка",
  "watches_by_director.png": "Режиссёры — просмотры",
  "average_rating_by_director.png": "Режиссёры — выше оценка",
  "watches_by_actor.png": "Актёры — просмотры",
  "average_rating_by_actor.png": "Актёры — выше оценка",
  "watches_by_language.png": "Язык оригинала — просмотры",
  "average_rating_by_language.png": "Язык оригинала — выше оценка",
  "watches_by_studio.png": "Студии — просмотры",
  "average_rating_by_studio.png": "Студии — выше оценка",
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

/**
 * Expand bare "fetch failed" / undici errors into a readable string for Actions logs.
 * Includes cause chain (code, errno, syscall, address) when present.
 */
export function formatTelegramError(err) {
  if (err == null) return "unknown error";
  const parts = [];
  let cur = err;
  let depth = 0;
  while (cur && depth < 4) {
    if (typeof cur === "string") {
      parts.push(cur);
      break;
    }
    const msg = cur.message || String(cur);
    const bits = [msg];
    if (cur.name && cur.name !== "Error") bits.push(`name=${cur.name}`);
    if (cur.code) bits.push(`code=${cur.code}`);
    if (cur.errno != null) bits.push(`errno=${cur.errno}`);
    if (cur.syscall) bits.push(`syscall=${cur.syscall}`);
    if (cur.address) bits.push(`address=${cur.address}`);
    if (cur.port != null) bits.push(`port=${cur.port}`);
    parts.push(bits.join(" "));
    cur = cur.cause;
    depth += 1;
  }
  return parts.join(" | cause: ");
}

/** One-shot Bot API fetch; wraps failures with step label (no retries). */
export async function telegramFetch(url, options, meta = {}) {
  const label = meta.label || "telegram";
  try {
    return await fetch(url, options);
  } catch (err) {
    const detail = formatTelegramError(err);
    console.error(`[letterboxd] ${label} FAILED: ${detail}`);
    const wrapped = new Error(`${label}: ${detail}`);
    wrapped.cause = err;
    throw wrapped;
  }
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

  // Count / rating tops (rewatches, release years, …) ship as charts — no HTML lists.
  return lines.join("\n");
}

/**
 * Short TMDB blurb after enrichment — ranked tops are charts, not HTML bullets.
 * Returns one message (array for call-site compatibility).
 */
export function buildGenreReportMessages(summary, unmatchedFallback = 0) {
  const s = summary && typeof summary === "object" ? summary : {};
  const unmatched =
    s.unmatched != null && Number.isFinite(Number(s.unmatched))
      ? Number(s.unmatched)
      : Number(unmatchedFallback) || 0;
  const unique = s.unique_titles != null ? fmtNum(s.unique_titles) : null;
  const resolved = s.resolved != null ? fmtNum(s.resolved) : null;

  const lines = ["<b>Letterboxd · TMDB</b>"];
  if (unique != null && resolved != null) {
    lines.push(
      `Обогащено: <b>${escapeHtml(resolved)}</b> / <b>${escapeHtml(unique)}</b> фильмов`,
    );
  } else {
    lines.push("Подробности из TMDB готовы — графики ниже.");
  }
  if (unmatched > 0) {
    lines.push(`Без жанров TMDB: <b>${escapeHtml(String(unmatched))}</b>`);
  }
  lines.push("<i>Топы — на графиках (просмотры / выше оценка).</i>");
  return [lines.join("\n")];
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

async function sendTelegramText(token, chatId, text, parseMode = "", label = "sendMessage") {
  const payload = {
    chat_id: chatId,
    text,
    link_preview_options: { is_disabled: true },
  };
  if (parseMode) payload.parse_mode = parseMode;
  const res = await telegramFetch(
    telegramApi(token, "sendMessage"),
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    },
    { label: `${label}${parseMode ? `/${parseMode}` : ""}` },
  );
  if (!res.ok) {
    console.error(`[letterboxd] ${label} HTTP ${res.status}${parseMode ? ` (${parseMode})` : ""}`);
  }
  return res.ok;
}

async function sendTelegramHtml(token, chatId, html, label = "sendMessage HTML") {
  return sendTelegramText(token, chatId, html, "HTML", label);
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
  const res = await telegramFetch(
    telegramApi(token, "sendPhoto"),
    { method: "POST", body: form },
    { label: `sendPhoto ${filename}` },
  );
  if (!res.ok) {
    console.error(`[letterboxd] sendPhoto ${filename} HTTP ${res.status}`);
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
  const res = await telegramFetch(
    telegramApi(token, "sendDocument"),
    { method: "POST", body: form },
    { label: `sendDocument ${filename}` },
  );
  if (!res.ok) console.error(`[letterboxd] sendDocument ${filename} HTTP ${res.status}`);
  return res.ok;
}

/**
 * Send charts one-by-one. On failure: log + notify that file, then continue
 * the rest of the batch (no retries — one ECONNRESET must not drop everything after).
 */
async function sendCaptionedPhotos(token, chatId, workdir, names, captions) {
  let sent = 0;
  const failed = [];
  for (const name of names) {
    const caption = captions[name] ? `<i>${escapeHtml(captions[name])}</i>` : "";
    try {
      const ok = await sendTelegramPhoto(token, chatId, join(workdir, name), name, caption);
      if (!ok) {
        failed.push(`${name} (HTTP reject)`);
        console.error(`[letterboxd] sendCaptionedPhotos CONTINUE after fail: ${name} HTTP reject`);
        try {
          await sendTelegramText(
            token,
            chatId,
            `Не удалось отправить ${name}.`,
            "",
            `notify fail ${name}`,
          );
        } catch (_) {
          /* ignore secondary notify failure */
        }
      } else {
        sent += 1;
      }
    } catch (err) {
      const detail = err && err.message ? err.message : String(err);
      failed.push(`${name}: ${detail}`);
      console.error(`[letterboxd] sendCaptionedPhotos CONTINUE after fail: ${name}: ${detail}`);
      try {
        await sendTelegramText(
          token,
          chatId,
          `Не удалось отправить ${name}: ${detail}`,
          "",
          `notify fail ${name}`,
        );
      } catch (_) {
        /* ignore secondary notify failure */
      }
    }
  }
  return { sent, failed, total: names.length };
}

async function downloadTelegramFile(token, fileId, destPath) {
  const metaRes = await telegramFetch(
    telegramApi(token, "getFile"),
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ file_id: fileId }),
    },
    { label: "getFile" },
  );
  if (!metaRes.ok) throw new Error(`getFile http ${metaRes.status}`);
  const meta = await metaRes.json();
  if (!meta.ok || !meta.result || !meta.result.file_path) {
    throw new Error("getFile missing path");
  }
  const filePath = String(meta.result.file_path);
  const fileRes = await telegramFetch(
    `https://api.telegram.org/file/bot${token}/${filePath}`,
    {},
    { label: "download ZIP" },
  );
  if (!fileRes.ok) throw new Error(`file download http ${fileRes.status}`);
  const buf = Buffer.from(await fileRes.arrayBuffer());
  writeFileSync(destPath, buf);
  return destPath;
}

/** Best-effort chat notice after a late failure (e.g. post-TMDB send). */
async function notifySendFailure(token, chatId, phase, err) {
  const detail = err && err.message ? err.message : String(err);
  console.error(`notifySendFailure [${phase}]:`, detail);
  try {
    await sendTelegramText(
      token,
      chatId,
      `Letterboxd: сбой отправки после ${phase}: ${detail}`,
      "",
      `notify ${phase}`,
    );
  } catch (notifyErr) {
    console.error(
      "could not notify chat about send failure:",
      notifyErr && notifyErr.message ? notifyErr.message : notifyErr,
    );
  }
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

  // TMDB work is done — send once each; mid-batch failures continue (no retries).
  const batchFailures = [];
  for (let i = 0; i < tmdbMessages.length; i++) {
    const label = `genre HTML part ${i + 1}/${tmdbMessages.length}`;
    try {
      const ok = await sendTelegramHtml(token, chatId, tmdbMessages[i], label);
      if (!ok) {
        batchFailures.push(`${label} rejected by Telegram`);
        console.error(`[letterboxd] CONTINUE after fail: ${label} HTTP reject`);
      }
    } catch (err) {
      const detail = err && err.message ? err.message : String(err);
      batchFailures.push(`${label}: ${detail}`);
      console.error(`[letterboxd] CONTINUE after fail: ${label}: ${detail}`);
    }
  }
  const photoResult = await sendCaptionedPhotos(
    token,
    chatId,
    workdir,
    genrePngs,
    GENRE_CAPTIONS,
  );
  if (photoResult.failed.length) {
    batchFailures.push(...photoResult.failed);
    console.error(
      `[letterboxd] genre PNGs sent ${photoResult.sent}/${photoResult.total}; failed: ${photoResult.failed.join("; ")}`,
    );
  }
  if (batchFailures.length) {
    const summary = batchFailures.join(" | ");
    await notifySendFailure(token, chatId, "TMDB HTML/PNG", new Error(summary));
    throw new Error(`TMDB send incomplete: ${summary}`);
  }

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
