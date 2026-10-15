// The Telemost job is limited to 360 minutes. Leave before GitHub cancels it.

export const SESSION_HARD_MS = 360 * 60 * 1000;
export const SESSION_SOFT_MARGIN_MS = 15 * 60 * 1000;

export function parseSessionStartedAt(raw) {
  const n = Number(String(raw ?? '').trim());
  if (!Number.isFinite(n) || n <= 0) return null;
  return n < 1e12 ? Math.round(n * 1000) : Math.round(n);
}

export function sessionWindow({
  startedAt,
  now = Date.now(),
  hardMs = SESSION_HARD_MS,
  marginMs = SESSION_SOFT_MARGIN_MS,
} = {}) {
  const start = Number(startedAt);
  if (!Number.isFinite(start) || start <= 0) return null;
  const hard = Number(hardMs);
  const margin = Number(marginMs);
  const hardAt = start + (Number.isFinite(hard) && hard > 0 ? hard : SESSION_HARD_MS);
  const softAt = hardAt - (Number.isFinite(margin) && margin >= 0 ? margin : SESSION_SOFT_MARGIN_MS);
  const at = Number(now);
  return {
    start,
    hardAt,
    softAt,
    pastSoft: Number.isFinite(at) && at >= softAt,
  };
}

export function currentSessionWindow(env = process.env, now = Date.now()) {
  const startedAt = parseSessionStartedAt(env && env.SESSION_STARTED_AT);
  if (!startedAt) return null;
  const hardMs = Number(env.SESSION_HARD_MS);
  const marginMs = Number(env.SESSION_SOFT_MARGIN_MS);
  return sessionWindow({
    startedAt,
    now,
    hardMs: Number.isFinite(hardMs) && hardMs > 0 ? hardMs : SESSION_HARD_MS,
    marginMs: Number.isFinite(marginMs) && marginMs >= 0 ? marginMs : SESSION_SOFT_MARGIN_MS,
  });
}

export function pastSessionSoftDeadline(env = process.env, now = Date.now()) {
  const window = currentSessionWindow(env, now);
  return Boolean(window && window.pastSoft);
}

// Stop taking another pack once the soft deadline has passed.
export function claimBeforeDeadline(window) {
  if (window && window.pastSoft) return 'stop';
  return 'claim';
}

// Keep the accepted sticker count. Do not publish the pack and do not zero the index.
export function checkpointTelemost(tm, { uploaded = 0, total = 0 } = {}) {
  const prev = tm && typeof tm === 'object' ? tm : {};
  const done = Math.max(0, Number(uploaded) || 0);
  const all = Math.max(0, Number(total) || 0);
  return {
    ...prev,
    status: 'uploading',
    uploaded: done,
    packUrl: null,
    error: null,
    pendingFile: null,
    checkpoint: done > 0 ? 'session-deadline' : null,
    checkpointTotal: all,
  };
}

export class SessionDeadlineStop extends Error {
  constructor(uploaded, total) {
    super('session-deadline');
    this.name = 'SessionDeadlineStop';
    this.sessionDeadline = true;
    this.uploaded = Number(uploaded) || 0;
    this.total = Number(total) || 0;
  }
}

export function isSessionDeadline(err) {
  return Boolean(err && err.sessionDeadline);
}
