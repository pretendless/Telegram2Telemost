import assert from "node:assert/strict";
import test from "node:test";
import {
  advanceLetterboxdWizard,
  buildLetterboxdDispatch,
  decodeAwaitLetterboxd,
  encodeAwaitLetterboxd,
  isZipDocument,
  normalizeTelegramFileId,
  parseLetterboxdCommand,
  parseWatchBound,
  parseWatchInterval,
} from "../letterboxd_genres.js";
import {
  buildCalendarReportHtml,
  buildGenreReportHtml,
  buildGenreReportMessages,
  calendarCaptions,
  calendarReadyText,
  escapeHtml,
  formatTelegramError,
  mapScriptError,
  telegramFetch,
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
  const decoded = decodeAwaitLetterboxd(raw);
  assert.equal(decoded.kind, "letterboxd");
  assert.equal(decoded.since, "2026-10-17T00:00:00.000Z");
  assert.equal(decoded.step, "zip");
  assert.equal(decodeAwaitLetterboxd('{"kind":"genres","since":"x"}').step, "zip");
  assert.equal(decodeAwaitLetterboxd(""), null);
  assert.equal(decodeAwaitLetterboxd('{"step":"name"}'), null);
});

test("watch bounds are month-before-year; one value is the whole interval", () => {
  assert.equal(parseWatchBound("2012", "start"), "2012-01-01");
  assert.equal(parseWatchBound("2012", "end"), "2012-12-31");
  assert.equal(parseWatchBound("06-2012", "start"), "2012-06-01");
  assert.equal(parseWatchBound("06-2012", "end"), "2012-06-30");
  assert.equal(parseWatchBound("06.2012", "end"), "2012-06-30");
  assert.equal(parseWatchBound("15-06-2012", "start"), "2012-06-15");
  assert.equal(parseWatchBound("15.06.2012", "end"), "2012-06-15");
  assert.equal(parseWatchBound("2012-06", "start"), "");
  assert.equal(parseWatchBound("2012-06-15", "start"), "");
  assert.deepEqual(parseWatchInterval("2012"), { dateFrom: "2012-01-01", dateTo: "2012-12-31" });
  assert.deepEqual(parseWatchInterval("06-2012"), { dateFrom: "2012-06-01", dateTo: "2012-06-30" });
  assert.deepEqual(parseWatchInterval("15-06-2012"), { dateFrom: "2012-06-15", dateTo: "2012-06-15" });
  assert.deepEqual(parseWatchInterval("2018 2020"), { dateFrom: "2018-01-01", dateTo: "2020-12-31" });
  assert.deepEqual(parseWatchInterval("01-2019 06-2019"), { dateFrom: "2019-01-01", dateTo: "2019-06-30" });
  assert.deepEqual(parseWatchInterval("15-01-2019-31-03-2019"), {
    dateFrom: "2019-01-15",
    dateTo: "2019-03-31",
  });
  assert.deepEqual(parseWatchInterval("15.01.2019-31.03.2019"), {
    dateFrom: "2019-01-15",
    dateTo: "2019-03-31",
  });
  assert.deepEqual(parseWatchInterval("06.2012"), { dateFrom: "2012-06-01", dateTo: "2012-06-30" });
  assert.deepEqual(parseWatchInterval("март 2012"), { dateFrom: "2012-03-01", dateTo: "2012-03-31" });
  assert.equal(parseWatchInterval("2012-06"), null);
  assert.equal(parseWatchInterval("2012-06-15"), null);
});

test("one typed period skips the second bound and asks about undated films", () => {
  const state = { step: "range_start", fileId: "BQACAgIAAxkBAAI1234567890", topN: 20, minRated: 3, includeUSA: true, includeEnglish: true };
  const next = advanceLetterboxdWizard(state, { kind: "text", text: "2019" });
  assert.equal(next.state.step, "undated");
  assert.equal(next.state.dateFrom, "2019-01-01");
  assert.equal(next.state.dateTo, "2019-12-31");
  assert.equal(next.dispatch, undefined);
  const bad = advanceLetterboxdWizard(state, { kind: "text", text: "2012-06" });
  assert.equal(bad.state.step, "range_start");
  assert.equal(bad.dispatch, undefined);
  assert.match(bad.messages[0].text, /06-2012/);
  const backwards = advanceLetterboxdWizard(state, { kind: "text", text: "2020 2018" });
  assert.equal(backwards.state.step, "range_start");
  assert.equal(backwards.dispatch, undefined);
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
    repo: "pretendless/Telegram2Telemost",
    workflow: "letterboxd.yml",
    ref: "main",
    jobId: "lb-1",
    chatId: "7",
    fileId: "BQACAgIAAxkBAAI1234567890",
  });
  assert.equal(
    built.url,
    "https://api.github.com/repos/pretendless/Telegram2Telemost/actions/workflows/letterboxd.yml/dispatches",
  );
  assert.deepEqual(built.body, {
    ref: "main",
    inputs: {
      job_id: "lb-1",
      chat_id: "7",
      file_id: "BQACAgIAAxkBAAI1234567890",
      top_n: "20",
      min_rated: "3",
      include_usa: "true",
      include_english: "true",
      date_from: "",
      date_to: "",
      include_undated: "false",
    },
  });
});

