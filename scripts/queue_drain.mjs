// One Telemost browser session drains many KV queue packs: claim → fetch → upload → release (via /progress) → repeat.
//
// Priority policy (no preempt): finish the current pack (/done and progress terminal) before the next POST /queue/claim.
// New high-priority rows wait until the active uploading row is released. Matches claimNext() in the Worker.

import { spawnSync } from 'child_process';
import { join, dirname } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { actionsRunUrl, clearPackProgress } from './admin_status.mjs';
import { claimQueueItem, postDrainComplete, queueCredentialsReadable } from './queue_client.mjs';
import { writeRequestPack } from './restart_prepare.mjs';
import { POST_SAVE_STEP_MS, POST_SAVE_STEPS, isStepTimeout, withStepTimeout } from './step_timeout.mjs';

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
/** A request this session already finished must not be /newpack'd again. */
export function drainClaimAction(claimed, finishedIds) {
  if (!claimed || !claimed.id) return 'idle';
  if (finishedIds && finishedIds.has(String(claimed.id))) return 'skip-finished';
  return 'upload';
}

export function nextDrainWait({ claimed, queued, now, idleDeadline, idleMs, sawWork = false }) {
  if (claimed) return { action: 'upload', idleDeadline: null };
  if (queued > 0) return { action: 'claim-again', idleDeadline: null };
  if (!idleMs && !sawWork) return { action: 'stop', idleDeadline: null };
  const deadline = idleDeadline ?? now + idleMs;
  if (now >= deadline) return { action: 'stop', idleDeadline: deadline };
  return { action: 'wait', idleDeadline: deadline };
}

function collapse(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function spawnText(value) {
  if (value == null) return '';
  return Buffer.isBuffer(value) ? value.toString('utf8') : String(value);
}

/** Last traceback line plus exit code / spawn errno. Empty when the child succeeded. */
export function spawnFailureDetail(result) {
  if (!result) return { cause: '', code: '' };
  if (result.error) {
    return {
      cause: collapse(result.error.message || result.error),
      code: result.error.code ? String(result.error.code) : '',
    };
  }
  const stderr = spawnText(result.stderr);
  const stdout = spawnText(result.stdout);
  const lines = (stderr || stdout).split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  let code = '';
  if (result.status != null) code = `exit ${result.status}`;
  else if (result.signal) code = `signal ${result.signal}`;
  return { cause: collapse(lines.length ? lines[lines.length - 1] : ''), code };
}

/**
 * One line an admin can paste: path, slug, sticker index, exit code, and the underlying error.
 * Capped so the status card keeps the cause inside its 300-character error line.
 */
export function formatPackFetchError({ packDir = '', index = null, total = null, cause = '', code = '' } = {}) {
  const path = String(packDir || '').trim();
  const slug = path.split(/[/\\]/).filter(Boolean).pop() || '';
  const parts = [`fetch failed for ${path || '(no path)'}`];
  if (slug) parts.push(`slug ${slug}`);
  if (index != null && index !== '' && total != null && total !== '') {
    const n = Number(index);
    const all = Number(total);
    if (Number.isFinite(n) && Number.isFinite(all)) parts.push(`стикер ${n} из ${all}`);
  }
  const status = collapse(code);
  const why = collapse(cause);
  let text = parts.join(' | ');
  if (status || why) text += ': ' + [status, why].filter(Boolean).join(': ');
  return text.slice(0, 300);
}

export function fetchPackImages(packDir, env = process.env, opts = {}) {
  const token = env.TELEGRAM_BOT_TOKEN || env.TG2TMBOT_TOKEN || '';
  if (!token) throw new Error('TELEGRAM_BOT_TOKEN is not set');
  const spawn = opts.spawn || spawnSync;
  const result = spawn('python3', ['scripts/fetch_and_convert.py', '--dir', packDir], {
    cwd: opts.cwd || ROOT,
    env: { ...env, TELEGRAM_BOT_TOKEN: token, PYTHONUNBUFFERED: '1' },
    encoding: 'utf8',
    stdio: ['inherit', 'pipe', 'pipe'],
  });
  if (result && result.stdout) process.stdout.write(result.stdout);
  if (result && result.stderr) process.stderr.write(result.stderr);
  if (!result || result.status !== 0) {
    const detail = spawnFailureDetail(result);
    throw new Error(formatPackFetchError({
      packDir,
      index: opts.index,
      total: opts.total,
      cause: detail.cause,
      code: detail.code,
    }));
  }
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
  const finishedIds = new Set();

  for (;;) {
    clearPackProgress(ctx.dirRef);
    let claim;
    try {
      claim = await withStepTimeout(
        POST_SAVE_STEPS.nextPack,
        POST_SAVE_STEP_MS,
        (signal) => claimQueueItem(fetchImpl, progressUrl, secret, {}, { signal }),
        { runUrl: actionsRunUrl() },
      );
    } catch (err) {
      console.log('queue-drain claim failed', err && err.message);
      if (isStepTimeout(err)) throw err;
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
    if (drainClaimAction(item, finishedIds) === 'skip-finished') {
      console.log('queue-drain skip finished', item.title);
      await sleep(pollMs);
      continue;
    }
    const target = {
      title: item.title,
      requestId: item.id,
      links: item.links,
      chatId: item.chatId,
    };
    let slug;
    try {
      slug = writeRequestPack(target);
      fetchPackImages(join(ROOT, 'packs', slug), process.env, {
        index: 0,
        total: item.stickers ?? null,
      });
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
      finishedIds.add(String(item.id));
      packs++;
    } catch (err) {
      if (isStepTimeout(err)) throw err;
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
    await withStepTimeout(
      POST_SAVE_STEPS.nextPack,
      POST_SAVE_STEP_MS,
      (signal) => postDrainComplete(fetchImpl, progressUrl, secret, { signal }),
      { runUrl: actionsRunUrl() },
    );
  } catch (err) {
    console.log('queue-drain complete signal failed', err && err.message);
    if (isStepTimeout(err)) throw err;
  }
  return { packs, reason: packs ? 'drained' : 'idle' };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  console.error('queue_drain.mjs is imported from telemost_upload.mjs, not run directly');
  process.exit(2);
}
