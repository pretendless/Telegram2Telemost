// One notice and at most one replacement run when a Telemost session hits the GitHub limit.

export const SESSION_END_PREFIX = 'meta:session-end:';

export const SESSION_LIMIT_TEXT = 'Сессия достигла лимита GitHub, продолжу в новом запуске';

export function formatSessionLimitMessage(runUrl) {
  const url = String(runUrl || '').trim();
  const lines = [SESSION_LIMIT_TEXT];
  if (url) lines.push(url);
  return lines.join('\n');
}

export function sessionEndKey(runId) {
  const id = String(runId || '').trim();
  if (!/^[0-9]{1,16}$/.test(id)) return null;
  return `${SESSION_END_PREFIX}${id}`;
}

// Queued work, or an uploading row that still has to be resumed. Done rows are not work.
export function sessionEndRestart(queue) {
  const items = (queue && queue.items) || [];
  const pending = items.some((item) => item && (item.status === 'queued' || item.status === 'uploading'));
  return pending ? 'restart' : 'idle';
}

// Leave uploading rows uploading. A deadline checkpoint must not be marked done.
export function resumableAfterSessionEnd(queue) {
  const items = (queue && queue.items) || [];
  return {
    queue,
    changed: false,
    uploading: items.filter((item) => item && item.status === 'uploading').map((item) => item.id),
    queued: items.filter((item) => item && item.status === 'queued').map((item) => item.id),
  };
}

export async function finalizeSessionOnce(kv, { runId, runUrl, queue, notify, dispatch } = {}) {
  const key = sessionEndKey(runId);
  if (!key || !kv) return { ok: false, duplicate: false, decision: 'idle', dispatched: false, reason: 'bad-run' };
  if (await kv.get(key)) {
    return { ok: true, duplicate: true, decision: 'idle', dispatched: false, reason: 'duplicate' };
  }
  await kv.put(key, JSON.stringify({ state: 'open', at: new Date().toISOString() }));
  const kept = resumableAfterSessionEnd(queue);
  const decision = sessionEndRestart(kept.queue);
  if (typeof notify === 'function') await notify(formatSessionLimitMessage(runUrl));
  let dispatched = false;
  if (decision === 'restart' && typeof dispatch === 'function') {
    const result = await dispatch();
    dispatched = Boolean(result && (result.started || result.ok));
  }
  await kv.put(key, JSON.stringify({ state: 'done', decision, dispatched, at: new Date().toISOString() }));
  return { ok: true, duplicate: false, decision, dispatched, reason: decision, uploading: kept.uploading };
}
