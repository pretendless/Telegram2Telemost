// Actions always() step. A clean deadline exit already called /session-ended.
// A hard cancel never got that far: tell the Worker once so it can resume.
import { existsSync } from 'fs';
import { postSessionEnded } from './queue_client.mjs';

const job = String(process.env.JOB_STATUS || '').trim();
const marked = existsSync('logs/session-deadline.json');
const cancelled = job === 'cancelled';

if (!marked && !cancelled) {
  console.log('session-ended skipped', job || 'no-status');
  process.exit(0);
}

const secret = process.env.UPLOADER_SECRET || '';
const progress = process.env.TG2TM_PROGRESS_URL || '';
const runId = String(process.env.RUN_ID || process.env.GITHUB_RUN_ID || '').trim();
const runUrl = String(process.env.RUN_URL || '').trim();

try {
  const result = await postSessionEnded(fetch, progress, secret, {
    runId,
    runUrl,
    reason: marked ? 'deadline' : 'cancelled',
  });
  console.log('session-ended', JSON.stringify(result));
} catch (err) {
  console.log('session-ended failed', err && err.message ? err.message : err);
}
