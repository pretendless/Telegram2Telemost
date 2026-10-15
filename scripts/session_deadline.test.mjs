import assert from 'node:assert/strict';
import test from 'node:test';
import {
  SESSION_HARD_MS,
  SESSION_SOFT_MARGIN_MS,
  checkpointTelemost,
  claimBeforeDeadline,
  parseSessionStartedAt,
  sessionWindow,
} from './session_deadline.mjs';
import { restartShouldNewpack } from './telemost_upload.mjs';

const START = Date.parse('2026-10-14T21:57:24.000Z');

test('soft deadline is 15 minutes before the 6 hour GitHub limit', () => {
  assert.equal(SESSION_HARD_MS, 360 * 60 * 1000);
  assert.equal(SESSION_SOFT_MARGIN_MS, 15 * 60 * 1000);
  const early = sessionWindow({ startedAt: START, now: START + (5 * 60 + 44) * 60 * 1000 });
  const soft = sessionWindow({ startedAt: START, now: START + (5 * 60 + 45) * 60 * 1000 });
  assert.equal(early.pastSoft, false);
  assert.equal(claimBeforeDeadline(early), 'claim');
  assert.equal(soft.pastSoft, true);
  assert.equal(soft.softAt - START, (5 * 60 + 45) * 60 * 1000);
  assert.equal(claimBeforeDeadline(soft), 'stop');
  assert.equal(claimBeforeDeadline(null), 'claim');
  assert.equal(parseSessionStartedAt(String(Math.floor(START / 1000))), START);
});

test('an incomplete checkpoint keeps the sticker index and is not done', () => {
  const tm = checkpointTelemost(
    { status: 'uploading', uploaded: 40, packUrl: null, pendingFile: '041.png' },
    { uploaded: 40, total: 109 },
  );
  assert.equal(tm.status, 'uploading');
  assert.equal(tm.uploaded, 40);
  assert.equal(tm.packUrl, null);
  assert.equal(tm.checkpoint, 'session-deadline');
  assert.equal(tm.pendingFile, null);
  assert.equal(restartShouldNewpack(tm, 109, 'newpack'), false);
  assert.equal(restartShouldNewpack(tm, 109, ''), false);
  const fresh = { status: 'uploading', uploaded: 14, packUrl: null };
  assert.equal(restartShouldNewpack(fresh, 111, 'newpack'), true);
});
