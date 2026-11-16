// Display freshness only: never infer LIVE/OFFLINE from snapshot age.
// Keep this function self-contained: render.mjs emits the same function to the browser.
export function assessFreshness(sampledAt, nowMs = Date.now()) {
  const sampledMs = typeof sampledAt === 'string' && sampledAt.trim() ? Date.parse(sampledAt) : NaN;
  if (!Number.isFinite(nowMs) || !Number.isFinite(sampledMs) || sampledMs > nowMs + 5 * 60000) {
    return { state: 'UNKNOWN', ageMinutes: null, text: '采集时间无法确认' };
  }
  const ageMinutes = Math.max(0, Math.floor((nowMs - sampledMs) / 60000));
  const state = nowMs - sampledMs > 180 * 60000 ? 'STALE' : 'CURRENT';
  return { state, ageMinutes, text: state === 'STALE' ? `已超过 3 小时（约 ${ageMinutes} 分钟前），需核对` : `约 ${ageMinutes} 分钟前采集` };
}
