import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ADMIN_CHAT_ID,
  adminDelivery,
  bindPackProgress,
  clearPackProgress,
  progressFieldsForPack,
  adminJobText,
  createAdminFeed,
  currentAdminJob,
  deliverAdminStatus,
  actionsRunUrl,
  formatAdminStatus,
  adminMenuChatIds,
  adminNoticeChatIds,
  deliverAdminFeed,
  loadAdminCursors,
  isAdminChat,
  failurePackName,
  reportRestartNoUpload,
  reportRunFailed,
  restartNoUploadCopy,
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
  for (const phase of ['buffering', 'emoji', 'ready', 'done', 'error', 'saved', 'link', 'start', 'newpack', 'failed', 'waiting', 'retry']) {
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
  const buffering = formatAdminStatus(card({ phase: 'buffering', index: 3, total: 144 }));
  assert.match(buffering, /стикер 3 из 144 \| буфферизация/);
  assert.match(text, /бот: Отправьте эмодзи для стикера\./);
  assert.match(text, /запрос: 111/);
  assert.equal(isAdminChat(ADMIN_CHAT_ID), true);
  assert.deepEqual(adminMenuChatIds('8502935020', '8502935020,5513343655'), ['8502935020', '5513343655']);
  assert.deepEqual(adminMenuChatIds('', ''), [ADMIN_CHAT_ID]);
  assert.deepEqual(adminMenuChatIds('5513343655,8502935020', '8502935020,5513343655'), ['5513343655', '8502935020']);
  assert.equal(isAdminChat('5513343655'), false);
  assert.equal(isAdminChat('5513343655', '8502935020,5513343655'), true);
  assert.equal(isAdminChat(ADMIN_CHAT_ID, '8502935020,5513343655'), true);
  assert.equal(isAdminChat('424242', '8502935020,5513343655'), false);
  assert.equal(isAdminChat('not-a-chat-id', '8502935020,5513343655'), false);
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
    runUrl: 'https://github.com/pretendless/Telegram2Telemost/actions/runs/1',
  }));
  assert.match(failed, /стикер 1 из 144/);
  assert.match(failed, /сбой Actions \| отправка/);
  assert.match(failed, /ошибка: Actions завершились с ошибкой/);
  assert.match(failed, /actions\/runs\/1/);
});

test('actionsRunUrl uses RUN_URL, or builds github.server_url/repo/actions/runs/id', () => {
  assert.equal(
    actionsRunUrl({ RUN_URL: 'https://github.com/pretendless/Telegram2Telemost/actions/runs/9' }),
    'https://github.com/pretendless/Telegram2Telemost/actions/runs/9',
  );
  assert.equal(
    actionsRunUrl({
      GITHUB_RUN_ID: '38602403732',
      GITHUB_SERVER_URL: 'https://github.com',
      GITHUB_REPOSITORY: 'pretendless/Telegram2Telemost',
    }),
    'https://github.com/pretendless/Telegram2Telemost/actions/runs/38602403732',
  );
  assert.equal(
    actionsRunUrl({ GITHUB_RUN_ID: '38602403732' }),
    'https://github.com/pretendless/Telegram2Telemost/actions/runs/38602403732',
  );
  assert.equal(actionsRunUrl({}), '');
  assert.equal(actionsRunUrl({ RUN_URL: 'not a url', GITHUB_RUN_ID: '4', GITHUB_REPOSITORY: 'acme/widgets' }), 'https://github.com/acme/widgets/actions/runs/4');
});

test('an error card gains the Actions run URL once and the next identical error does not send another message', async () => {
  const calls = [];
  const io = {
    send: async (_chatId, text) => {
      calls.push(['send', text]);
      return { message_id: 21 };
    },
    edit: async (_chatId, id, text) => {
      calls.push(['edit', id, text]);
    },
    delete: async () => {
      calls.push(['delete']);
    },
  };
  const notify = createAdminFeed({
    io,
    env: {
      GITHUB_RUN_ID: '38602403732',
      GITHUB_SERVER_URL: 'https://github.com',
      GITHUB_REPOSITORY: 'pretendless/Telegram2Telemost',
    },
  });
  const error = 'fetch failed for /opt/tg2tm/packs/request-2026-10-13T180955555Z-2 | slug request-2026-10-13T180955555Z-2 | стикер 0 из 116: exit 1: PermissionError: [Errno 13] Permission denied';
  await notify(card({ phase: 'sending', index: 0, total: 116 }));
  await notify(card({ phase: 'error', index: 0, total: 116, error }));
  await notify(card({ phase: 'error', index: 0, total: 116, error }));
  assert.deepEqual(calls.map((call) => call[0]), ['send', 'edit']);
  assert.equal(calls[0][1].includes('actions/runs/'), false);
  assert.match(calls[1][2], /стикер 0 из 116 \| ошибка/);
  assert.match(calls[1][2], /slug request-2026-10-13T180955555Z-2/);
  assert.match(calls[1][2], /PermissionError/);
  assert.match(calls[1][2], /https:\/\/github\.com\/pretendless\/Telegram2Telemost\/actions\/runs\/38602403732/);
  assert.equal(calls[1][2].match(/actions\/runs\/38602403732/g).length, 1);
});

