import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { githubOutputValue, patchRequestPack, restartGithubOutput, restartQuietReason } from './restart_prepare.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
import { restartTarget } from './telemost_upload.mjs';

test('restart github output uses single-line keys, not raw JSON', () => {
  const text = restartGithubOutput({
    action: 'seen',
    title: '',
    lastLine: '11:57',
    reason: 'unmatched-title',
  });
  assert.equal(text, [
    'action=seen',
    'restart_seen_title=',
    'restart_seen_last_line=11:57',
    'restart_reason=unmatched-title',
    '',
  ].join('\n'));
  assert.equal(text.includes('restart-seen'), false);
  assert.equal(text.includes('{'), false);
  for (const line of text.trimEnd().split('\n')) {
    assert.match(line, /^[A-Za-z0-9_]+=/);
  }
});

test('github output values drop newlines so GITHUB_OUTPUT stays valid', () => {
  assert.equal(githubOutputValue('a\nb\rc'), 'a b c');
  const text = restartGithubOutput({
    action: 'upload',
    title: 'Юг\nещё',
    lastLine: 'Отправьте эмодзи\nдля стикера.',
  });
  assert.equal(text.split('\n').length, 5);
  assert.match(text, /^restart_seen_title=Юг ещё$/m);
  assert.match(text, /^restart_seen_last_line=Отправьте эмодзи для стикера\.$/m);
  assert.match(text, /^restart_reason=$/m);
});

test('quiet restart reasons name empty queue vs missing uploader secret', () => {
  assert.equal(restartQuietReason({ action: 'idle', queueReadable: true }), 'empty-queue');
  assert.equal(restartQuietReason({ action: 'idle', queueReadable: false }), 'no-uploader-secret');
  assert.equal(restartQuietReason({ action: 'close' }), 'close-open-dialog');
  assert.equal(restartQuietReason({ action: 'seen' }), 'unmatched-title');
});

test('empty or clock title on an open dialog closes or continues, not a hard fail', () => {
  const catalogs = [{ title: 'Юг', dir: '02-yug' }];
  const active = [{
    id: 'a',
    title: 'Запад',
    status: 'uploading',
    links: ['https://t.me/addstickers/zapad'],
    createdAt: '1',
    priority: false,
  }];
  const withActive = restartTarget({
    unfinished: true,
    title: '',
    liveText: '11:57\nОтправьте эмодзи для стикера.',
    catalogs,
    requests: active,
  });
  assert.equal(withActive.action, 'restart');
  assert.equal(withActive.title, 'Запад');
  assert.equal(withActive.dir, '');
  const clockTitle = restartTarget({
    unfinished: true,
    title: '11:57',
    liveText: 'Стикер готов.\n11:57',
    catalogs,
    requests: [],
  });
  assert.equal(clockTitle.action, 'close');
  assert.equal(clockTitle.title, '');
  const output = restartGithubOutput({
    action: clockTitle.action,
    title: clockTitle.title,
    lastLine: '11:57',
  });
  assert.match(output, /^action=close$/m);
  assert.match(output, /^restart_seen_title=$/m);
});

test('patchRequestPack adds queue requester metadata to an existing catalog pack', () => {
  const dir = '99-patch-test';
  const folder = join(ROOT, 'packs', dir);
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, 'pack.json'), JSON.stringify({
    title: 'Юг',
    slug: dir,
    stickerLinks: ['https://t.me/addstickers/yug'],
    telemost: { status: 'pending', uploaded: 0 },
  }, null, 2) + '\n');
  assert.equal(patchRequestPack(dir, { requestId: 'req-9', chatId: '424242' }), true);
  const meta = JSON.parse(readFileSync(join(folder, 'pack.json'), 'utf8'));
  assert.equal(meta.queueRequestId, 'req-9');
  assert.equal(meta.requesterChatId, '424242');
  rmSync(folder, { recursive: true, force: true });
});
