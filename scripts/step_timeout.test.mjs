import assert from 'node:assert/strict';
import test from 'node:test';
import {
  POST_SAVE_STEP_MS,
  POST_SAVE_STEPS,
  StepTimeoutError,
  formatStepTimeout,
  isStepTimeout,
  progressTimeoutStep,
  stepTimeoutLogLine,
  timeoutPackDecision,
  withStepTimeout,
} from './step_timeout.mjs';

const RUN = 'https://github.com/pretendless/Telegram2Telemost/actions/runs/38644156549';

test('post-save bound is a minute, not an hour', () => {
  assert.equal(POST_SAVE_STEP_MS, 60_000);
  assert.ok(POST_SAVE_STEP_MS >= 30_000 && POST_SAVE_STEP_MS <= 120_000);
});

test('timeout text names the step, the wait, and the Actions run', () => {
  const text = formatStepTimeout({
    step: POST_SAVE_STEPS.channelAndQueue,
    waitedMs: 60_000,
    runUrl: RUN,
  });
  assert.match(text, /пост в канал и снятие с очереди/);
  assert.match(text, /ждал 60 с/);
  assert.match(text, /38644156549/);
  assert.match(stepTimeoutLogLine({ step: POST_SAVE_STEPS.packUrl, waitedMs: 60_000, limitMs: 60_000 }), /step-timeout извлечение ссылки набора waited 60s limit 60s/);
});

test('a finished step does not time out and does not keep the timer', async () => {
  let fire = null;
  const logs = [];
  const url = await withStepTimeout(
    POST_SAVE_STEPS.packUrl,
    POST_SAVE_STEP_MS,
    async () => 'https://messenger.360.yandex.ru/#/stickers/8506',
    {
      schedule: (fn) => {
        fire = fn;
        return 1;
      },
      clear: () => {
        fire = null;
      },
      now: () => 0,
      log: (line) => logs.push(line),
      runUrl: RUN,
    },
  );
  assert.equal(url, 'https://messenger.360.yandex.ru/#/stickers/8506');
  assert.equal(fire, null);
  assert.deepEqual(logs, []);
});

test('a stalled step rejects with the step name, the wait, and the run URL', async () => {
  let fire = null;
  let clock = 1_000;
  const logs = [];
  let signal;
  const pending = withStepTimeout(
    POST_SAVE_STEPS.channelAndQueue,
    POST_SAVE_STEP_MS,
    (abortSignal) => {
      signal = abortSignal;
      return new Promise(() => {});
    },
    {
      schedule: (fn) => {
        fire = fn;
        return 7;
      },
      clear: () => {},
      now: () => clock,
      log: (line) => logs.push(line),
      runUrl: RUN,
    },
  );
  clock = 61_000;
  fire();
  await assert.rejects(pending, (err) => {
    assert.equal(err instanceof StepTimeoutError, true);
    assert.equal(isStepTimeout(err), true);
    assert.equal(err.step, POST_SAVE_STEPS.channelAndQueue);
    assert.equal(err.waitedMs, 60_000);
    assert.equal(err.limitMs, 60_000);
    assert.equal(err.runUrl, RUN);
    assert.match(err.message, /пост в канал и снятие с очереди/);
    assert.match(err.message, /ждал 60 с/);
    assert.match(err.message, /38644156549/);
    return true;
  });
  assert.equal(signal.aborted, true);
  assert.deepEqual(logs, ['step-timeout пост в канал и снятие с очереди waited 60s limit 60s']);
  const decision = timeoutPackDecision(await pending.catch((err) => err));
  assert.equal(decision.stopPack, true);
  assert.equal(decision.retrySamePack, false);
  assert.equal(decision.step, POST_SAVE_STEPS.channelAndQueue);
});

test('progress phases after a save are the ones with a bound', () => {
  assert.equal(progressTimeoutStep('saved'), POST_SAVE_STEPS.savedProgress);
  assert.equal(progressTimeoutStep('link'), POST_SAVE_STEPS.channelAndQueue);
  assert.equal(progressTimeoutStep('error'), POST_SAVE_STEPS.queueRelease);
  assert.equal(progressTimeoutStep('failed'), POST_SAVE_STEPS.queueRelease);
  assert.equal(progressTimeoutStep('sending'), '');
  assert.equal(progressTimeoutStep('ready'), '');
});
