import assert from "node:assert/strict";
import test from "node:test";
import {
  buildLetterboxdDispatch,
  decodeAwaitLetterboxd,
  encodeAwaitLetterboxd,
  isZipDocument,
  normalizeTelegramFileId,
  parseLetterboxdCommand,
} from "../letterboxd_genres.js";
import {
  buildCalendarReportHtml,
  buildGenreReportHtml,
  buildGenreReportMessages,
  calendarReadyText,
  escapeHtml,
  mapScriptError,
  unmatchedFromWorkdir,
} from "../../scripts/letterboxd_genres_run.mjs";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

test("parseLetterboxdCommand", () => {
  assert.equal(parseLetterboxdCommand("/start"), null);
  assert.equal(parseLetterboxdCommand("/genres"), null);
  assert.deepEqual(parseLetterboxdCommand("/letterboxd"), { ok: true });
  assert.deepEqual(parseLetterboxdCommand("/letterboxd@tg2tmbot"), { ok: true });
  assert.deepEqual(parseLetterboxdCommand("/letterboxd extra"), { error: "usage" });
});

test("await letterboxd encode/decode", () => {
  const raw = encodeAwaitLetterboxd({ since: "2026-10-17T00:00:00.000Z" });
  assert.deepEqual(decodeAwaitLetterboxd(raw), { kind: "letterboxd", since: "2026-10-17T00:00:00.000Z" });
  assert.deepEqual(decodeAwaitLetterboxd('{"kind":"genres","since":"x"}'), { kind: "letterboxd", since: "x" });
  assert.equal(decodeAwaitLetterboxd(""), null);
  assert.equal(decodeAwaitLetterboxd('{"step":"name"}'), null);
});

test("isZipDocument and file_id", () => {
  assert.equal(isZipDocument({ file_name: "export.zip", mime_type: "application/octet-stream" }), true);
  assert.equal(isZipDocument({ file_name: "diary.csv" }), false);
  assert.equal(isZipDocument({ mime_type: "application/zip" }), true);
  assert.equal(normalizeTelegramFileId("BQACAgIAAxkBAAI"), "BQACAgIAAxkBAAI");
  assert.equal(normalizeTelegramFileId("../x"), "");
});

test("buildLetterboxdDispatch", () => {
  const built = buildLetterboxdDispatch({
    repo: "pretendless/tg2tm",
    workflow: "letterboxd.yml",
    ref: "main",
    jobId: "lb-1",
    chatId: "7",
    fileId: "BQACAgIAAxkBAAI1234567890",
  });
  assert.equal(
    built.url,
    "https://api.github.com/repos/pretendless/tg2tm/actions/workflows/letterboxd.yml/dispatches",
  );
  assert.deepEqual(built.body, {
    ref: "main",
    inputs: { job_id: "lb-1", chat_id: "7", file_id: "BQACAgIAAxkBAAI1234567890" },
  });
});

test("mapScriptError covers diary and bearer", () => {
  assert.match(mapScriptError("Не задан TMDB_BEARER_TOKEN", "", 2), /TMDB_BEARER_TOKEN/);
  assert.match(mapScriptError("В ZIP не найден diary.csv", "", 1), /diary\.csv/);
});

test("unmatchedFromWorkdir reads csv", () => {
  const dir = mkdtempSync(join(tmpdir(), "lb-test-"));
  writeFileSync(join(dir, "tmdb_unmatched.csv"), "Name,Year\nA,2020\nB,2021\n");
  assert.equal(unmatchedFromWorkdir(dir), 2);
});

test("calendarReadyText announces TMDB details phase", () => {
  assert.match(calendarReadyText(), /Календарные графики готовы/);
  assert.match(calendarReadyText(), /TMDB/);
  assert.match(calendarReadyText(), /режиссёры/);
});

test("escapeHtml for film titles", () => {
  assert.equal(escapeHtml('A & B <C> "D"'), "A &amp; B &lt;C&gt; \"D\"");
});

