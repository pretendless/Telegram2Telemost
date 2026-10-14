// HTTP helpers for the Worker queue API (claim, plan, drain-complete).

export function queueEndpoints(progressUrl) {
  const base = String(progressUrl || '').replace(/\/progress\/?$/, '');
  return {
    claim: `${base}/queue/claim`,
    plan: `${base}/queue/plan`,
    drainComplete: `${base}/queue/drain-complete`,
  };
}

export function queueAuthHeaders(secret) {
  return {
    authorization: `Bearer ${secret}`,
    'content-type': 'application/json',
    'user-agent': 'tg2tm-queue-drain',
  };
}

export async function fetchQueuePlan(fetchImpl, progressUrl, secret) {
  const { plan } = queueEndpoints(progressUrl);
  if (!plan || !secret) return [];
  const response = await fetchImpl(plan, { headers: { authorization: `Bearer ${secret}` } });
  if (!response.ok) throw new Error(`queue plan http ${response.status}`);
  const data = await response.json();
  return data.items || [];
}

export async function claimQueueItem(fetchImpl, progressUrl, secret, body = {}) {
  const { claim } = queueEndpoints(progressUrl);
  if (!claim || !secret) return { ok: false, claimed: null, queued: 0, active: false };
  const response = await fetchImpl(claim, {
    method: 'POST',
    headers: queueAuthHeaders(secret),
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`queue claim http ${response.status}`);
  const data = await response.json();
  return {
    ok: Boolean(data.ok),
    claimed: data.claimed || null,
    queued: Number(data.queued) || 0,
    active: Boolean(data.active),
  };
}

export async function postDrainComplete(fetchImpl, progressUrl, secret) {
  const { drainComplete } = queueEndpoints(progressUrl);
  if (!drainComplete || !secret) return { ok: false };
  const response = await fetchImpl(drainComplete, {
    method: 'POST',
    headers: queueAuthHeaders(secret),
    body: '{}',
  });
  if (!response.ok) throw new Error(`queue drain-complete http ${response.status}`);
  return response.json();
}

export function queueCredentialsReadable(env = process.env) {
  return Boolean(env.UPLOADER_SECRET) && Boolean(env.TG2TM_PROGRESS_URL);
}
