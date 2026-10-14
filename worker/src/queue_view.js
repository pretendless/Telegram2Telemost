/**
 * Admin queue view — single source of truth for “active upload”.
 *
 * Contract (for bc-c3fb423d done pipeline, bc-1d19f525 drain loop):
 * - `loadAdminQueueState(kv)` reads `queue`, reconciles terminal progress on stuck
 *   `uploading` rows, returns `{ queue, activePack, job }`.
 * - `activeUploadJob(queue, activePack)` is the /status one-liner (`adminJobText(job)`).
 * - `adminQueueOverviewText(queue, activePack)` is the /queue body.
 * - Only a queue row with `status === "uploading"` is active; orphan `pack:*` KV keys
 *   (catalog slugs without a queue row) are ignored.
 */
import {
  QUEUE_KEY,
  activeUploadJob,
  adminQueueOverviewText,
  normalizeQueue,
  queueItemSlug,
  unstickUploadingQueue,
} from "./logic.js";

export { activeUploadJob, adminQueueOverviewText };

function parseStored(raw) {
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export function reconcileTerminalUploadingFromProgress(queue, packByItemId) {
  return unstickUploadingQueue(queue, {
    packForItem: (item) => (packByItemId && packByItemId[item.id]) || null,
    terminalOnly: true,
  });
}

export async function loadAdminQueueState(kv) {
  let queue = normalizeQueue(parseStored(await kv.get(QUEUE_KEY)));
  const packByItemId = {};
  for (const item of queue.items) {
    if (item.status !== "uploading") continue;
    packByItemId[item.id] = parseStored(await kv.get(`pack:${queueItemSlug(item)}`));
  }
  const reconciled = reconcileTerminalUploadingFromProgress(queue, packByItemId);
  if (reconciled.changed) {
    await kv.put(QUEUE_KEY, JSON.stringify(reconciled.queue));
    queue = reconciled.queue;
  }
  const uploading = queue.items.find((item) => item.status === "uploading");
  let activePack = null;
  if (uploading) {
    activePack =
      packByItemId[uploading.id] != null
        ? packByItemId[uploading.id]
        : parseStored(await kv.get(`pack:${queueItemSlug(uploading)}`));
  }
  return {
    queue,
    activePack,
    job: activeUploadJob(queue, activePack),
    reconcile: {
      changed: reconciled.changed,
      finished: reconciled.finished || [],
    },
  };
}
