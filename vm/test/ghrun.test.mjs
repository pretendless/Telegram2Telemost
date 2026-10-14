import assert from "node:assert/strict";
import test from "node:test";
import {
  buildGhrunDispatch,
  findWorkflowRunUrl,
  isWorkflowAllowed,
  normalizeWorkflowBasename,
  parseDispatchInputs,
  parseGhrunCommand,
  ghrunDispatchedText,
} from "../ghrun.js";

test("normalizeWorkflowBasename rejects paths and accepts basenames", () => {
  assert.deepEqual(normalizeWorkflowBasename("setup-bot.yml"), { workflow: "setup-bot.yml" });
  assert.deepEqual(normalizeWorkflowBasename(".github/workflows/setup-bot.yml"), { workflow: "setup-bot.yml" });
  assert.deepEqual(normalizeWorkflowBasename("../telemost-session.yml"), { error: "path" });
  assert.deepEqual(normalizeWorkflowBasename("foo/bar.yml"), { error: "path" });
  assert.deepEqual(normalizeWorkflowBasename("bad name.yml"), { error: "name" });
});

test("isWorkflowAllowed with optional allowlist", () => {
  assert.equal(isWorkflowAllowed("a.yml", ""), true);
  assert.equal(isWorkflowAllowed("a.yml", "b.yml,a.yml"), true);
  assert.equal(isWorkflowAllowed("c.yml", "b.yml,a.yml"), false);
});

test("parseDispatchInputs", () => {
  assert.deepEqual(parseDispatchInputs(["mode=login", "chat_id=1"]), {
    inputs: { mode: "login", chat_id: "1" },
  });
  assert.equal(parseDispatchInputs(["bad"]).error, "input");
});

test("parseGhrunCommand", () => {
  assert.equal(parseGhrunCommand("/restart"), null);
  assert.deepEqual(parseGhrunCommand("/ghrun"), { error: "usage" });
  assert.deepEqual(parseGhrunCommand("/ghrun@tg2tmbot setup-bot.yml"), {
    workflow: "setup-bot.yml",
    inputs: {},
  });
  assert.deepEqual(parseGhrunCommand("/ghrun setup-bot.yml ref=main"), {
    workflow: "setup-bot.yml",
    inputs: { ref: "main" },
  });
});

test("buildGhrunDispatch", () => {
  const built = buildGhrunDispatch({
    repo: "pretendless/tg2tm",
    workflow: "setup-bot.yml",
    ref: "main",
    inputs: { dry: "1" },
  });
  assert.equal(
    built.url,
    "https://api.github.com/repos/pretendless/tg2tm/actions/workflows/setup-bot.yml/dispatches",
  );
  assert.deepEqual(built.body, { ref: "main", inputs: { dry: "1" } });
});

test("findWorkflowRunUrl picks fresh run", async () => {
  const startedAt = Date.parse("2026-10-14T12:00:00.000Z");
  const fetchImpl = async () => ({
    status: 200,
    json: async () => ({
      workflow_runs: [
        {
          id: 1,
          created_at: "2026-10-14T12:00:05.000Z",
          html_url: "https://github.com/o/r/actions/runs/1",
        },
      ],
    }),
  });
  const url = await findWorkflowRunUrl(fetchImpl, {
    token: "t",
    repo: "pretendless/tg2tm",
    workflow: "setup-bot.yml",
    startedAt,
  });
  assert.equal(url, "https://github.com/o/r/actions/runs/1");
  assert.match(ghrunDispatchedText({ workflow: "setup-bot.yml", runUrl: url }), /setup-bot/);
});