test('/status says the job is running or idle', () => {
  assert.equal(adminJobText(currentAdminJob({ items: [] })), 'линия свободна');
  assert.equal(
    adminJobText(
      currentAdminJob(
        { items: [] },
        { title: pack, status: 'uploading', uploaded: 16, total: 144 },
      ),
    ),
    'линия свободна',
  );
  assert.equal(
    adminJobText(
      currentAdminJob(
        { items: [{ status: 'uploading', title: pack, stickers: 144 }] },
        { title: pack, status: 'uploading', uploaded: 16, total: 144 },
      ),
    ),
    `линия в процессе | «${pack}» | стикер 16 из 144`,
  );
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
    runUrl: 'https://github.com/pretendless/Telegram2Telemost/actions/runs/1',
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
    runUrl: 'https://github.com/pretendless/Telegram2Telemost/actions/runs/1',
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
    runUrl: 'https://github.com/pretendless/Telegram2Telemost/actions/runs/2',
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

test('a failed restart names the step reason left by the container', async () => {
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { writeStepFailure } = await import('../vm/step_failure.mjs');
  const dir = mkdtempSync(join(tmpdir(), 'admin-step-'));
  writeStepFailure(dir, {
    step: 'чтение диалога',
    error: 'SecurityError: Failed to read the \'localStorage\' property from \'Window\': Access is denied for this document.',
    runId: '38873216831',
  });
  const sent = [];
  await reportRunFailed({
    fetchImpl: async (_url, options) => {
      sent.push(JSON.parse(options.body).text);
      return { ok: true, json: async () => ({ ok: true, result: { message_id: 4 } }) };
    },
    token: 'bot-token',
    statePath: join(dir, 'missing-admin.json'),
    logsDir: dir,
    mode: 'restart',
    packs: '',
    runId: '38873216831',
    runUrl: 'https://github.com/pretendless/Telegram2Telemost/actions/runs/38873216831',
  });
  assert.equal(sent.length, 1);
  assert.match(sent[0], /«перезапуск»/);
  assert.match(sent[0], /сбой Actions \| чтение диалога/);
  assert.match(sent[0], /ошибка: SecurityError: Failed to read the 'localStorage'/);
  assert.match(sent[0], /actions\/runs\/38873216831/);
  rmSync(dir, { recursive: true });
});

test('a quiet restart idle posts reason and next action to admin', async () => {
  const empty = restartNoUploadCopy({ reason: 'empty-queue', lastLine: '/done — завершить действие' });
  assert.equal(empty.pack, 'перезапуск');
  assert.match(empty.error, /очередь пуста/);
  assert.match(empty.next, /пришлите пак/);
  const secret = restartNoUploadCopy({ reason: 'no-uploader-secret' });
  assert.match(secret.error, /UPLOADER_SECRET/);
  assert.match(secret.next, /секреты Actions/);

  const sent = [];
  const { writeFileSync, mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = mkdtempSync(join(tmpdir(), 'restart-idle-'));
  writeFileSync(join(dir, 'restart-pack.json'), JSON.stringify({
    action: 'idle',
    title: '',
    lastLine: '/done — завершить действие',
    reason: 'no-uploader-secret',
  }));
  await reportRestartNoUpload({
    fetchImpl: async (_url, options) => {
      sent.push(JSON.parse(options.body).text);
      return { ok: true, json: async () => ({ ok: true, result: { message_id: 5 } }) };
    },
    token: 'bot-token',
    statePath: join(dir, 'missing-admin.json'),
    logsDir: dir,
    runUrl: 'https://github.com/pretendless/Telegram2Telemost/actions/runs/38416619883',
  });
  assert.equal(sent.length, 1);
  assert.match(sent[0], /«перезапуск»/);
  assert.match(sent[0], /ошибка: очередь недоступна/);
  assert.match(sent[0], /дальше: проверьте секреты Actions/);
  assert.match(sent[0], /бот: \/done — завершить действие/);
  assert.match(sent[0], /actions\/runs\/38416619883/);
  rmSync(dir, { recursive: true });
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
    runUrl: 'https://github.com/pretendless/Telegram2Telemost/actions/runs/38402599932',
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
    runUrl: 'https://github.com/pretendless/Telegram2Telemost/actions/runs/38402599932',
  });
  assert.match(sent[1], /«Север»/);
  assert.equal(sent[1].includes('«пак»'), false);
  rmSync(dir, { recursive: true });
});

test('two packs in one session do not keep a stale requester, and TELEGRAM_CHAT_ID is not one', () => {
  const previous = process.env.TELEGRAM_CHAT_ID;
  process.env.TELEGRAM_CHAT_ID = '8502935020';
  try {
    const dirRef = { dir: 'request-a', title: '', queueRequestId: '', requesterChatId: '' };
    bindPackProgress(dirRef, { title: 'Том', queueRequestId: 'req-a', requesterChatId: '111' });
    assert.deepEqual(progressFieldsForPack(dirRef), {
      requester: '111',
      requesterChatId: '111',
      queueRequestId: 'req-a',
    });
    clearPackProgress(dirRef);
    bindPackProgress(dirRef, { title: 'Дьяволица', queueRequestId: 'req-b', requesterChatId: '222' });
    assert.equal(progressFieldsForPack(dirRef).requesterChatId, '222');
    assert.equal(progressFieldsForPack(dirRef).queueRequestId, 'req-b');
    clearPackProgress(dirRef);
    bindPackProgress(dirRef, { title: 'Без метаданных' });
    assert.deepEqual(progressFieldsForPack(dirRef), {
      requester: null,
      requesterChatId: null,
      queueRequestId: null,
    });
    dirRef.queueRequestId = 'req-a';
    dirRef.requesterChatId = '111';
    bindPackProgress(dirRef, { title: 'Пустой', queueRequestId: '', requesterChatId: '' });
    assert.equal(progressFieldsForPack(dirRef).requesterChatId, null);
    dirRef.queueRequestId = 'req-b';
    dirRef.requesterChatId = '222';
    bindPackProgress(dirRef, { queueRequestId: 'req-a', requesterChatId: '111' });
    assert.equal(dirRef.queueRequestId, 'req-b');
    assert.equal(dirRef.requesterChatId, '222');
    assert.equal(JSON.stringify(progressFieldsForPack(dirRef)).includes('8502935020'), false);
  } finally {
    if (previous == null) delete process.env.TELEGRAM_CHAT_ID;
    else process.env.TELEGRAM_CHAT_ID = previous;
  }
});

test('a new start does not keep the previous pack sticker count', async () => {
  const seen = [];
  const io = {
    send: async () => ({ message_id: 1 }),
    edit: async () => {},
    delete: async () => {},
  };
  const notify = createAdminFeed({
    io,
    onDelivered: async (event) => {
      seen.push({ phase: event.phase, index: event.index, total: event.total, pack: event.pack });
    },
  });
  await notify({ phase: 'link', pack: 'ХорниМуд', index: 92, total: 92, link: 'https://messenger.360.yandex.ru/#/stickers/1' });
  await notify({ phase: 'start', pack: 'ХорниМуд', total: 92 });
  assert.equal(seen.at(-1).phase, 'start');
  assert.equal(seen.at(-1).index, 0);
  assert.equal(seen.at(-1).total, 92);
  await notify({ phase: 'sending', pack: 'ХорниМуд', index: 54, total: 92 });
  assert.equal(seen.at(-1).index, 54);
});

test('the admin feed sends the same card to every admin and edits each message id', async () => {
  const calls = [];
  let next = 20;
  const io = {
    send: async (chatId, text) => {
      const messageId = next;
      next += 1;
      calls.push(['send', String(chatId), messageId, text]);
      return { message_id: messageId };
    },
    edit: async (chatId, messageId, text) => {
      calls.push(['edit', String(chatId), messageId, text]);
    },
    delete: async (chatId, messageId) => {
      calls.push(['delete', String(chatId), messageId]);
    },
  };
  const ids = ['8502935020', '5513343655'];
  const notify = createAdminFeed({ io, adminIds: ids.join(','), requester: '424242' });
  await notify({ phase: 'sending', pack: 'Дьяволица', index: 1, total: 4, at: '20:33', runUrl: 'https://github.com/pretendless/Telegram2Telemost/actions/runs/9' });
  await notify({ phase: 'sending', pack: 'Дьяволица', index: 2, total: 4, at: '20:33', runUrl: 'https://github.com/pretendless/Telegram2Telemost/actions/runs/9' });
  const sends = calls.filter((call) => call[0] === 'send');
  const edits = calls.filter((call) => call[0] === 'edit');
  assert.deepEqual(sends.map((call) => call[1]), ids);
  assert.equal(sends[0][3], sends[1][3]);
  assert.match(sends[0][3], /actions\/runs\/9/);
  assert.match(sends[0][3], /стикер 1 из 4/);
  assert.deepEqual(edits.map((call) => [call[1], call[2]]), [
    ['8502935020', 20],
    ['5513343655', 21],
  ]);
  assert.equal(edits[0][3], edits[1][3]);
  assert.match(edits[0][3], /стикер 2 из 4/);
  assert.equal(edits[0][2] === edits[1][2], false);
});

test('a legacy single message id is not reused for the second admin', async () => {
  const ids = ['8502935020', '5513343655'];
  const cursors = loadAdminCursors({ messageId: 9, event: { phase: 'sending', pack, index: 1, total: 4 } }, ids);
  assert.equal(cursors['8502935020'].messageId, 9);
  assert.equal(cursors['5513343655'], undefined);
  const calls = [];
  const io = {
    send: async (chatId) => {
      calls.push(['send', String(chatId)]);
      return { message_id: 40 + calls.length };
    },
    edit: async (chatId, messageId) => {
      calls.push(['edit', String(chatId), messageId]);
    },
    delete: async () => {},
  };
  await deliverAdminFeed(io, ids, cursors, card({ phase: 'sending', index: 2, total: 4 }));
  assert.deepEqual(calls, [
    ['edit', '8502935020', 9],
    ['send', '5513343655'],
  ]);
  assert.deepEqual(adminNoticeChatIds('111', '8502935020,5513343655'), ids);
  assert.deepEqual(adminNoticeChatIds('111', ''), ['111']);
});

test('a failed run reaches both admins, or the worker when progress is configured', async () => {
  const ids = '8502935020,5513343655';
  const direct = [];
  await reportRunFailed({
    fetchImpl: async (_url, options) => {
      direct.push(JSON.parse(options.body));
      return { ok: true, json: async () => ({ ok: true, result: { message_id: direct.length } }) };
    },
    token: 'bot-token',
    statePath: 'logs/does-not-exist-admin.json',
    packs: '08',
    adminIds: ids,
    runUrl: 'https://github.com/pretendless/Telegram2Telemost/actions/runs/1',
    env: {},
  });
  assert.equal(direct.length, 2);
  assert.deepEqual(direct.map((body) => String(body.chat_id)), ['8502935020', '5513343655']);
  assert.equal(direct[0].text, direct[1].text);
  assert.match(direct[0].text, /actions\/runs\/1/);

  const posted = [];
  await reportRunFailed({
    fetchImpl: async (url, options) => {
      posted.push({ url, body: JSON.parse(options.body) });
      return { ok: true, json: async () => ({ ok: true }) };
    },
    token: 'bot-token',
    statePath: 'logs/does-not-exist-admin.json',
    packs: '08',
    adminIds: ids,
    runUrl: 'https://github.com/pretendless/Telegram2Telemost/actions/runs/2',
    env: { TG2TM_PROGRESS_URL: 'https://tg2tmbot.example/progress', UPLOADER_SECRET: 'secret' },
  });
  assert.equal(posted.length, 1);
  assert.match(posted[0].url, /\/progress$/);
  assert.equal(posted[0].body.adminDelivered, false);
  assert.match(posted[0].body.runUrl, /actions\/runs\/2/);
  assert.equal(posted[0].body.chat_id, undefined);
});

test('the admin feed sends the card only to the admin chat', async () => {
  const chats = [];
  const io = {
    send: async (chatId) => {
      chats.push(String(chatId));
      return { message_id: 4 };
    },
    edit: async () => {},
    delete: async () => {},
  };
  const notify = createAdminFeed({ io, requester: () => '222' });
  await notify({ phase: 'sending', pack: 'Дьяволица', index: 1, total: 4, at: '20:33' });
  assert.deepEqual(chats, [ADMIN_CHAT_ID]);
});
