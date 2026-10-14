// One Telemost browser session drains many KV queue packs: claim → fetch → upload → release (via /progress) → repeat.
//
// Priority policy (no preempt): finish the current pack (/done and progress terminal) before the next POST /queue/claim.
// New high-priority rows wait until the active uploading row is released. Matches claimNext() in the Worker.

import { spawnSync } from 'child_process';
import { join, dirname } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { claimQueueItem, postDrainComplete, queueCredentialsReadable } from './queue_client.mjs';
import { writeRequestPack } from './restart_prepare.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

export const DEFAULT_DRAIN_IDLE_MS = 90_000;
export const DEFAULT_DRAIN_POLL_MS = 5_000;

export const DRAIN_PRIORITY_POLICY =
  'Finish the current pack before claiming the next. Priority rows are ordered ahead of normal ones, but never preempt an in-flight upload.';

export function parseDrainIdleMs(raw, fallback = DEFAULT_DRAIN_IDLE_MS) {
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return fallback;
  return Math.min(Math.floor(n), 600_000);
}

export function parseDrainPollMs(raw, fallback = DEFAULT_DRAIN_POLL_MS) {
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 500) return fallback;
  return Math.min(Math.floor(n), 60_000);
}

/** After claim returned empty, keep polling until idleDeadline (queue may grow while the session runs). */
export function shouldWaitForQueue(idleDeadline, now) {
  return now < idleDeadline;
}

/** Pure plan for tests: when to stop idle polling. */
export function nextDrainWait({ claimed, queued, now, idleDeadline, idleMs, sawWork = false }) {
  if (claimed) return { action: 'upload', idleDeadline: null };
  if (queued > 0) return { action: 'claim-again', idleDeadline: null };
  if (!idleMs && !sawWork) return { action: 'stop', idleDeadline: null };
  const deadline = idleDeadline ?? now + idleMs;
  if (now >= deadline) return { action: 'stop', idleDeadline: deadline };
  return { action: 'wait', idleDeadline: deadline };
}

export function fetchPackImages(packDir, env = process.env) {
  const token = env.TELEGRAM_BOT_TOKEN || env.TG2TMBOT_TOKEN || '';
  if (!token) throw new Error('TELEGRAM_BOT_TOKEN is not set');
  const result = spawnSync('python3', ['scripts/fetch_and_convert.py', '--dir', packDir], {
    cwd: ROOT,
    env: { ...env, TELEGRAM_BOT_TOKEN: token },
    stdio: 'inherit',
  });
  if (result.status !== 0) throw new Error(`fetch failed for ${packDir}`);
}

/**
 * @param {object} ctx
 * @param {import('./telemost_upload.mjs').Bot} ctx.bot
 * @param {Function} ctx.note
 * @param {object} ctx.dirRef
 * @param {Function} ctx.uploadPack
 * @param {Function} [ctx.fetchImpl]
 * @param {Function} [ctx.sleep]
 * @param {Function} [ctx.now]
 */
export async function drainRemainingQueue(ctx) {
  const fetchImpl = ctx.fetchImpl || fetch;
  const sleep = ctx.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  const now = ctx.now || (() => Date.now());
  const progressUrl = process.env.TG2TM_PROGRESS_URL || '';
  const secret = process.env.UPLOADER_SECRET || '';
  if (!queueCredentialsReadable()) {
    console.log('queue-drain skipped: no UPLOADER_SECRET or TG2TM_PROGRESS_URL');
    return { packs: 0, reason: 'no-credentials' };
  }

  ctx.dirRef.sessionDrain = true;
  const idleMs = parseDrainIdleMs(process.env.TG2TM_DRAIN_IDLE_MS);
  const pollMs = parseDrainPollMs(process.env.TG2TM_DRAIN_POLL_MS);
  let idleDeadline = null;
  let packs = 0;
  let sawWork = false;

  for (;;) {
    let claim;
    try {
      claim = await claimQueueItem(fetchImpl, progressUrl, secret);
    } catch (err) {
      console.log('queue-drain claim failed', err && err.message);
      break;
    }
    const step = nextDrainWait({
      claimed: claim.claimed,
      queued: claim.queued,
      now: now(),
      idleDeadline,
      idleMs,
      sawWork,
    });
    if (step.action === 'wait') {
      idleDeadline = step.idleDeadline;
      await sleep(pollMs);
      continue;
    }
    if (step.action === 'stop') break;
    if (step.action === 'claim-again' && !claim.claimed) {
      await sleep(500);
      continue;
    }
    if (!claim.claimed) continue;

    sawWork = true;
    idleDeadline = null;
    const item = claim.claimed;
    const target = {
      title: item.title,
      requestId: item.id,
      links: item.links,
      chatId: item.chatId,
    };
    let slug;
    try {
      slug = writeRequestPack(target);
      fetchPackImages(join(ROOT, 'packs', slug));
      ctx.dirRef.dir = slug;
      ctx.dirRef.title = item.title;
      ctx.dirRef.queueRequestId = item.id;
      ctx.dirRef.requesterChatId = item.chatId || '';
      await ctx.uploadPack(ctx.bot, slug, {
        close: true,
        restart: true,
        note: ctx.note,
        dirRef: ctx.dirRef,
      });
      packs++;
    } catch (err) {
      const message = err && err.message ? err.message : String(err);
      console.log('queue-drain pack error', item.title, message);
      try {
        await ctx.note({
          phase: 'error',
          pack: item.title,
          error: message,
          index: 0,
          total: item.stickers || null,
        });
      } catch {
        console.log('queue-drain error progress skipped');
      }
      // Worker releases the row on terminal error progress; continue with the next claim.
    }
  }

  try {
    await postDrainComplete(fetchImpl, progressUrl, secret);
  } catch (err) {
    console.log('queue-drain complete signal failed', err && err.message);
  }
  return { packs, reason: packs ? 'drained' : 'idle' };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  console.error('queue_drain.mjs is imported from telemost_upload.mjs, not run directly');
  process.exit(2);
}
