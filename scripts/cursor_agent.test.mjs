import assert from "node:assert/strict";
import test from "node:test";
import {
  attachAgentEnvVars,
  authFailureSummary,
  buildCreateAgentRequest,
  composeAgentPrompt,
  isTerminalRunStatus,
  nextPollDelayMs,
  readCreateAgentIds,
  redactSecrets,
  pollGaveUpSummary,
  shouldPostPolledSummary,
  summaryForTerminalRun,
} from "./cursor_agent.mjs";

test("buildCreateAgentRequest matches Cloud Agents OpenAPI create shape", () => {
  const body = buildCreateAgentRequest({
    text: "answer briefly",
    repoUrl: "https://github.com/pretendless/Telegram2Telemost",
    startingRef: "main",
    name: "tg tg-1",
  });
  assert.deepEqual(body, {
    prompt: { text: "answer briefly" },
    repos: [{ url: "https://github.com/pretendless/Telegram2Telemost", startingRef: "main" }],
    autoCreatePR: false,
    workOnCurrentBranch: false,
    mode: "plan",
    name: "tg tg-1",
  });
  assert.equal(buildCreateAgentRequest({ text: "x", mode: "agent" }).mode, "agent");
  assert.equal(buildCreateAgentRequest({ text: "x", mode: "nope" }).mode, "plan");
  assert.throws(() => buildCreateAgentRequest({ text: "  " }), /prompt text/);
});

test("composeAgentPrompt asks for a short reply and does not embed secrets", () => {
  const text = composeAgentPrompt({
    userPrompt: "что с очередью?",
    promptId: "tg-1",
    workerBase: "https://tg2tmbot.prtndz.workers.dev",
  });
  assert.match(text, /что с очередью\?/);
  assert.match(text, /Prompt id: tg-1/);
  assert.match(text, /\/project\/reply/);
  assert.match(text, /\$UPLOADER_SECRET/);
  assert.equal(text.includes("crsr_"), false);
  assert.equal(text.includes("Bearer sk-"), false);
});

test("attachAgentEnvVars drops CURSOR_ names and empty values", () => {
  const request = { prompt: { text: "hi" } };
  const withEnv = attachAgentEnvVars(request, {
    UPLOADER_SECRET: "uploader-secret-value",
    TG2TM_WORKER_BASE: "https://example.workers.dev",
    CURSOR_API_KEY: "should-not-pass",
    EMPTY: "",
  });
  assert.deepEqual(withEnv.envVars, {
    UPLOADER_SECRET: "uploader-secret-value",
    TG2TM_WORKER_BASE: "https://example.workers.dev",
  });
  assert.equal(attachAgentEnvVars(request, { CURSOR_API_KEY: "x" }).envVars, undefined);
});

test("readCreateAgentIds uses agent.url when present", () => {
  assert.deepEqual(
    readCreateAgentIds({
      agent: { id: "bc-1", url: "https://cursor.com/agents/bc-1" },
      run: { id: "run-1", status: "CREATING" },
    }),
    { agentId: "bc-1", runId: "run-1", agentUrl: "https://cursor.com/agents/bc-1" },
  );
  assert.throws(() => readCreateAgentIds({ agent: {}, run: {} }), /missing ids/);
});

test("terminal run status maps to a short Telegram summary", () => {
  assert.equal(isTerminalRunStatus("FINISHED"), true);
  assert.equal(isTerminalRunStatus("RUNNING"), false);
  assert.equal(isTerminalRunStatus("creating"), false);
  assert.equal(summaryForTerminalRun({ status: "FINISHED", result: "Очередь пуста." }), "Очередь пуста.");
  assert.match(summaryForTerminalRun({ status: "ERROR", agentUrl: "https://cursor.com/agents/bc-1" }), /ошибкой/);
  assert.match(summaryForTerminalRun({ status: "ERROR", agentUrl: "https://cursor.com/agents/bc-1" }), /bc-1/);
  assert.match(summaryForTerminalRun({ status: "CANCELLED" }), /отменён/);
  assert.match(summaryForTerminalRun({ status: "EXPIRED" }), /истёк/);
  assert.match(summaryForTerminalRun({ status: "FINISHED", result: "" }), /без текста/);
  const long = summaryForTerminalRun({ status: "FINISHED", result: "я".repeat(5000) });
  assert.ok(long.length <= 3900);
});

test("auth failure summaries name the HTTP status and not a response body", () => {
  assert.match(authFailureSummary(401), /401/);
  assert.match(authFailureSummary(401), /CURSOR_API_KEY/);
  assert.equal(authFailureSummary(401).includes("user@"), false);
  assert.match(authFailureSummary(403), /403/);
  assert.match(authFailureSummary(0), /не задан/);
  assert.match(authFailureSummary(500), /HTTP 500/);
});

test("pollGaveUpSummary distinguishes a live run from a failed read", () => {
  assert.match(pollGaveUpSummary({ sawRun: true, lastHttp: 200, agentUrl: "https://cursor.com/agents/bc-1" }), /ещё выполняется/);
  const failed = pollGaveUpSummary({ sawRun: false, lastHttp: 500, agentUrl: "https://cursor.com/agents/bc-1" });
  assert.match(failed, /HTTP 500/);
  assert.equal(failed.includes("ещё выполняется"), false);
});

test("polled summary is skipped only after the prompt is already done", () => {
  assert.equal(shouldPostPolledSummary("done"), false);
  assert.equal(shouldPostPolledSummary("DONE"), false);
  assert.equal(shouldPostPolledSummary("dispatched"), true);
  assert.equal(shouldPostPolledSummary(""), true);
});

test("poll delay backs off on 429 and stays under the default minute rate", () => {
  assert.equal(nextPollDelayMs(200), 20_000);
  assert.equal(nextPollDelayMs(429), 30_000);
});

test("redactSecrets removes credential values from a result", () => {
  const text = redactSecrets("token uploader-secret-value and cursor-key-value-xx", [
    "uploader-secret-value",
    "cursor-key-value-xx",
    "short",
  ]);
  assert.equal(text.includes("uploader-secret-value"), false);
  assert.equal(text.includes("cursor-key-value-xx"), false);
  assert.match(text, /\[redacted\]/);
});
