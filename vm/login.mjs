// Open Yandex ID, send the QR (and a one-time noVNC link) to Telegram, save the session.
// Usage inside the container: node vm/login.mjs login|restore|save|notify [kind]
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { adminNoticeChatIds } from "../scripts/admin_status.mjs";
import { connect, sleep } from "../scripts/chrome_cdp.mjs";
import { checkInputs } from "./inputs.mjs";
import { linkText, qrCaption, resultText } from "./messages.js";
import { safePublicUrl } from "./public_url.js";
import { pickQrRect } from "./qr.js";
import {
  assertPassphrase,
  cdpCookie,
  cookieNames,
  decryptSession,
  encryptSession,
  filterYandexCookies,
  isLoggedIn,
  safeOrigin,
} from "./session.mjs";
import { failureStepName, writeStepFailure } from "./step_failure.mjs";

export const PASSPORT_URL = "https://passport.yandex.ru/auth?mode=qr";
export const DEFAULT_BOT_URL = "https://telemost.yandex.ru/user/fe21ed07-748c-969d-7459-b4e06d03e84d";

const quiet = () => process.env.GITHUB_ACTIONS === "true";

export function sessionPath(dir, account) {
  return join(dir, `${account}.tg2tm-session`);
}

export function writeSession(file, bundle, passphrase) {
  const bytes = encryptSession(bundle, passphrase);
  writeFileSync(file, bytes, { mode: 0o600 });
}

export function readSession(file, passphrase) {
  return decryptSession(readFileSync(file), passphrase);
}

export function documentMatchesOrigin(current, wanted) {
  return Boolean(wanted) && String(current || "") === wanted;
}

// localStorage throws SecurityError on about:blank and on Chrome's error page.
// Catch it in the page so a restore keeps going on cookies alone.
export function storageReadExpression() {
  return `(() => { try { return Object.entries(localStorage); } catch (err) { return { denied: (err && err.name ? err.name + ": " : "") + (err && err.message ? err.message : String(err)) }; } })()`;
}

export function storageWriteExpression(entries) {
  const pairs = JSON.stringify(entries);
  return `(() => { const pairs = ${pairs}; try { for (const pair of pairs) localStorage.setItem(pair[0], pair[1]); return pairs.length; } catch (err) { return { denied: (err && err.name ? err.name + ": " : "") + (err && err.message ? err.message : String(err)) }; } })()`;
}

export function storageDenied(result) {
  if (!result || typeof result !== "object" || Array.isArray(result) || !result.denied) return "";
  return String(result.denied);
}

async function telegram(method, token, chatId, payload, fetchImpl) {
  if (!token || !chatId) return { ok: false, skipped: true };
  const init = { method: "POST", body: payload };
  if (!(typeof FormData !== "undefined" && payload instanceof FormData)) {
    init.headers = { "content-type": "application/json" };
  }
  const res = await fetchImpl(`https://api.telegram.org/bot${token}/${method}`, init);
  if (!res.ok) console.error("telegram", method, res.status);
  return { ok: res.ok, status: res.status };
}

export function makeIo({ token, chatId, noticeIds, file, passphrase, account, fetchImpl = fetch }) {
  const notices = (noticeIds && noticeIds.length ? noticeIds : [chatId]).map((id) => String(id || "")).filter(Boolean);
  return {
    async qr(png, n) {
      const form = new FormData();
      form.set("chat_id", String(chatId));
      form.set("caption", qrCaption(account, n));
      const bytes = png instanceof Uint8Array ? png : Buffer.from(png);
      form.set("photo", new Blob([bytes], { type: "image/png" }), "qr.png");
      const sent = await telegram("sendPhoto", token, chatId, form, fetchImpl);
      if (sent.skipped) {
        const dest = join(dirname(file), "last-qr.png");
        writeFileSync(dest, bytes);
        if (!quiet()) console.log("QR written to", dest);
      } else if (!quiet()) console.log("qr sent", n);
      return sent;
    },
    async link(origin, password) {
      const text = linkText(origin, password);
      if (!text) return { ok: false, skipped: true };
      if (!quiet()) console.log("noVNC link ready");
      return telegram(
        "sendMessage",
        token,
        chatId,
        JSON.stringify({ chat_id: chatId, text, link_preview_options: { is_disabled: true } }),
        fetchImpl,
      );
    },
    async result(kind) {
      const text = resultText(kind, account);
      if (!quiet()) console.log(kind, account);
      if (!token || !notices.length) return { ok: false, skipped: true };
      let last = { ok: false, skipped: true };
      for (const id of notices) {
        last = await telegram(
          "sendMessage",
          token,
          id,
          JSON.stringify({ chat_id: id, text, link_preview_options: { is_disabled: true } }),
          fetchImpl,
        );
      }
      return last;
    },
    async save(bundle) {
      mkdirSync(join(file, ".."), { recursive: true });
      writeSession(file, bundle, passphrase);
      if (!quiet()) console.log("session saved", cookieNames(bundle.cookies).join(","));
    },
  };
}