test("buildCalendarReportHtml uses bold numbers and HTML", () => {
  const html = buildCalendarReportHtml({
    entries: 100,
    unique_films: 80,
    year_min: 2020,
    year_max: 2024,
    peak_year: 2023,
    peak_year_count: 40,
    favorite_weekday: "Сб",
    favorite_weekday_count: 20,
    favorite_month: "Окт",
    favorite_month_count: 15,
    rated_count: 70,
    rated_share: 0.7,
    rating_avg: 3.75,
    rating_mode: 4,
    rating_mode_count: 25,
    top_rewatches: [{ name: "Heat & Dust", year: 1995, count: 3 }],
    top_rated_release_years: [{ year: 1999, avg: 4.5, films: 8, rated: 8 }],
    top_release_years_by_count: [{ year: 2019, count: 22 }],
  });
  assert.match(html, /<b>Letterboxd<\/b>/);
  assert.match(html, /<b>100<\/b>/);
  assert.match(html, /Heat &amp; Dust/);
  assert.match(html, /Годы выхода — выше оценка/);
  assert.match(html, /больше 3 оценённых фильмов/);
  assert.match(html, /<b>1999<\/b>/);
  assert.match(html, /Годы выхода — больше просмотров/);
  assert.doesNotMatch(html, /parse_mode/);
});

test("buildGenreReportHtml lists top genres", () => {
  const html = buildGenreReportHtml(
    {
      top_genres: [
        { name: "Drama", count: 50, pct: 20.5 },
        { name: "Comedy <x>", count: 10, pct: 4.1 },
      ],
      unmatched: 2,
    },
    9,
  );
  assert.match(html, /<b>Жанры \(TMDB\)<\/b>/);
  assert.match(html, /Comedy &lt;x&gt;/);
  assert.match(html, /<b>2<\/b>/);
  assert.doesNotMatch(html, /выше оценка/);
});

test("buildGenreReportMessages splits genres and people/countries", () => {
  const msgs = buildGenreReportMessages({
    top_genres: [{ name: "Drama", count: 50, pct: 20 }],
    top_genres_by_rating: [{ name: "Drama", count: 50, avg: 4.1, rated: 40 }],
    unmatched: 1,
    countries: [{ name: "United States of America", count: 40, avg: 3.8 }],
    countries_by_rating: [{ name: "France", count: 10, avg: 4.5, rated: 8 }],
    directors: [{ name: "Nolan & Co", count: 5, avg: 4.2 }],
    directors_by_rating: [{ name: "Nolan & Co", count: 5, avg: 4.2, rated: 5 }],
    actors: [{ name: "Actor <X>", count: 4, avg: 3.5 }],
    actors_by_rating: [],
    languages: [{ name: "en", count: 30 }],
    languages_by_rating: [{ name: "en", count: 30, avg: 3.9, rated: 20 }],
    companies: [{ name: "A24", count: 6, avg: 4.0 }],
    companies_by_rating: [{ name: "A24", count: 6, avg: 4.0, rated: 6 }],
    min_person_count: 3,
  });
  assert.equal(msgs.length, 2);
  assert.match(msgs[0], /Жанры \(TMDB\)/);
  assert.match(msgs[0], /Жанры \(TMDB\) — выше оценка/);
  assert.match(msgs[1], /Страны/);
  assert.match(msgs[1], /Страны — выше оценка/);
  assert.match(msgs[1], /Режиссёры/);
  assert.match(msgs[1], /Nolan &amp; Co/);
  assert.match(msgs[1], /Actor &lt;X&gt;/);
  assert.doesNotMatch(msgs[1], /Актёры — выше оценка/);
  assert.match(msgs[1], /английский/);
  assert.match(msgs[1], /Студии — выше оценка/);
  assert.match(msgs[1], /больше 3 оценённых фильмов/);
});
