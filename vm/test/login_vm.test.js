import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { buildDispatch, dispatchWorkflow, parseVmCommand } from "../dispatch.js";
import { checkInputs } from "../inputs.mjs";
import { loginLoop, makeIo, restoreLoop, writeSession } from "../login.mjs";
import { linkText, qrCaption } from "../messages.js";
import { safePublicUrl, tunnelUrlFromLog, vncPage } from "../public_url.js";
import { pickQrRect } from "../qr.js";
import { artifactName, findSessionFile, latestArtifact, restoreArtifact } from "../restore_artifact.mjs";
import {
  cookieNames,
  decryptSession,
  encryptSession,
  filterYandexCookies,
  isLoggedIn,
} from "../session.mjs";
import { handleVmCommand } from "../worker_login.js";

const KEY = "test-only-passphrase-not-a-real-secret-value";
const SECRET = "super-secret-session-value";

function yandexCookies() {
  return [
    { name: "Session_id", value: SECRET, domain: ".yandex.ru", path: "/", secure: true, httpOnly: true, expires: 2_000_000_000 },
    { name: "sessionid2", value: "second-cookie-value", domain: ".yandex.ru", path: "/", secure: true, httpOnly: true, expires: 2_000_000_000 },
    { name: "SID", value: "not-ours", domain: ".google.com", path: "/" },
  ];
}

test("commands parse login, connect and upload", () => {
  assert.deepEqual(parseVmCommand("/login"), { mode: "login", account: "default", packs: "" });
  assert.deepEqual(parseVmCommand("/login@tg2tmbot work"), { mode: "login", account: "work", packs: "" });
  assert.deepEqual(parseVmCommand("/connect work"), { mode: "login", account: "work", packs: "" });
  assert.equal(parseVmCommand("/connect").error, "label");
  assert.deepEqual(parseVmCommand("/upload work 03 04"), { mode: "upload", account: "work", packs: "03 04" });
  assert.equal(parseVmCommand("/upload work").error, "upload");
  assert.equal(parseVmCommand("/upload work ../01").error, "packs");
  assert.equal(parseVmCommand("hello"), null);
});

test("inputs reject shell metacharacters and require packs for upload", () => {
  assert.equal(checkInputs({ ACCOUNT: "../etc", MODE: "login" }).ok, false);
  assert.equal(checkInputs({ MODE: "upload", ACCOUNT: "work", PACKS: "03;rm" }).ok, false);
  assert.equal(checkInputs({ MODE: "upload", ACCOUNT: "work", PACKS: "" }).error, "packs");
  assert.equal(checkInputs({ MODE: "login", REQUIRE_CHAT: "1" }).error, "chat_id");
  assert.equal(checkInputs({ MODE: "restart", ACCOUNT: "default", CHAT_ID: "8502935020", PACKS: "" }).ok, true);
  assert.equal(checkInputs({ MODE: "restart-peek", ACCOUNT: "default", CHAT_ID: "8502935020", PACKS: "" }).ok, true);
  assert.equal(checkInputs({ MODE: "restart-peek;rm", ACCOUNT: "default", PACKS: "" }).error, "mode");
  const ok = checkInputs({ MODE: "upload", ACCOUNT: "work", PACKS: "03 04", CHAT_ID: "-100" });
  assert.deepEqual(ok, { ok: true, mode: "upload", account: "work", chat_id: "-100", packs: "03 04" });
});

