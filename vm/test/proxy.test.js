import assert from "node:assert/strict";
import test from "node:test";
import { proxyFlag } from "../proxy.mjs";

test("the proxy stays off unless a host is set", () => {
  assert.equal(proxyFlag({}), "");
  assert.equal(proxyFlag({ PROXY_HOST: "  " }), "");
  assert.equal(proxyFlag({ PROXY_LOGIN: "user", PROXY_PASSWORD: "secret" }), "");
  assert.equal(proxyFlag({ PROXY_HOST: "203.0.113.10:8080" }), "--proxy-server=203.0.113.10:8080");
  assert.equal(
    proxyFlag({ PROXY_HOST: "socks5://203.0.113.10:1080", PROXY_LOGIN: "", PROXY_PASSWORD: "" }),
    "--proxy-server=socks5://203.0.113.10:1080",
  );
  assert.throws(() => proxyFlag({ PROXY_HOST: "not a host" }), /proxy host/);
});
