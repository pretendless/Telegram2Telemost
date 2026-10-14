import assert from "node:assert/strict";
import test from "node:test";
import { describeAgentsCheck, describeMeCheck } from "./check_cursor_api.mjs";

test("describeMeCheck reports status and apiKeyName without email or body", () => {
  const line = describeMeCheck(200, {
    apiKeyName: "personal",
    userEmail: "owner@example.com",
    authorization: "Bearer secret-value",
  });
  assert.equal(line, "GET /v1/me status=200 apiKeyName=present");
  assert.equal(line.includes("owner@example.com"), false);
  assert.equal(line.includes("secret-value"), false);
  assert.equal(line.includes("Bearer"), false);
  assert.equal(describeMeCheck(401, { message: "invalid", userEmail: "owner@example.com" }), "GET /v1/me status=401 apiKeyName=absent");
});

test("describeAgentsCheck reports whether items is an array", () => {
  assert.equal(describeAgentsCheck(200, { items: [] }), "GET /v1/agents?limit=1 status=200 items=present");
  assert.equal(
    describeAgentsCheck(200, { items: [{ id: "bc-1", name: "hidden" }], userEmail: "owner@example.com" }),
    "GET /v1/agents?limit=1 status=200 items=present",
  );
  assert.equal(describeAgentsCheck(500, { error: "nope" }), "GET /v1/agents?limit=1 status=500 items=absent");
});
