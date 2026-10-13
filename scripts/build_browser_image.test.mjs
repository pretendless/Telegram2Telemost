import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { buildArgs, runWatched, stallWatch } from './build_browser_image.mjs';

test('the image build reuses one GitHub Actions cache scope', () => {
  const args = buildArgs().join(' ');
  assert.match(args, /--cache-from type=gha,scope=tg2tm-browser/);
  assert.match(args, /--cache-to type=gha,mode=max,ignore-error=true,scope=tg2tm-browser/);
  assert.match(args, /--file vm\/Dockerfile/);
  assert.match(args, /--load/);
  assert.equal(args.includes('proxy'), false);
});

function manualTimers() {
  const pending = [];
  return {
    pending,
    setTimer(fn, ms) {
      const id = pending.length;
      pending.push({ fn, ms, cleared: false });
      return id;
    },
    clearTimer(id) {
      if (pending[id]) pending[id].cleared = true;
    },
  };
}

test('silence for the stall window fails the build, and fresh output does not', async () => {
  let clock = 0;
  let stalled = false;
  const timers = manualTimers();
  const watch = stallWatch({
    stallMs: 1000,
    now: () => clock,
    onStall: () => { stalled = true; },
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
  });
  watch.start();
  clock = 400;
  watch.progress();
  const early = timers.pending.filter((item) => !item.cleared).pop();
  clock = 800;
  early.fn();
  assert.equal(stalled, false);
  const armed = timers.pending.filter((item) => !item.cleared).pop();
  clock = 1400;
  armed.fn();
  assert.equal(stalled, true);

  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = () => { child.killed = true; };
  const done = runWatched(child, {
    stallMs: 1000,
    now: () => 5000,
    write() {},
  });
  child.emit('close', 0);
  await done;

  const quiet = new EventEmitter();
  quiet.stdout = new EventEmitter();
  quiet.stderr = new EventEmitter();
  quiet.killed = false;
  quiet.kill = () => { quiet.killed = true; };
  let now = 0;
  const hanging = runWatched(quiet, { stallMs: 1000, now: () => now, write() {} });
  now = 1000;
  const failure = await hanging.catch((err) => err);
  assert.match(failure.message, /no build progress for 1 seconds/);
  assert.equal(quiet.killed, true);
});
