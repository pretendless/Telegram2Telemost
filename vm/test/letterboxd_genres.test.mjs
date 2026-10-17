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

test("calendarReadyText announces genre phase", () => {
  assert.match(calendarReadyText(), /Календарные графики готовы/);
  assert.match(calendarReadyText(), /жанры/);
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
  });
  assert.match(html, /<b>Letterboxd<\/b>/);
  assert.match(html, /<b>100<\/b>/);
  assert.match(html, /Heat &amp; Dust/);
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
});
