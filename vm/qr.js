// Pick a roughly square visible widget. Yandex draws the login QR as canvas, img or svg.

export function pickQrRect(boxes) {
  const good = (boxes || []).filter((box) => {
    const w = Number(box && box.w);
    const h = Number(box && box.h);
    const x = Number(box && box.x);
    const y = Number(box && box.y);
    if (![w, h, x, y].every(Number.isFinite)) return false;
    if (w < 120 || h < 120) return false;
    if (Math.abs(w - h) / Math.max(w, 1) > 0.2) return false;
    if (x < 0 || y < 0) return false;
    return true;
  });
  good.sort((a, b) => b.w - a.w);
  const best = good[0];
  if (!best) return null;
  return {
    x: Math.round(best.x),
    y: Math.round(best.y),
    width: Math.round(best.w),
    height: Math.round(best.h),
  };
}