test("dispatch body stays on the workflow API and omits the token", async () => {
  let seen;
  const result = await dispatchWorkflow(
    async (url, init) => {
      seen = { url, init };
      return { status: 204 };
    },
    {
      token: "ghp_example",
      repo: "pretendless/tg2tm",
      workflow: "telemost-session.yml",
      ref: "main",
      mode: "login",
      account: "work",
      chatId: 42,
      packs: "",
    },
  );
  assert.equal(result.ok, true);
  assert.equal(seen.url, "https://api.github.com/repos/pretendless/tg2tm/actions/workflows/telemost-session.yml/dispatches");
  assert.equal(seen.init.headers.authorization, "Bearer ghp_example");
  const body = JSON.parse(seen.init.body);
  assert.equal(body.ref, "main");
  assert.equal(body.inputs.account, "work");
  assert.equal(body.inputs.chat_id, "42");
  assert.equal(JSON.stringify(body).includes("ghp_example"), false);
  assert.throws(() => buildDispatch({ repo: "a/b", workflow: "telemost-session.yml", ref: "../main", mode: "login", account: "work", chatId: 1, packs: "" }));
});

test("only an allowlisted chat can start the browser", async () => {
  const sent = [];
  let fetched = 0;
  const env = { LOGIN_CHAT_IDS: "42, 77", GH_DISPATCH_TOKEN: "token", GH_REPO: "pretendless/tg2tm", TELEMOST_VM_REF: "main" };
  const deps = {
    send: async (_env, chatId, text) => sent.push({ chatId, text }),
    fetch: async () => {
      fetched += 1;
      return { status: 204 };
    },
  };
  assert.equal(await handleVmCommand(env, { text: "/login", chat: { id: 99 } }, deps), true);
  assert.equal(fetched, 0);
  assert.match(sent[0].text, /владельца/);
  sent.length = 0;
  assert.equal(await handleVmCommand(env, { text: "/connect", chat: { id: 42 } }, deps), true);
  assert.equal(fetched, 0);
  assert.match(sent[0].text, /connect work/);
  assert.equal(await handleVmCommand({ ...env, GH_DISPATCH_TOKEN: "" }, { text: "/login work", chat: { id: 42 } }, deps), true);
  assert.equal(fetched, 0);
  assert.equal(await handleVmCommand(env, { text: "/login work", chat: { id: 42 } }, deps), true);
  assert.equal(fetched, 1);
  assert.match(sent.at(-1).text, /QR-код/);
  assert.equal(sent.at(-1).text.includes("token"), false);
});

test("an empty allowlist does not dispatch", async () => {
  let fetched = 0;
  const sent = [];
  await handleVmCommand(
    { LOGIN_CHAT_IDS: "", GH_DISPATCH_TOKEN: "token" },
    { text: "/login", chat: { id: 1 } },
    {
      send: async (_e, _c, text) => sent.push(text),
      fetch: async () => {
        fetched += 1;
        return { status: 204 };
      },
    },
  );
  assert.equal(fetched, 0);
  assert.match(sent[0], /владельца/);
});

test("yandex cookies are kept and a login needs both session cookies", () => {
  const kept = filterYandexCookies(yandexCookies());
  assert.deepEqual(cookieNames(yandexCookies()), ["Session_id", "sessionid2"]);
  assert.equal(kept.some((cookie) => cookie.domain.includes("google")), false);
  assert.equal(isLoggedIn(yandexCookies()), true);
  assert.equal(isLoggedIn(yandexCookies().filter((cookie) => cookie.name !== "sessionid2")), false);
  assert.equal(isLoggedIn([{ name: "Session_id", value: "short", domain: ".yandex.ru" }]), false);
});

test("the session file is ciphertext and the wrong key does not open it", () => {
  const bundle = { v: 1, account: "work", cookies: filterYandexCookies(yandexCookies()), origins: [] };
  const bytes = encryptSession(bundle, KEY);
  assert.equal(bytes.subarray(0, 6).toString(), "TG2TM1");
  assert.equal(bytes.includes(Buffer.from(SECRET)), false);
  const back = decryptSession(bytes, KEY);
  assert.equal(back.cookies.find((cookie) => cookie.name === "Session_id").value, SECRET);
  const tampered = Buffer.from(bytes);
  tampered[tampered.length - 1] ^= 1;
  assert.throws(() => decryptSession(tampered, KEY), /session key does not match/);
  assert.throws(() => decryptSession(bytes, `${KEY}-other-characters-pad`), /session key does not match/);
  assert.equal(assertPassphraseShort(), false);
});

