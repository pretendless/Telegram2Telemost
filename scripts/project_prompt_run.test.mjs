import assert from "node:assert/strict";
import test from "node:test";
import { issueBody, issueLinkReplySummary, issueTitle } from "./project_prompt_run.mjs";
import { projectFastAckSummary } from "../vm/project_prompt.js";

test("issueTitle uses TG Project prefix and 60 char head", () => {
  const long = "a".repeat(80);
  assert.match(issueTitle(long), /^\[TG Project\] /);
  assert.ok(issueTitle(long).length <= "[TG Project] ".length + 60 + 1);
});

test("issueBody includes PROMPT_FOR_PROJECT block", () => {
  const body = issueBody({
    prompt: "что с drain?",
    promptId: "tg-1",
    chatId: "42",
    runUrl: "https://example.com/run/1",
  });
  assert.match(body, /## PROMPT_FOR_PROJECT/);
  assert.match(body, /что с drain\?/);
  assert.match(body, /tg-1/);
});

test("projectFastAckSummary truncates at 200 chars", () => {
  const long = "x".repeat(300);
  const summary = projectFastAckSummary(long);
  assert.match(summary, /^Принято: /);
  assert.match(summary, /Обработка в Project начата\.$/);
  assert.ok(summary.length < 300);
});

test("issueLinkReplySummary mentions issue url", () => {
  const text = issueLinkReplySummary("https://github.com/o/r/issues/1");
  assert.match(text, /issues\/1/);
  assert.match(text, /PROMPT_FOR_PROJECT/);
});
