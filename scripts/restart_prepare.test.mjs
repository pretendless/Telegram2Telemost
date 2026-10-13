import assert from 'node:assert/strict';
import test from 'node:test';
import { githubOutputValue, restartGithubOutput } from './restart_prepare.mjs';
import { restartTarget } from './telemost_upload.mjs';

test('restart github output uses single-line keys, not raw JSON', () => {
  const text = restartGithubOutput({
    action: 'seen',
    title: '',
    lastLine: '11:57',
  });
  assert.equal(text, [
    'action=seen',
    'restart_seen_title=',
    'restart_seen_last_line=11:57',
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
  assert.equal(text.split('\n').length, 4);
  assert.match(text, /^restart_seen_title=Юг ещё$/m);
  assert.match(text, /^restart_seen_last_line=Отправьте эмодзи для стикера\.$/m);
});

test('empty title on an open dialog does not hard-fail prepare', () => {
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
  const unmatched = restartTarget({
    unfinished: true,
    title: '',
    liveText: '11:57\nОтправьте эмодзи для стикера.',
    catalogs,
    requests: [],
  });
  assert.equal(unmatched.action, 'seen');
  assert.equal(unmatched.title, '');
  const output = restartGithubOutput({
    action: unmatched.action,
    title: unmatched.title,
    lastLine: '11:57',
  });
  assert.match(output, /^action=seen$/m);
  assert.match(output, /^restart_seen_title=$/m);
});
