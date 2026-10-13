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
  failurePackName,
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
  assert.equal(adminDelivery(sending, card({ phase: 'sending', index: 17, total: 144, attempt: 1 })).action, 'edit');
  assert.equal(adminDelivery(null, sending).action, 'send');
  assert.equal(adminDelivery(sending, { ...card({ phase: 'sending', index: 17, total: 144 }), pack: 'Другой' }).action, 'send');
});

test('emoji, the next send, an error, and the saved link edit the same card', () => {
  const sending = card({ phase: 'sending', index: 1, total: 144 });
  for (const phase of ['emoji', 'ready', 'done', 'error', 'saved', 'link', 'start', 'newpack', 'failed', 'waiting', 'retry']) {
    assert.equal(adminDelivery(sending, card({ phase, index: 1, total: 144 })).action, 'edit');
    assert.equal(adminDelivery(card({ phase, index: 1, total: 144 }), card({ phase, index: 2, total: 144 })).action, 'edit');
  }
  assert.equal(adminDelivery(sending, card({ phase: 'link', index: 144, total: 144, link: 'https://messenger.360.yandex.ru/#/stickers/1' })).action, 'edit');
  assert.equal(adminDelivery(sending, card({ phase: 'error', error: 'Не удалось обработать картинку' })).action, 'edit');
});

test('the card names the pack, the step, the bot line, and another user only by chat id', () => {
  const text = formatAdminStatus(card({
    phase: 'sending',
    index: 16,
    total: 144,
    lastLine: 'Отправьте эмодзи для стикера.',
    requester: '111',
  }));
  assert.match(text, /^10:44 \| «Маф, Изис и Агнес» \| стикер 16 из 144 \| отправка/);
  assert.match(text, /бот: Отправьте эмодзи для стикера\./);
  assert.match(text, /запрос: 111/);
  assert.equal(isAdminChat(ADMIN_CHAT_ID), true);
  assert.doesNotMatch(formatAdminStatus(card({ phase: 'waiting', seconds: 20, requester: ADMIN_CHAT_ID })), /запрос:/);
  const waiting = formatAdminStatus(card({ phase: 'waiting', index: 16, total: 144, seconds: 20 }));
  assert.match(waiting, /стикер 16 из 144 \| жду бота 20 с/);
  const retry = formatAdminStatus(card({ phase: 'retry', index: 16, total: 144, attempt: 2 }));
  assert.match(retry, /стикер 16 из 144 \| повтор 2/);
  const ready = formatAdminStatus(card({ phase: 'ready', index: 16, total: 144, lastLine: 'Стикер готов. Отправьте картинку.' }));
  assert.match(ready, /стикер 16 из 144 \| Стикер готов/);
  assert.match(ready, /бот: Стикер готов\. Отправьте картинку\./);
  const failed = formatAdminStatus(card({
    phase: 'failed',
    index: 1,
    total: 144,
    step: 'отправка',
    lastLine: 'Отправьте эмодзи',
    error: 'Actions завершились с ошибкой',
    runUrl: 'https://github.com/pretendless/tg2tm/actions/runs/1',
  }));
  assert.match(failed, /стикер 1 из 144/);
  assert.match(failed, /сбой Actions \| отправка/);
  assert.match(failed, /ошибка: Actions завершились с ошибкой/);
  assert.match(failed, /actions\/runs\/1/);
});