export async function loginLoop(page, io, opts) {
  const deadline = opts.now() + opts.timeoutMs;
  const pollMs = opts.pollMs ?? 3000;
  const maxQr = opts.maxQr ?? 8;
  const seen = new Set();
  let triedButton = false;
  const origin = safePublicUrl(opts.publicUrl || "");
  if (origin) await io.link(origin, opts.vncPassword || "");

  await page.goto(opts.passportUrl);
  while (opts.now() < deadline) {
    const cookies = filterYandexCookies(await page.cookies());
    if (isLoggedIn(cookies)) {
      const passportStore = await page.collectStorage();
      const telemost = await page.openTelemost(opts.botUrl);
      const telemostStore = await page.collectStorage();
      const bundle = {
        v: 1,
        account: opts.account,
        savedAt: new Date(opts.now()).toISOString(),
        cookies,
        origins: [...passportStore, ...telemostStore].filter((row) => safeOrigin(row.origin)),
        telemost: telemost.composer ? "ready" : "connecting",
      };
      await io.save(bundle);
      await io.result(telemost.composer ? "ready" : "connecting");
      return { ok: true, telemost };
    }
    const rect = await page.qrRect();
    if (rect && seen.size < maxQr) {
      const png = await page.screenshot(rect);
      const hash = createHash("sha256").update(png).digest("hex");
      if (!seen.has(hash)) {
        seen.add(hash);
        await io.qr(png, seen.size);
      }
    } else if (!rect && !triedButton && page.clickQrButton) {
      triedButton = true;
      await page.clickQrButton();
    }
    await opts.sleep(pollMs);
  }
  await io.result("timeout");
  return { ok: false, reason: "timeout" };
}

export async function restoreLoop(page, bundle, opts) {
  if (!bundle || !isLoggedIn(bundle.cookies)) return { ok: false, reason: "no-session" };
  await page.setCookies(bundle.cookies.map(cdpCookie));
  for (const row of bundle.origins || []) {
    const origin = safeOrigin(row.origin);
    if (!origin) continue;
    const landed = await page.goto(origin + "/");
    if (landed && landed.ready === false) {
      console.error("storage skipped", origin);
      continue;
    }
    const stored = await page.setStorage(row.entries || []);
    if (stored && stored.denied) console.error("storage skipped", origin, stored.denied);
  }
  const telemost = await page.openTelemost(opts.botUrl);
  return { ok: Boolean(telemost.composer), telemost, reason: telemost.composer ? "ready" : "connecting" };
}

export async function saveCurrent(page, opts) {
  const cookies = filterYandexCookies(await page.cookies());
  if (!isLoggedIn(cookies)) return { ok: false, reason: "no-session" };
  const origins = (await page.collectStorage()).filter((row) => safeOrigin(row.origin));
  await opts.save({
    v: 1,
    account: opts.account,
    savedAt: new Date(opts.now()).toISOString(),
    cookies,
    origins,
    telemost: "saved",
  });
  return { ok: true };
}

function trimEntries(entries) {
  if (!Array.isArray(entries)) return [];
  return entries
    .filter((pair) => Array.isArray(pair) && pair.length >= 2)
    .map((pair) => [String(pair[0]).slice(0, 200), String(pair[1]).slice(0, 8000)])
    .filter((pair) => pair[0] && pair[1].length < 8000)
    .slice(0, 40);
}

export async function attachPage() {
  let last;
  for (let i = 0; i < 25; i++) {
    try {
      const c = await connect(() => true);
      await c.send("Page.enable").catch(() => {});
      await c.send("Network.enable").catch(() => {});
      await c.send("Emulation.setDeviceMetricsOverride", {
        width: 1280,
        height: 800,
        deviceScaleFactor: 1,
        mobile: false,
      }).catch(() => {});
      return {
        async goto(url) {
          let origin = "";
          try {
            origin = new URL(url).origin;
          } catch {
            origin = "";
          }
          await c.send("Page.navigate", { url });
          for (let n = 0; n < 40; n++) {
            let here = "";
            try {
              here = await c.ev("location.origin");
            } catch {
              here = "";
            }
            if (documentMatchesOrigin(here, origin)) return { origin, ready: true };
            await sleep(500);
          }
          return { origin, ready: false };
        },
        async cookies() {
          const result = await c.send("Network.getCookies");
          return result.cookies || [];
        },
        async setCookies(cookies) {
          if (!cookies.length) return;
          await c.send("Network.setCookies", { cookies });
        },
        async qrRect() {
          const boxes = await c.ev(`(() => [...document.querySelectorAll('canvas, img, svg')].map(el => {
            const r = el.getBoundingClientRect();
            return { x: r.x, y: r.y, w: r.width, h: r.height };
          }))()`);
          return pickQrRect(boxes || []);
        },
        async screenshot(rect) {
          const shot = await c.send("Page.captureScreenshot", {
            format: "png",
            fromSurface: true,
            clip: { x: rect.x, y: rect.y, width: rect.width, height: rect.height, scale: 1 },
          });
          return Buffer.from(shot.data, "base64");
        },
        async clickQrButton() {
          return c.ev(`(() => {
            const el = [...document.querySelectorAll('button, a, [role=button]')].find(e => /qr/i.test(e.innerText || e.getAttribute('aria-label') || ''));
            if (!el) return false;
            el.click();
            return true;
          })()`);
        },
        async collectStorage() {
          const origin = await c.ev("location.origin").catch(() => "");
          const entries = await c.ev(storageReadExpression());
          const denied = storageDenied(entries);
          if (denied) {
            console.error("storage skipped", denied);
            return [];
          }
          if (!origin || origin === "null") return [];
          return [{ origin, entries: trimEntries(entries) }];
        },
        async setStorage(entries) {
          const pairs = trimEntries(entries);
          if (!pairs.length) return { wrote: 0 };
          const wrote = await c.ev(storageWriteExpression(pairs));
          const denied = storageDenied(wrote);
          if (denied) return { wrote: 0, denied };
          return { wrote: Number(wrote) || 0 };
        },
        async openTelemost(url) {
          await c.send("Page.navigate", { url });
          let composer = false;
          let connecting = false;
          for (let n = 0; n < 60; n++) {
            await sleep(500);
            composer = Boolean(await c.ev(`!!document.querySelector('[contenteditable=true]')`));
            const text = await c.ev(`(document.body && document.body.innerText || '').slice(0, 400)`);
            connecting = /Подключение/.test(text || "") && !composer;
            if (composer) break;
          }
          return { composer, connecting };
        },
        close: () => c.close(),
      };
    } catch (err) {
      last = err;
      await sleep(400);
    }
  }
  throw last || new Error("chrome did not open");
}

