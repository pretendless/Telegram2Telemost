import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ADMIN_CHAT_ID,
  adminDelivery,
  adminJobText,
  createAdminFeed,
  currentAdminJob,
  deliverAdminStatus,
  formatAdminStatus,
  isAdminChat,
  reportRunFailed,
} from './admin_status.mjs';

const pack = 'Маф, Изис и Агнес';

function card(event) {
  return { ...event, pack, at: '10:44' };
}

test('a sticker number, a wait, or a retry edits the same card', () => {
  const sending = card({ phase: 'sending', index: 16, total: 144 });
  assert.equal(adminDelivery(sending, card({ phase: 'sending', index: 17, total: 144 })).action, 'edit');
  const waiting = card({ phase: 'waiting', index: 16, total: 144, seconds: 20 });
  assert.equal(adminDelivery(waiting, card({ phase: 'waiting', index: 16, total: 144, seconds: 40 })).action, 'edit');
  const retry = card({ phase: 'retry', index: 16, total: 144, attempt: 1 });
  assert.equal(adminDelivery(retry, card({ phase: 'retry', index: 16, total: 144, attempt: 2 })).action, 'edit');
  assert.equal(adminDelivery(sending, sending).action, 'skip');
  assert.equal(adminDelivery(sending, card({ phase: 'sending', index: 17, total: 144, attempt: 1 })).action, 'send');
});

test('emoji, /done, error, saved, and link are new messages', () => {
  const sending = card({ phase: 'sending', index: 1, total: 144 });
  for (const phase of ['emoji', 'done', 'error', 'saved', 'link', 'start', 'newpack', 'failed']) {
    assert.equal(adminDelivery(sending, card({ phase, index: 1, total: 144 })).action, 'send');
    assert.equal(adminDelivery(card({ phase, index: 1, total: 144 }), card({ phase, index: 2, total: 144 })).action, 'send');
  }
});

test('the card names the pack, the step, the bot line, and another user only by chat id', () => {
  const text = formatAdminStatus(card({
    phase: 'sending',
    index: 16,
    total: 144,
    lastLine: 'Отправьте эмодзи для стикера.',
    requester: '111',
  }));
  assert.match(text, /^10:44 \| «Маф, Изис и Агнес» \| отправка 16\/144/);
  assert.match(text, /бот: Отправьте эмодзи для стикера\./);
  assert.match(text, /запрос: 111/);
  assert.equal(isAdminChat(ADMIN_CHAT_ID), true);
  assert.doesNotMatch(formatAdminStatus(card({ phase: 'waiting', seconds: 20, requester: ADMIN_CHAT_ID })), /запрос:/);
  const failed = formatAdminStatus(card({
    phase: 'failed',
    step: 'отправка 1/144',
    lastLine: 'Отправьте эмодзи',
    error: 'Actions завершились с ошибкой',
    runUrl: 'https://github.com/pretendless/tg2tm/actions/runs/1',
  }));
  assert.match(failed, /сбой Actions \| отправка 1\/144/);
  assert.match(failed, /ошибка: Actions завершились с ошибкой/);
  assert.match(failed, /actions\/runs\/1/);
});

test('/status says the job is running or idle', () => {
  assert.equal(adminJobText(currentAdminJob([], { items: [] })), 'простаивает');
  assert.equal(
    adminJobText(currentAdminJob([{ title: pack, status: 'uploading', uploaded: 16, total: 144 }], { items: [] })),
    `идёт | «${pack}» | отправка 16/144`,
  );
  assert.match(adminJobText(currentAdminJob([], { items: [{ status: 'uploading', title: pack, stickers: 144 }] })), /^идёт \|/);
});

test('a failed edit deletes the old card and sends the replacement', async () => {
  const calls = [];
  const io = {
    send: async (chatId, text) => {
      calls.push(['send', chatId, text]);
      return { message_id: calls.length === 1 ? 10 : 11 };
    },
    edit: async () => {
      calls.push(['edit']);
      throw new Error('edit failed');
    },
    delete: async (chatId, messageId) => {
      calls.push(['delete', chatId, messageId]);
    },
  };
  const first = await deliverAdminStatus(io, ADMIN_CHAT_ID, null, card({ phase: 'sending', index: 1, total: 144 }));
  assert.equal(first.action, 'send');
  assert.equal(first.messageId, 10);
  const second = await deliverAdminStatus(io, ADMIN_CHAT_ID, first, card({ phase: 'sending', index: 2, total: 144 }));
  assert.equal(second.action, 'replace');
  assert.equal(second.messageId, 11);
  assert.deepEqual(calls.map((call) => call[0]), ['send', 'edit', 'delete', 'send']);
  assert.equal(calls[2][2], 10);
  assert.match(calls[3][2], /отправка 2\/144/);
});

test('the feed edits a repeated wait and does not call Telegram when the card is unchanged', async () => {
  const calls = [];
  let messageId = 7;
  const io = {
    send: async (_chatId, text) => {
      calls.push(['send', text]);
      return { message_id: messageId };
    },
    edit: async (_chatId, id, text) => {
      calls.push(['edit', id, text]);
    },
    delete: async () => {
      calls.push(['delete']);
    },
  };
  const notify = createAdminFeed({ io, requester: '111' });
  await notify(card({ phase: 'waiting', seconds: 20, requester: '' }));
  await notify(card({ phase: 'waiting', seconds: 20 }));
  await notify(card({ phase: 'waiting', seconds: 40 }));
  await notify(card({ phase: 'emoji', index: 1, total: 144 }));
  assert.deepEqual(calls.map((call) => call[0]), ['send', 'edit', 'send']);
  assert.match(calls[1][2], /жду бота 40 с/);
  assert.match(calls[1][2], /запрос: 111/);
  assert.match(calls[2][1], /эмодзи 1\/144/);
  messageId = 8;
});

test('a failed Actions run sends one forwardable card and skips when the error was already sent', async () => {
  const sent = [];
  const fetchImpl = async (_url, options) => {
    const body = JSON.parse(options.body);
    assert.equal(String(body.text).includes('bot-token'), false);
    sent.push(body.text);
    return { ok: true, json: async () => ({ ok: true, result: { message_id: 3 } }) };
  };
  await reportRunFailed({
    fetchImpl,
    token: 'bot-token',
    statePath: 'logs/does-not-exist-admin.json',
    packs: '08',
    runUrl: 'https://github.com/pretendless/tg2tm/actions/runs/1',
  });
  assert.equal(sent.length, 1);
  assert.match(sent[0], /сбой Actions/);
  assert.match(sent[0], /08/);
  assert.match(sent[0], /ошибка: Actions завершились с ошибкой/);
  assert.match(sent[0], /actions\/runs\/1/);

  const stored = JSON.stringify({ event: { phase: 'error', pack, error: 'уже отправлено' } });
  const { writeFileSync, mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = mkdtempSync(join(tmpdir(), 'admin-status-'));
  const path = join(dir, 'admin-last.json');
  writeFileSync(path, stored);
  await reportRunFailed({ fetchImpl, token: 'bot-token', statePath: path });
  assert.equal(sent.length, 1);
  rmSync(dir, { recursive: true });
  await reportRunFailed({ fetchImpl, token: '', statePath: path });
  assert.equal(sent.length, 1);
});