test("mapScriptError covers diary and bearer", () => {
  assert.match(mapScriptError("Не задан TMDB_BEARER_TOKEN", "", 2), /TMDB_BEARER_TOKEN/);
  assert.match(mapScriptError("В ZIP не найден diary.csv", "", 1), /diary\.csv/);
  assert.match(
    mapScriptError("В выбранном диапазоне нет записей дневника с датой просмотра.", "", 2),
    /выбранном диапазоне/,
  );
});

test("calendar captions name the watch-time grain", () => {
  const days = calendarCaptions({ watch_time_grain: "day" });
  assert.equal(days["views_by_year.png"], "Просмотры по дням");
  assert.equal(days["average_rating_by_year.png"], "Средняя оценка по дням");
  assert.equal(days["viewing_pace.png"], "Темп просмотров по дням");
  const months = calendarCaptions({ watch_time_grain: "month" });
  assert.equal(months["views_by_year.png"], "Просмотры по месяцам");
  assert.equal(months["viewing_pace.png"], "Темп просмотров по месяцам");
  const years = calendarCaptions({});
  assert.equal(years["views_by_year.png"], "Просмотры по годам");
  assert.equal(years["viewing_pace.png"], "Темп просмотров по месяцам");
});

test("formatTelegramError expands cause chain", () => {
  const cause = new Error("connect ECONNRESET");
  cause.code = "ECONNRESET";
  cause.syscall = "connect";
  cause.address = "1.2.3.4";
  const err = new Error("fetch failed");
  err.cause = cause;
  const text = formatTelegramError(err);
  assert.match(text, /fetch failed/);
  assert.match(text, /ECONNRESET/);
  assert.match(text, /cause:/);
});

test("telegramFetch is one-shot and labels failures", async () => {
  let calls = 0;
  const previous = globalThis.fetch;
  globalThis.fetch = async () => {
    calls += 1;
    throw new Error("fetch failed");
  };
  try {
    await assert.rejects(
      () =>
        telegramFetch("https://example.test/bot", { method: "POST" }, { label: "genre HTML part 1/2" }),
      (err) => {
        assert.match(String(err.message), /genre HTML part 1\/2/);
        assert.match(String(err.message), /fetch failed/);
        return true;
      },
    );
    assert.equal(calls, 1);
  } finally {
    globalThis.fetch = previous;
  }
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

test("buildCalendarReportHtml keeps blurb, drops charted tops", () => {
  const html = buildCalendarReportHtml({
    entries: 100,
    unique_films: 80,
    year_min: 2020,
    year_max: 2024,
    peak_day: "2021-03-15",
    peak_day_label: "15 марта 2021",
    peak_day_count: 7,
    peak_year: 2023,
    peak_year_count: 40,
    favorite_weekday: "Сб",
    favorite_weekday_count: 20,
    favorite_month: "Окт",
    favorite_month_count: 15,
    films_per_month: 4.2,
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
  assert.match(html, /Больше всего просмотров за день: <b>15 марта 2021<\/b> \(<b>7<\/b>\)/);
  assert.match(html, /Темп: в среднем <b>4\.2<\/b> фильмов в месяц/);
  assert.match(html, /средняя <b>3\.75<\/b>/);
  assert.doesNotMatch(html, /Heat/);
  assert.doesNotMatch(html, /Годы выхода/);
  assert.doesNotMatch(html, /Повторы/);
  assert.doesNotMatch(html, /parse_mode/);
});

test("buildGenreReportHtml is short blurb without ranked lists", () => {
  const html = buildGenreReportHtml(
    {
      unique_titles: 100,
      resolved: 98,
      top_genres: [
        { name: "Drama", count: 50, pct: 20.5 },
        { name: "Comedy <x>", count: 10, pct: 4.1 },
      ],
      unmatched: 2,
    },
    9,
  );
  assert.match(html, /Letterboxd · TMDB/);
  assert.match(html, /Обогащено/);
  assert.match(html, /<b>2<\/b>/);
  assert.doesNotMatch(html, /Comedy/);
  assert.doesNotMatch(html, /Жанры \(TMDB\) — выше оценка/);
});

test("buildGenreReportMessages drops people/country bullet tops", () => {
  const msgs = buildGenreReportMessages({
    unique_titles: 50,
    resolved: 48,
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
  assert.equal(msgs.length, 1);
  assert.match(msgs[0], /Letterboxd · TMDB/);
  assert.match(msgs[0], /графиках/);
  assert.doesNotMatch(msgs[0], /Nolan/);
  assert.doesNotMatch(msgs[0], /Страны — выше оценка/);
  assert.doesNotMatch(msgs[0], /Актёры/);
  assert.doesNotMatch(msgs[0], /Студии/);
});