async function main() {
  const cmd = process.argv[2] || "login";
  const checked = checkInputs(process.env);
  if (!checked.ok) {
    console.error(`bad input: ${checked.error}`);
    process.exit(1);
  }
  const dir = process.env.SESSION_DIR || "sessions";
  mkdirSync(dir, { recursive: true });
  const file = sessionPath(dir, checked.account);
  const token = process.env.TG2TMBOT_TOKEN || "";
  const chatId = checked.chat_id;
  const passphrase = process.env.TELEMOST_SESSION_KEY || "";
  const noticeIds = adminNoticeChatIds(chatId, process.env.LOGIN_CHAT_IDS || "");
  const io = makeIo({ token, chatId, noticeIds, file, passphrase, account: checked.account });

  if (cmd === "notify") {
    if (!token || !chatId) {
      console.error("Set TG2TMBOT_TOKEN and chat_id.");
      process.exit(1);
    }
    const sent = await io.result(process.argv[3] || "no-session");
    process.exit(sent.ok ? 0 : 1);
  }
  if (!assertPassphrase(passphrase)) {
    console.error("Set TELEMOST_SESSION_KEY to a long random string (at least 32 characters).");
    process.exit(1);
  }

  const page = await attachPage();
  const botUrl = process.env.TELEMOST_BOT_URL || DEFAULT_BOT_URL;
  try {
    if (cmd === "login") {
      const result = await loginLoop(page, io, {
        account: checked.account,
        passportUrl: PASSPORT_URL,
        botUrl,
        publicUrl: process.env.PUBLIC_NOVNC_URL || "",
        vncPassword: process.env.NOVNC_PASSWORD || "",
        timeoutMs: Number(process.env.LOGIN_TIMEOUT_S || 600) * 1000,
        now: () => Date.now(),
        sleep,
      });
      process.exitCode = result.ok ? 0 : 1;
    } else if (cmd === "restore") {
      let bundle = null;
      try {
        bundle = readSession(file, passphrase);
      } catch (err) {
        console.error(err.message === "session key does not match" ? err.message : "no session");
      }
      if (!bundle) {
        noteStepFailure("restore", "нет сессии");
        await io.result("no-session");
        process.exitCode = 2;
      } else {
        const result = await restoreLoop(page, bundle, { botUrl });
        if (!result.ok) {
          noteStepFailure(
            "restore",
            result.reason === "connecting" ? "Telemost открылся без поля ввода" : (result.reason || "сессия не открылась"),
          );
        }
        await io.result(result.ok ? "upload-ready" : "connecting");
        process.exitCode = result.ok ? 0 : 1;
      }
    } else if (cmd === "save") {
      const result = await saveCurrent(page, {
        account: checked.account,
        now: () => Date.now(),
        save: (bundle) => io.save(bundle),
      });
      process.exitCode = result.ok ? 0 : 1;
    } else {
      console.error("usage: login | restore | save | notify");
      process.exitCode = 1;
    }
  } finally {
    page.close();
  }
}

function noteStepFailure(cmd, error) {
  try {
    writeStepFailure(process.env.STEP_FAILURE_DIR || "logs", {
      step: failureStepName(cmd, process.env.MODE || ""),
      error,
      runId: process.env.GITHUB_RUN_ID || "",
    });
  } catch {
    // The admin card falls back to the generic line when the note cannot be written.
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    const error = err && err.message ? err.message : "login failed";
    noteStepFailure(process.argv[2] || "login", error);
    console.error(error);
    process.exit(1);
  });
}