function assertPassphraseShort() {
  try {
    encryptSession({ v: 1, cookies: [] }, "short");
    return true;
  } catch {
    return false;
  }
}

test("QR crop prefers the square code over a banner", () => {
  const rect = pickQrRect([
    { x: 0, y: 0, w: 500, h: 40 },
    { x: 12.2, y: 40.4, w: 180, h: 176 },
    { x: 1, y: 1, w: 20, h: 20 },
  ]);
  assert.deepEqual(rect, { x: 12, y: 40, width: 180, height: 176 });
  assert.equal(pickQrRect([{ x: 0, y: 0, w: 10, h: 10 }]), null);
});

test("public link is https and the tunnel log yields an origin", () => {
  assert.equal(safePublicUrl("http://example.com"), "");
  assert.equal(safePublicUrl("https://user:pw@example.com"), "");
  const log = "INF |  https://random-name.trycloudflare.com  |";
  assert.equal(tunnelUrlFromLog(log), "https://random-name.trycloudflare.com");
  assert.match(vncPage(tunnelUrlFromLog(log)), /\/vnc\.html\?autoconnect=1/);
  assert.match(linkText("https://random-name.trycloudflare.com", "pw"), /Пароль: pw/);
  assert.equal(linkText("http://bad", "pw"), "");
});

test("login loop sends one QR then stores a ciphertext session", async () => {
  const dir = mkdtempSync(join(tmpdir(), "tg2tm-"));
  const file = join(dir, "work.tg2tm-session");
  let ticks = 0;
  const clock = { t: 1_700_000_000_000 };
  const qrs = [];
  const page = {
    async goto() {},
    async cookies() {
      return ticks >= 1 ? yandexCookies() : [];
    },
    async qrRect() {
      return { x: 8, y: 8, w: 160, h: 160 };
    },
    async screenshot() {
      ticks += 1;
      return Buffer.from(`png-${ticks}`);
    },
    async collectStorage() {
      return [{ origin: "https://passport.yandex.ru", entries: [["k", "v"]] }];
    },
    async openTelemost() {
      return { composer: true, connecting: false };
    },
  };
  const io = makeIo({ token: "", chatId: "", file, passphrase: KEY, account: "work" });
  const originalQr = io.qr;
  io.qr = async (png, n) => {
    qrs.push(n);
    return originalQr(png, n);
  };
  const result = await loginLoop(page, io, {
    account: "work",
    passportUrl: "https://passport.yandex.ru/auth?mode=qr",
    botUrl: "https://telemost.yandex.ru/",
    publicUrl: "https://random-name.trycloudflare.com",
    vncPassword: "local-password",
    timeoutMs: 20_000,
    now: () => clock.t,
    sleep: async () => {
      clock.t += 3000;
    },
  });
  assert.equal(result.ok, true);
  assert.deepEqual(qrs, [1]);
  const saved = readFileSync(file);
  assert.equal(saved.includes(Buffer.from(SECRET)), false);
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.equal(decryptSession(saved, KEY).account, "work");
  assert.equal(readFileSync(join(dir, "last-qr.png")).equals(Buffer.from("png-1")), true);
  rmSync(dir, { recursive: true });
});

test("login loop reports timeout without writing a session", async () => {
  const clock = { t: 0 };
  let saved = 0;
  const kinds = [];
  const result = await loginLoop(
    {
      async goto() {},
      async cookies() {
        return [];
      },
      async qrRect() {
        return null;
      },
      async clickQrButton() {
        return false;
      },
    },
    {
      async link() {},
      async qr() {},
      async result(kind) {
        kinds.push(kind);
      },
      async save() {
        saved += 1;
      },
    },
    {
      account: "work",
      passportUrl: "https://passport.yandex.ru/auth?mode=qr",
      botUrl: "https://telemost.yandex.ru/",
      timeoutMs: 1000,
      now: () => clock.t,
      sleep: async () => {
        clock.t += 5000;
      },
    },
  );
  assert.equal(result.ok, false);
  assert.equal(saved, 0);
  assert.deepEqual(kinds, ["timeout"]);
});

