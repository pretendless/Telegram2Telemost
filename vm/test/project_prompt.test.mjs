import assert from "node:assert/strict";
import test from "node:test";
import {
  buildProjectPromptDispatch,
  findProjectPromptRunUrl,
  newPromptId,
  normalizeProjectReplyBody,
  parseProjectCommand,
  optionalProjectIssueWorkflow,
  projectDispatchedText,
  projectFastAckSummary,
  projectIssueTitle,
  projectPromptKey,
  projectStartingText,
} from "../project_prompt.js";

test("parseProjectCommand requires non-empty body", () => {
  assert.deepEqual(parseProjectCommand("/project"), { error: "empty" });
  assert.deepEqual(parseProjectCommand("/project   "), { error: "empty" });
  assert.deepEqual(parseProjectCommand("/project@tg2tmbot что нового?"), { prompt: "что нового?" });
  assert.equal(parseProjectCommand("/restart"), null);
});

test("newPromptId is stable prefix", () => {
  const id = newPromptId(() => new Date("2026-10-14T12:00:00.000Z"));
  assert.match(id, /^tg-2026-10-14T12-00-00-000Z/);
});

test("buildProjectPromptDispatch targets cursor-agent workflow", () => {
  const built = buildProjectPromptDispatch({
    repo: "pretendless/Telegram2Telemost",
    promptId: "tg-1",
    chatId: 8502935020,
  });
  assert.equal(
    built.url,
    "https://api.github.com/repos/pretendless/Telegram2Telemost/actions/workflows/cursor-agent.yml/dispatches",
  );
  assert.deepEqual(built.body.inputs, { prompt_id: "tg-1", chat_id: "8502935020" });
  assert.equal(optionalProjectIssueWorkflow("1"), "project-prompt.yml");
  assert.equal(optionalProjectIssueWorkflow(""), "");
  assert.equal(optionalProjectIssueWorkflow("no"), "");
});

test("normalizeProjectReplyBody", () => {
  assert.deepEqual(normalizeProjectReplyBody({ id: "tg-1", summary: "ok" }), {
    id: "tg-1",
    summary: "ok",
    chatId: null,
    issueUrl: null,
  });
  assert.throws(() => normalizeProjectReplyBody({ summary: "x" }), /id/);
});

test("projectPromptKey", () => {
  assert.equal(projectPromptKey("tg-1"), "project:prompt:tg-1");
});

test("projectFastAckSummary and issue title", () => {
  assert.match(projectFastAckSummary("hello world"), /Принято: hello world/);
  assert.match(projectIssueTitle("short"), /^\[TG Project\] short$/);
  assert.match(projectStartingText(), /GitHub/);
  assert.match(projectDispatchedText({ promptId: "tg-1", runUrl: "" }), /dispatch ok/);
  assert.match(projectDispatchedText({ promptId: "tg-1", runUrl: "https://ex/run" }), /https:\/\/ex\/run/);
});

test("findProjectPromptRunUrl picks fresh run", async () => {
  const startedAt = Date.parse("2026-10-14T12:00:00.000Z");
  const fetchImpl = async () => ({
    status: 200,
    json: async () => ({
      workflow_runs: [
        {
          id: 1,
          status: "in_progress",
          created_at: "2026-10-14T12:00:05.000Z",
          html_url: "https://github.com/o/r/actions/runs/1",
        },
      ],
    }),
  });
  const url = await findProjectPromptRunUrl(fetchImpl, {
    token: "t",
    repo: "pretendless/Telegram2Telemost",
    startedAt,
    attempts: 1,
  });
  assert.equal(url, "https://github.com/o/r/actions/runs/1");
});
