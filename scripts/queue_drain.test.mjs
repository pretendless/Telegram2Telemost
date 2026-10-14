import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DEFAULT_DRAIN_IDLE_MS,
  DRAIN_PRIORITY_POLICY,
  fetchPackImages,
  formatPackFetchError,
  nextDrainWait,
  parseDrainIdleMs,
  shouldWaitForQueue,
  spawnFailureDetail,
} from './queue_drain.mjs';

test('priority policy documents finish-current before claim', () => {
  assert.match(DRAIN_PRIORITY_POLICY, /Finish the current pack/i);
  assert.match(DRAIN_PRIORITY_POLICY, /never preempt/i);
});

test('nextDrainWait uploads when claim returns a row', () => {
  const step = nextDrainWait({ claimed: { id: 'a' }, queued: 2, now: 1000, idleMs: 5000 });
  assert.equal(step.action, 'upload');
});

test('nextDrainWait retries claim when queued count is positive', () => {
  const step = nextDrainWait({ claimed: null, queued: 1, now: 1000, idleMs: 5000 });
  assert.equal(step.action, 'claim-again');
});

test('nextDrainWait stops immediately when idle ms is zero and no work yet', () => {
  const step = nextDrainWait({ claimed: null, queued: 0, now: 1000, idleMs: 0, sawWork: false });
  assert.equal(step.action, 'stop');
});

test('nextDrainWait waits for late enqueue while session is active', () => {
  const first = nextDrainWait({ claimed: null, queued: 0, now: 1000, idleMs: 5000, sawWork: true });
  assert.equal(first.action, 'wait');
  assert.equal(first.idleDeadline, 6000);
  const done = nextDrainWait({
    claimed: null,
    queued: 0,
    now: 6000,
    idleMs: 5000,
    idleDeadline: 6000,
    sawWork: true,
  });
  assert.equal(done.action, 'stop');
});

test('parseDrainIdleMs clamps invalid values', () => {
  assert.equal(parseDrainIdleMs('120000'), 120000);
  assert.equal(parseDrainIdleMs('-1'), DEFAULT_DRAIN_IDLE_MS);
  assert.equal(parseDrainIdleMs('nope'), DEFAULT_DRAIN_IDLE_MS);
});

test('shouldWaitForQueue respects idle deadline', () => {
  assert.equal(shouldWaitForQueue(5000, 4000), true);
  assert.equal(shouldWaitForQueue(5000, 5000), false);
});

const DYAVOLITSA = '/opt/tg2tm/packs/request-2026-10-13T180955555Z-2';

test('formatPackFetchError names the path, slug, sticker, exit code, and cause', () => {
  const text = formatPackFetchError({
    packDir: DYAVOLITSA,
    index: 0,
    total: 116,
    code: 'exit 1',
    cause: "PermissionError: [Errno 13] Permission denied: '/opt/tg2tm/.cache'",
  });
  assert.match(text, new RegExp(`fetch failed for ${DYAVOLITSA.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
  assert.match(text, /slug request-2026-10-13T180955555Z-2/);
  assert.match(text, /стикер 0 из 116/);
  assert.match(text, /exit 1/);
  assert.match(text, /PermissionError: \[Errno 13\]/);
  assert.ok(text.length <= 300);
});

test('spawnFailureDetail keeps the last traceback line and the exit code', () => {
  const detail = spawnFailureDetail({
    status: 1,
    stderr: "Traceback (most recent call last):\n  File \"fetch_and_convert.py\", line 90, in download\nPermissionError: [Errno 13] Permission denied: '/opt/tg2tm/.cache'\n",
  });
  assert.equal(detail.code, 'exit 1');
  assert.match(detail.cause, /PermissionError/);
  assert.equal(detail.cause.includes('Traceback'), false);
  const missing = spawnFailureDetail({
    status: null,
    error: Object.assign(new Error('spawn python3 ENOENT'), { code: 'ENOENT' }),
  });
  assert.equal(missing.code, 'ENOENT');
  assert.match(missing.cause, /ENOENT/);
});

test('fetchPackImages puts the python failure on the thrown error', () => {
  assert.throws(
    () => fetchPackImages(DYAVOLITSA, { TELEGRAM_BOT_TOKEN: 'token' }, {
      index: 0,
      total: 116,
      spawn: () => ({
        status: 1,
        stdout: '',
        stderr: "PermissionError: [Errno 13] Permission denied: '/opt/tg2tm/.cache'\n",
      }),
    }),
    (err) => {
      assert.match(err.message, /slug request-2026-10-13T180955555Z-2/);
      assert.match(err.message, /стикер 0 из 116/);
      assert.match(err.message, /exit 1: PermissionError/);
      return true;
    },
  );
});
