import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DEFAULT_DRAIN_IDLE_MS,
  DRAIN_PRIORITY_POLICY,
  nextDrainWait,
  parseDrainIdleMs,
  shouldWaitForQueue,
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
