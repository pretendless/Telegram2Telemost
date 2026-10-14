// Build workflow dispatch_reason strings with pack titles when known.

export function oneLineTitle(title) {
  return String(title || "").replace(/\s+/g, " ").trim();
}

function byTime(left, right) {
  return left.createdAt < right.createdAt ? -1 : left.createdAt > right.createdAt ? 1 : left.id < right.id ? -1 : 1;
}

/** Next queued request (priority first, FIFO within band). Matches restart_prepare on an idle dialog. */
export function nextAutostartPackTitle(queue) {
  const items = ((queue && queue.items) || []).filter(Boolean);
  const waiting = items.filter((item) => item.status === "queued").sort(byTime);
  const priority = waiting.filter((item) => item.priority);
  const next = (priority.length ? priority : waiting)[0] || null;
  return next ? oneLineTitle(next.title) : "";
}

/** Title of the pack this pipeline run will work on (uploading row, else next queued). */
export function nextQueuePackTitle(queue) {
  const items = ((queue && queue.items) || []).filter(Boolean);
  const uploading = items.find((item) => item.status === "uploading");
  if (uploading) return oneLineTitle(uploading.title);
  return nextAutostartPackTitle(queue);
}

export function reasonAlreadyNamesPack(reason, packTitle) {
  const title = oneLineTitle(packTitle);
  if (!title) return false;
  return String(reason || "").includes(`«${title}»`);
}

/** Append «title» when we know it and the base reason does not already name it. */
export function withPackTitle(baseReason, packTitle) {
  const base = String(baseReason || "").replace(/[\r\n]+/g, " ").trim();
  const title = oneLineTitle(packTitle);
  if (!title || reasonAlreadyNamesPack(base, title)) return base.slice(0, 200);
  const combined = base ? `${base} — «${title}»` : `«${title}»`;
  return combined.slice(0, 200);
}

export function formatPackTitleList(titles) {
  const clean = (titles || []).map(oneLineTitle).filter(Boolean);
  if (!clean.length) return "";
  return clean.map((t) => `«${t}»`).join(", ");
}

function reasonHasQuotedTitle(reason) {
  return /«[^»]+»/.test(String(reason || ""));
}

/**
 * On the Actions runner: add repo pack titles for upload when PACKS is set.
 * @param {object} opts
 * @param {string} opts.dispatchReason
 * @param {string} opts.mode
 * @param {string} opts.packs
 * @param {(packs: string) => string[]} [opts.resolveTitles]
 */
export function enrichDispatchReason({ dispatchReason, mode, packs, resolveTitles } = {}) {
  let reason = String(dispatchReason || "").replace(/[\r\n]+/g, " ").trim();
  const name = String(mode || "").trim().toLowerCase();
  const nums = String(packs || "").trim();
  if (name === "upload" && nums && typeof resolveTitles === "function" && !reasonHasQuotedTitle(reason)) {
    const titles = resolveTitles(nums);
    const list = formatPackTitleList(titles);
    if (list) reason = reason ? `${reason} — ${list}` : list;
  }
  return reason.slice(0, 200);
}

export const QUEUE_REASON = {
  newRequest: "очередь: новый запрос принят",
  afterFinish: "очередь: следующий пак после завершения",
  afterUnstick: "очередь: автозапуск после /unstick",
  afterSkip: "очередь: автозапуск после /skip",
  afterDrainSession: "очередь: автозапуск после сессии drain",
  autostart: "очередь: автозапуск pipeline (есть работа в KV)",
};

export function queuePipelineReason(scenario, queue, { preferTitle, preferQueued = false } = {}) {
  const title =
    oneLineTitle(preferTitle) ||
    (preferQueued ? nextAutostartPackTitle(queue) || nextQueuePackTitle(queue) : nextQueuePackTitle(queue));
  return withPackTitle(scenario, title);
}

export function adminRestartReason(queue) {
  const title = nextAutostartPackTitle(queue) || nextQueuePackTitle(queue);
  return withPackTitle("админ: /restart", title);
}

export function adminUploadReason(packs, { packTitles } = {}) {
  const base = `админ: /upload ${String(packs || "").trim()}`.trim();
  const list = formatPackTitleList(packTitles || []);
  if (list && !reasonHasQuotedTitle(base)) return `${base} — ${list}`.slice(0, 200);
  return base.slice(0, 200);
}