test("restore injects cookies and waits for the Telemost composer", async () => {
  const seen = [];
  const result = await restoreLoop(
    {
      async setCookies(cookies) {
        seen.push(cookies.map((cookie) => cookie.name).sort());
      },
      async goto(url) {
        seen.push(url);
      },
      async setStorage(entries) {
        seen.push(entries.length);
      },
      async openTelemost() {
        return { composer: false, connecting: true };
      },
    },
    {
      v: 1,
      cookies: filterYandexCookies(yandexCookies()),
      origins: [{ origin: "https://passport.yandex.ru", entries: [["k", "v"]] }],
    },
    { botUrl: "https://telemost.yandex.ru/user/bot" },
  );
  assert.equal(result.ok, false);
  assert.equal(result.reason, "connecting");
  assert.deepEqual(seen[0], ["Session_id", "sessionid2"]);
  assert.equal(seen[1], "https://passport.yandex.ru/");
});

test("artifact restore keeps the newest ciphertext and follows the zip redirect without the token", async () => {
  assert.equal(
    latestArtifact(
      [
        { id: 1, name: "telemost-session-work", expired: false, created_at: "2026-10-01T00:00:00Z" },
        { id: 2, name: "telemost-session-work", expired: false, created_at: "2026-10-12T00:00:00Z" },
        { id: 3, name: "telemost-session-work", expired: true, created_at: "2026-10-13T00:00:00Z" },
      ],
      artifactName("work"),
    ).id,
    2,
  );
  const dir = mkdtempSync(join(tmpdir(), "tg2tm-art-"));
  const payload = Buffer.from("ciphertext-bytes");
  const calls = [];
  const result = await restoreArtifact(
    { ACCOUNT: "work", SESSION_DIR: dir, GH_TOKEN: "job-token", GH_REPO: "pretendless/tg2tm" },
    {
      workdir: join(dir, "work"),
      unzip: async (buffer, root) => {
        const { mkdirSync } = await import("node:fs");
        const out = join(root, "unzipped");
        mkdirSync(out, { recursive: true });
        writeFileSync(join(out, "work.tg2tm-session"), buffer);
        return out;
      },
      fetch: async (url, init) => {
        calls.push({ url, authorization: init.headers && init.headers.authorization });
        if (url.endsWith("/zip")) {
          return { status: 302, ok: false, headers: { get: () => "https://objects.example/signed" } };
        }
        if (url === "https://objects.example/signed") {
          return { status: 200, ok: true, arrayBuffer: async () => payload };
        }
        return {
          status: 200,
          ok: true,
          json: async () => ({
            artifacts: [{ id: 2, name: "telemost-session-work", expired: false, created_at: "2026-10-12T00:00:00Z" }],
          }),
        };
      },
    },
  );
  assert.equal(result.ok, true);
  assert.equal(result.source, "artifact");
  assert.equal(readFileSync(result.path).equals(payload), true);
  assert.equal(calls[1].authorization, "Bearer job-token");
  assert.equal(calls[2].authorization, undefined);
  assert.equal(findSessionFile(join(dir, "work"), "work").endsWith("work.tg2tm-session"), true);
  rmSync(dir, { recursive: true });
});

test("QR caption names the account and not a cookie", () => {
  assert.match(qrCaption("work", 2), /аккаунт «work», код 2/);
  assert.equal(qrCaption("work", 2).includes(SECRET), false);
});

test("writeSession refuses a short key", () => {
  const dir = mkdtempSync(join(tmpdir(), "tg2tm-key-"));
  assert.throws(() => writeSession(join(dir, "a.tg2tm-session"), { v: 1, cookies: [] }, "short"));
  rmSync(dir, { recursive: true });
});
