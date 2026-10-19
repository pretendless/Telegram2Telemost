import assert from 'node:assert/strict';
import test from 'node:test';
import {
  SESSION_LIMIT_TEXT,
  finalizeSessionOnce,
  formatSessionLimitMessage,
  sessionEndRestart,
} from '../session_end.js';

function memoryKv() {
  const store = new Map();
  return {
    store,
    async get(key) { return store.has(key) ? store.get(key) : null; },
    async put(key, value) { store.set(key, value); },
  };
}

const RUN = 'https://github.com/pretendless/Telegram2Telemost/actions/runs/38644156549';

test('empty queue does not restart', async () => {
  const kv = memoryKv();
  let dispatches = 0;
  let notices = 0;
  const queue = { items: [{ id: 'done-1', status: 'done', title: 'Готово' }] };
  assert.equal(sessionEndRestart(queue), 'idle');
  const result = await finalizeSessionOnce(kv, {
    runId: '38644156549',
    runUrl: RUN,
    queue,
    notify: async () => { notices += 1; },
    dispatch: async () => { dispatches += 1; return { started: true }; },
  });
  assert.equal(result.decision, 'idle');
  assert.equal(result.dispatched, false);
  assert.equal(dispatches, 0);
  assert.equal(notices, 1);
  assert.match(formatSessionLimitMessage(RUN), new RegExp(SESSION_LIMIT_TEXT));
  assert.match(formatSessionLimitMessage(RUN), /38644156549/);
});

test('a pending queue restarts once', async () => {
  const kv = memoryKv();
  let dispatches = 0;
  const queue = {
    items: [
      { id: 'up', status: 'uploading', title: 'Шерсть Ебаная' },
      { id: 'next', status: 'queued', title: 'tst' },
    ],
  };
  assert.equal(sessionEndRestart(queue), 'restart');
  const result = await finalizeSessionOnce(kv, {
    runId: '38644156549',
    runUrl: RUN,
    queue,
    notify: async () => {},
    dispatch: async () => { dispatches += 1; return { started: true }; },
  });
  assert.equal(result.decision, 'restart');
  assert.equal(result.dispatched, true);
  assert.equal(dispatches, 1);
  assert.deepEqual(result.uploading, ['up']);
  assert.equal(queue.items[0].status, 'uploading');
});

test('a second finalizer does not notify or dispatch again', async () => {
  const kv = memoryKv();
  let dispatches = 0;
  let notices = 0;
  const queue = { items: [{ id: 'next', status: 'queued', title: 'tst' }] };
  const args = {
    runId: '38644156549',
    runUrl: RUN,
    queue,
    notify: async () => { notices += 1; },
    dispatch: async () => { dispatches += 1; return { started: true }; },
  };
  const first = await finalizeSessionOnce(kv, args);
  const second = await finalizeSessionOnce(kv, args);
  assert.equal(first.duplicate, false);
  assert.equal(first.dispatched, true);
  assert.equal(second.duplicate, true);
  assert.equal(second.dispatched, false);
  assert.equal(dispatches, 1);
  assert.equal(notices, 1);
});
