// Bounds the waits that follow a saved Telemost pack. A minute is enough for a
// channel post. An hour is not. On expiry the pack stops; it is not /newpack'd again.

export const POST_SAVE_STEP_MS = 60_000;

export const POST_SAVE_STEPS = Object.freeze({
  doneReply: 'чтение ответа после /done',
  packUrl: 'извлечение ссылки набора',
  savedProgress: 'сохранение прогресса',
  channelAndQueue: 'пост в канал и снятие с очереди',
  queueRelease: 'снятие с очереди',
  nextPack: 'старт следующего набора',
});

export function progressTimeoutStep(phase) {
  if (phase === 'saved') return POST_SAVE_STEPS.savedProgress;
  if (phase === 'link') return POST_SAVE_STEPS.channelAndQueue;
  if (phase === 'error' || phase === 'failed') return POST_SAVE_STEPS.queueRelease;
  return '';
}

export function formatStepTimeout({ step, waitedMs, runUrl } = {}) {
  const name = String(step || '').trim() || 'шаг';
  const seconds = Math.max(0, Math.round(Number(waitedMs) / 1000));
  const head = `таймаут шага «${name}»: ждал ${seconds} с`;
  const url = String(runUrl || '').trim();
  return url ? `${head} | ${url}` : head;
}

export function stepTimeoutLogLine({ step, waitedMs, limitMs } = {}) {
  const waited = Math.max(0, Math.round(Number(waitedMs) / 1000));
  const limit = Math.max(0, Math.round(Number(limitMs) / 1000));
  return `step-timeout ${step} waited ${waited}s limit ${limit}s`;
}

export class StepTimeoutError extends Error {
  constructor({ step, waitedMs, limitMs, runUrl } = {}) {
    super(formatStepTimeout({ step, waitedMs, runUrl }));
    this.name = 'StepTimeoutError';
    this.step = String(step || '');
    this.waitedMs = Number(waitedMs) || 0;
    this.limitMs = Number(limitMs) || 0;
    this.runUrl = String(runUrl || '');
    this.stepTimeout = true;
  }
}

export function isStepTimeout(err) {
  return Boolean(err && (err.stepTimeout || err.name === 'StepTimeoutError'));
}

// A timed-out pack is finished as an error. The same request is not started again.
export function timeoutPackDecision(err) {
  return {
    stopPack: true,
    retrySamePack: false,
    step: err && err.step ? String(err.step) : '',
    waitedMs: err && Number(err.waitedMs) ? Number(err.waitedMs) : 0,
    runUrl: err && err.runUrl ? String(err.runUrl) : '',
    error: err && err.message ? String(err.message) : '',
  };
}

export function withStepTimeout(step, limitMs, work, opts = {}) {
  const limit = Number(limitMs);
  const bound = Number.isFinite(limit) && limit >= 0 ? limit : POST_SAVE_STEP_MS;
  const now = opts.now || (() => Date.now());
  const log = opts.log || ((line) => console.log(line));
  const schedule = opts.schedule || ((fn, ms) => setTimeout(fn, ms));
  const clear = opts.clear || ((id) => clearTimeout(id));
  const runUrl = opts.runUrl != null ? String(opts.runUrl) : '';
  const started = now();
  const controller = new AbortController();
  let timer;
  let settled = false;
  const timeout = new Promise((_, reject) => {
    timer = schedule(() => {
      if (settled) return;
      const waitedMs = Math.max(0, now() - started);
      const err = new StepTimeoutError({ step, waitedMs, limitMs: bound, runUrl });
      log(stepTimeoutLogLine({ step, waitedMs, limitMs: bound }));
      controller.abort(err);
      reject(err);
    }, bound);
  });
  const run = Promise.resolve().then(() => work(controller.signal)).then(
    (value) => value,
    (err) => {
      if (controller.signal.aborted) return new Promise(() => {});
      throw err;
    },
  );
  return Promise.race([run, timeout]).finally(() => {
    settled = true;
    clear(timer);
  });
}
