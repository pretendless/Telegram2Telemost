import assert from "node:assert/strict";
import test from "node:test";
import { buildProxyUrl } from "../telegram_fetch.mjs";

test("buildProxyUrl stays off unless PROXY_HOST is set", () => {
  assert.equal(buildProxyUrl({}), "");
  assert.equal(buildProxyUrl({ PROXY_HOST: "  " }), "");
  assert.equal(buildProxyUrl({ PROXY_LOGIN: "user", PROXY_PASSWORD: "secret" }), "");
});

test("buildProxyUrl adds http scheme and encodes credentials", () => {
  assert.equal(buildProxyUrl({ PROXY_HOST: "203.0.113.10:8080" }), "http://203.0.113.10:8080");
  assert.equal(
    buildProxyUrl({ PROXY_HOST: "203.0.113.10:8080", PROXY_LOGIN: "user", PROXY_PASSWORD: "p@ss" }),
    "http://user:p%40ss@203.0.113.10:8080",
  );
  assert.equal(
    buildProxyUrl({ PROXY_HOST: "socks5://203.0.113.10:1080", PROXY_LOGIN: "", PROXY_PASSWORD: "" }),
    "socks5://203.0.113.10:1080",
  );
  assert.throws(() => buildProxyUrl({ PROXY_HOST: "not a host" }), /proxy host/);
});
