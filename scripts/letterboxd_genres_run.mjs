// GitHub Actions: download Letterboxd ZIP from Telegram, run chart scripts, send PNGs.
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
];

const CALENDAR_PNGS = [
  "views_by_weekday_month.png",
  "views_by_year.png",
  "extra_stats_decade_rating.png",
];

const PNG_NAMES = [...CALENDAR_PNGS, ...GENRE_PNGS];

const __dirname = dirname(fileURLToPath(import.meta.url));
const GENRE_SCRIPT = join(__dirname, "letterboxd_genre_charts.py");
const CALENDAR_SCRIPT = join(__dirname, "letterboxd_calendar_charts.py");

function env(name) {
  return String(process.env[name] || "").trim();
}

function telegramApi(token, method) {
  return `https://api.telegram.org/bot${token}/${method}`;
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

export function existingPngs(workdir, names = PNG_NAMES) {
  return names.filter((name) => {
    const path = join(workdir, name);
    return existsSync(path) && readFileSync(path).byteLength > 32;
  });
}

async function sendTelegramText(token, chatId, text) {
  const res = await fetch(telegramApi(token, "sendMessage"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text, link_preview_options: { is_disabled: true } }),
  });
  if (!res.ok) console.error("sendMessage", res.status);
  return res.ok;
}

async function sendTelegramDocument(token, chatId, filePath, filename, caption = "") {
  const bytes = readFileSync(filePath);
  const form = new FormData();
  form.set("chat_id", String(chatId));
  if (caption) form.set("caption", caption);
  form.set("document", new Blob([bytes], { type: "image/png" }), filename);
  const res = await fetch(telegramApi(token, "sendDocument"), {
    method: "POST",
    body: form,
  });
  if (!res.ok) console.error("sendDocument", filename, res.status);
  return res.ok;
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

  // Calendar charts need only diary.csv (no TMDB). Genre charts use the real user script + Bearer.
  const calendar = runPython(CALENDAR_SCRIPT, zipPath, workdir);
  if (calendar.stdout) process.stdout.write(calendar.stdout);
  if (calendar.stderr) process.stderr.write(calendar.stderr);

  const genres = runPython(GENRE_SCRIPT, zipPath, workdir);
  if (genres.stdout) process.stdout.write(genres.stdout);
  if (genres.stderr) process.stderr.write(genres.stderr);

  const calendarPngs = existingPngs(workdir, CALENDAR_PNGS);
  const genrePngs = existingPngs(workdir, GENRE_PNGS);
  const pngs = [...calendarPngs, ...genrePngs];

  if (!pngs.length) {
    const mapped =
      mapScriptError(calendar.stderr, calendar.stdout, calendar.status) ||
      mapScriptError(genres.stderr, genres.stdout, genres.status) ||
      "Графики не созданы (нет PNG). Проверьте diary.csv и TMDB.";
    await sendTelegramText(token, chatId, mapped);
    throw new Error(mapped);
  }

  if (calendar.status !== 0 && !calendarPngs.length) {
    const mapped = mapScriptError(calendar.stderr, calendar.stdout, calendar.status);
    if (mapped) await sendTelegramText(token, chatId, mapped);
  }
  if (genres.status !== 0 && !genrePngs.length) {
    const mapped = mapScriptError(genres.stderr, genres.stdout, genres.status);
    if (mapped) {
      await sendTelegramText(
        token,
        chatId,
        calendarPngs.length ? `Календарные графики готовы; жанры не удалось: ${mapped}` : mapped,
      );
    }
  }

  const unmatched = unmatchedFromWorkdir(workdir, genres.stdout);
  let first = true;
  for (const name of pngs) {
    const caption = first
      ? unmatched > 0
        ? `Letterboxd (${pngs.length} PNG). Без жанров TMDB: ${unmatched}.`
        : `Letterboxd (${pngs.length} PNG).`
      : "";
    first = false;
    const ok = await sendTelegramDocument(token, chatId, join(workdir, name), name, caption);
    if (!ok) {
      await sendTelegramText(token, chatId, `Не удалось отправить ${name}.`);
    }
  }

  console.log("pngs", pngs.join(","));
  console.log("workdir files", readdirSync(workdir).join(","));
  console.log("unmatched", unmatched);

  if (!genrePngs.length) {
    throw new Error("genre charts missing");
  }
  if (!calendarPngs.length) {
    throw new Error("calendar charts missing");
  }
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  main().catch((err) => {
    console.error(err && err.message ? err.message : err);
    process.exit(1);
  });
}
