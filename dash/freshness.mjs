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

export function beijingDay(nowMs, shiftHours = 0) {
  return new Date(nowMs + (8 - shiftHours) * 3600000).toISOString().slice(0, 10);
}

export function isCountable(row, nowMs = Date.now()) {
  return !!row && (row.kind === 'seen' || row.kind === 'unseen') && !row.blocked &&
    row.date === beijingDay(nowMs, row.platform === 'jd' ? 0 : 6) &&
    assessFreshness(row.at, nowMs).state === 'CURRENT';
}

// These are cron opportunities, not evidence of a successful publication.
export function nextRefreshAfter(generatedAt) {
  const ms = Date.parse(generatedAt);
  const minute = new Date(ms).getUTCMinutes();
  const delta = minute < 3 ? 3 - minute : minute < 33 ? 33 - minute : 63 - minute;
  return new Date(Math.floor(ms / 60000) * 60000 + delta * 60000).toISOString();
}

export function assessRefresh(dueAt, nowMs = Date.now()) {
  const due = Date.parse(dueAt);
  if (!Number.isFinite(due) || !Number.isFinite(nowMs)) return { state: 'UNKNOWN', text: '刷新计划无法确认' };
  if (nowMs >= due) return { state: 'OVERDUE', text: '已过计划刷新时间，本页仍是此版快照' };
  return { state: 'PENDING', text: '计划时间，尚未确认刷新' };
}