test('/status says the job is running or idle', () => {
  assert.equal(adminJobText(currentAdminJob([], { items: [] })), 'простаивает');
  assert.equal(
    adminJobText(currentAdminJob([{ title: pack, status: 'uploading', uploaded: 16, total: 144 }], { items: [] })),
    `идёт | «${pack}» | стикер 16 из 144`,
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
  assert.match(calls[3][2], /стикер 2 из 144/);
  assert.equal(calls.filter((call) => call[0] === 'send').length, 2);
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
  await notify(card({ phase: 'sending', index: 1, total: 144, requester: '' }));
  await notify(card({ phase: 'emoji', index: 1, total: 144 }));
  await notify(card({ phase: 'ready', index: 1, total: 144, lastLine: 'Стикер готов' }));
  await notify(card({ phase: 'waiting', index: 2, total: 144, seconds: 20 }));
  await notify(card({ phase: 'waiting', index: 2, total: 144, seconds: 20 }));
  await notify(card({ phase: 'waiting', index: 2, total: 144, seconds: 40 }));
  await notify(card({ phase: 'retry', index: 2, total: 144, attempt: 1 }));
  await notify({ phase: 'error', pack, at: '10:44', error: 'упало' });
  assert.deepEqual(calls.map((call) => call[0]), ['send', 'edit', 'edit', 'edit', 'edit', 'edit', 'edit']);
  assert.equal(calls.filter((call) => call[0] === 'send').length, 1);
  assert.match(calls[1][2], /стикер 1 из 144 \| эмодзи/);
  assert.match(calls[1][2], /запрос: 111/);
  assert.match(calls[2][2], /стикер 1 из 144 \| Стикер готов/);
  assert.match(calls[4][2], /стикер 2 из 144 \| жду бота 40 с/);
  assert.match(calls[5][2], /стикер 2 из 144 \| повтор 1/);
  assert.match(calls[6][2], /стикер 2 из 144/);
  assert.match(calls[6][2], /ошибка: упало/);
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
  writeFileSync(path, JSON.stringify({ messageId: 9, event: { phase: 'sending', pack, index: 4, total: 144 } }));
  const edited = [];
  await reportRunFailed({
    fetchImpl: async (url, options) => {
      const body = JSON.parse(options.body);
      edited.push({ url, body });
      return { ok: true, json: async () => ({ ok: true, result: { message_id: body.message_id || 9 } }) };
    },
    token: 'bot-token',
    statePath: path,
    runUrl: 'https://github.com/pretendless/tg2tm/actions/runs/1',
  });
  assert.equal(edited.length, 1);
  assert.match(edited[0].url, /editMessageText/);
  assert.equal(edited[0].body.message_id, 9);
  assert.match(edited[0].body.text, /стикер 4 из 144/);
  assert.match(edited[0].body.text, /сбой Actions/);
  assert.match(edited[0].body.text, /ошибка: Actions завершились с ошибкой/);
  assert.match(edited[0].body.text, /actions\/runs\/1/);

  writeFileSync(path, JSON.stringify({
    messageId: 9,
    event: { phase: 'error', pack, index: 4, total: 144, error: 'уже отправлено' },
  }));
  const updated = [];
  await reportRunFailed({
    fetchImpl: async (url, options) => {
      const body = JSON.parse(options.body);
      updated.push({ url, body });
      return { ok: true, json: async () => ({ ok: true, result: { message_id: 9 } }) };
    },
    token: 'bot-token',
    statePath: path,
    runUrl: 'https://github.com/pretendless/tg2tm/actions/runs/2',
  });
  assert.equal(updated.length, 1);
  assert.match(updated[0].url, /editMessageText/);
  assert.equal(updated[0].body.message_id, 9);
  assert.match(updated[0].body.text, /стикер 4 из 144/);
  assert.match(updated[0].body.text, /ошибка: уже отправлено/);
  assert.match(updated[0].body.text, /actions\/runs\/2/);
  assert.equal(updated[0].body.text.includes('bot-token'), false);
  rmSync(dir, { recursive: true });
  await reportRunFailed({ fetchImpl, token: '', statePath: path });
  assert.equal(sent.length, 1);
});

test('a restart failure names the open pack, or says перезапуск when the title is still unknown', async () => {
  assert.equal(failurePackName({ mode: 'restart', packs: '' }), 'перезапуск');
  assert.equal(failurePackName({ mode: 'restart-peek', packs: '' }), 'перезапуск');
  assert.equal(failurePackName({ mode: 'restart', title: 'Север' }), 'Север');
  assert.equal(failurePackName({ mode: 'restart', title: '11:57' }), 'перезапуск');
  assert.equal(failurePackName({ mode: 'restart', pack: '11:57' }), 'перезапуск');
  const sent = [];
  const fetchImpl = async (_url, options) => {
    sent.push(JSON.parse(options.body).text);
    return { ok: true, json: async () => ({ ok: true, result: { message_id: 4 } }) };
  };
  await reportRunFailed({
    fetchImpl,
    token: 'bot-token',
    statePath: 'logs/does-not-exist-admin.json',
    packs: '',
    mode: 'restart',
    logsDir: 'logs/does-not-exist-restart',
    runUrl: 'https://github.com/pretendless/tg2tm/actions/runs/38402599932',
  });
  assert.match(sent[0], /«перезапуск»/);
  assert.equal(sent[0].includes('«пак»'), false);

  const { writeFileSync, mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = mkdtempSync(join(tmpdir(), 'restart-fail-'));
  writeFileSync(join(dir, 'restart-choice.json'), JSON.stringify({ unfinished: true, title: 'Север' }));
  await reportRunFailed({
    fetchImpl,
    token: 'bot-token',
    statePath: join(dir, 'missing-admin.json'),
    packs: '',
    mode: 'restart',
    logsDir: dir,
    runUrl: 'https://github.com/pretendless/tg2tm/actions/runs/38402599932',
  });
  assert.match(sent[1], /«Север»/);
  assert.equal(sent[1].includes('«пак»'), false);
  rmSync(dir, { recursive: true });
});
