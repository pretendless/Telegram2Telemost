import assert from "node:assert/strict";
import test from "node:test";
import {
  buildGenresDispatch,
  decodeAwaitGenres,
  encodeAwaitGenres,
  isZipDocument,
  normalizeTelegramFileId,
  parseGenresCommand,
} from "../letterboxd_genres.js";
import { mapScriptError, unmatchedFromWorkdir } from "../../scripts/letterboxd_genres_run.mjs";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

test("parseGenresCommand", () => {
  assert.equal(parseGenresCommand("/start"), null);
  assert.deepEqual(parseGenresCommand("/genres"), { ok: true });
  assert.deepEqual(parseGenresCommand("/genres@tg2tmbot"), { ok: true });
  assert.deepEqual(parseGenresCommand("/genres extra"), { error: "usage" });
});

test("await genres encode/decode", () => {
  const raw = encodeAwaitGenres({ since: "2026-10-17T00:00:00.000Z" });
  assert.deepEqual(decodeAwaitGenres(raw), { kind: "genres", since: "2026-10-17T00:00:00.000Z" });
  assert.equal(decodeAwaitGenres(""), null);
  assert.equal(decodeAwaitGenres('{"step":"name"}'), null);
});

test("isZipDocument and file_id", () => {
  assert.equal(isZipDocument({ file_name: "export.zip", mime_type: "application/octet-stream" }), true);
  assert.equal(isZipDocument({ file_name: "diary.csv" }), false);
  assert.equal(isZipDocument({ mime_type: "application/zip" }), true);
  assert.equal(normalizeTelegramFileId("BQACAgIAAxkBAAI"), "BQACAgIAAxkBAAI");
  assert.equal(normalizeTelegramFileId("../x"), "");
});

test("buildGenresDispatch", () => {
  const built = buildGenresDispatch({
    repo: "pretendless/tg2tm",
    workflow: "letterboxd-genres.yml",
    ref: "main",
    jobId: "lb-1",
    chatId: "7",
    fileId: "BQACAgIAAxkBAAI1234567890",
  });
  assert.equal(
    built.url,
    "https://api.github.com/repos/pretendless/tg2tm/actions/workflows/letterboxd-genres.yml/dispatches",
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
