// Builds the four masked dashboard datasets from the public GitHub Actions run logs.
// Inputs: jd.log (R327_JD_DAY), dy.log (R325_DAILY, R316_RPA), tm.log (R325_DAILY, R329_TMALL). Output: out/*.json
import fs from 'node:fs';
import path from 'node:path';
import { beijingDay } from './freshness.mjs';
import { readV2 } from './v2.mjs';
import { legacyTmallLabels } from './tmall-labels.mjs';
const M = (process.env.MAIN_DIR || '/tmp/mainsrc') + '/main-';   // config files fetched from main by refresh.sh
const strip = l => l.replace(/\x1b\[[0-9;]*m/g, '').replace(/^[^\t]*\t[^\t]*\t[^ ]*Z /, '');
const tsOf = l => (l.match(/\t[﻿]?(\d{4}-\d\d-\d\dT[\d:.]+Z) /) || [])[1] || null;
const L = f => fs.readFileSync(f, 'utf8').split('\n');
const hhmm = x => x ? new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(x)) : null;
const span = (a, b) => !a ? '—' : (hhmm(a) === hhmm(b) || !b) ? hhmm(a) : hhmm(a) + '–' + hhmm(b);
const keysOf = f => JSON.parse(fs.readFileSync(M + f.replace(/^config\//, ''), 'utf8')).targets.map(t => t.key);
const num = s => Number(String(s).replace(/\D+/g, '')) || 0;
const RES = { BROADCAST_SEEN: '已开播', NOT_SEEN_IN_SAMPLES: '采样中未见（不等于没播）', UNKNOWN: '无法判断' };
// A stop (verification, 403, 429, login) starts the collectors' 24-hour cooldown; later runs skip sampling until it ends.
// The probes print 'R316_RPA_STOPPED <json>' / 'R329_TMALL_STOPPED <json>' on every run; the value is null unless the run was stopped.
const stopLine = (lines, tag) => lines.find(l => { const s = strip(l); if (!s.startsWith(tag + ' ')) return false; try { return !!JSON.parse(s.slice(tag.length + 1)); } catch { return false; } }) || null;
const pauseOf = t => t ? { from: t, until: new Date(Date.parse(t) + 24 * 3600e3).toISOString() } : null;

const dyKeys = [...keysOf('config/r316-douyin-rpa-targets.json'), ...keysOf('config/r326-douyin-targets-scoring-b.json'), ...keysOf('config/r329-douyin-targets-monitor-c.json'), ...keysOf('config/r329-douyin-targets-monitor-d.json')];
const tmLabel = legacyTmallLabels(JSON.parse(fs.readFileSync(M + 'probe-targets.json', 'utf8')).tmall);
const dyLabel = k => { const i = dyKeys.indexOf(k); if (i < 0) throw new Error('DY_KEY_UNMAPPED'); return '#' + (i + 1); };
const daily = (lines) => Object.values(Object.fromEntries(lines.map(strip).filter(l => l.startsWith('R325_DAILY {')).map(l => JSON.parse(l.slice(11)))
  .filter(d => d && typeof d.key === 'string' && /^\d{4}-\d\d-\d\d$/.test(d.date) && typeof d.samples === 'number').map(d => [d.key + '|' + d.date, d])));
const runIds = { jd: process.env.RUN_JD || 43595261311, dy: process.env.RUN_DY || 43593315399, tm: process.env.RUN_TM || 43593317583 };
const prov = (extra) => [{ label: '来源', value: extra }, { label: '整理', value: '脚本 build.mjs 解析 GitHub Actions 运行日志里的结构化行，账号统一用 #1–#7、T1–T9、jd-编号代替，不含任何真实标识。' }, { label: '性质', value: '快照，不是实时；只读采样，不用于处罚。' }];
const asIso = value => {
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT[\d:.]+Z$/.test(value)) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) && ms <= Date.now() ? new Date(ms).toISOString() : null;
};
const newest = values => values.map(asIso).filter(Boolean).sort().at(-1) || null;
const ownRoom = new Set(['OWNER_HEADER_LIVE_ANCHOR', 'REGISTERED_ROOM_LIVE_ANCHOR']);
const dyVerified = r => r.profileIdentityVerified === true && r.state !== 'NOT_RUN' &&
  ((r.state === 'LIVE' && (r.roomIdentityVerified === true || r.roomPageIdentityVerified === true)) ||
    r.state === 'OFFLINE' || (r.liveBadgeSeen === true && ownRoom.has(r.ownerAnchorScope)));
const tmVerified = r => r.identityVerified === true && (r.state === 'LIVE' || r.state === 'OFFLINE');
const evidenceAt = (day, timestamp) => {
  const at = asIso(timestamp);
  return at && beijingDay(Date.parse(at),6) === day ? at : null;
};
const runConclusions = new Set(['success', 'failure', 'cancelled', 'timed_out', 'action_required', 'skipped', 'neutral', 'stale', 'startup_failure']);
function latestRun(name) {
  try {
    const r = JSON.parse(process.env[name] || 'null');
    const at = asIso(r?.at);
    if (Number.isSafeInteger(r?.id) && r.id > 0 && at && runConclusions.has(r.conclusion)) {
      return { id: r.id, at, conclusion: r.conclusion };
    }
  } catch {}
  return null;
}

// ---------- Douyin
const dyLines = L('dy.log');
const rpa = dyLines.map(strip).filter(l => l.startsWith('R316_RPA {')).map(l => JSON.parse(l.slice(9)));
const dyAts = rpa.filter(r => r.state !== 'NOT_RUN').map(r => asIso(r.at)).filter(Boolean).sort();
const dyRows = daily(dyLines).map(d => ({
  account: dyLabel(d.key), role: dyKeys.indexOf(d.key) < 4 ? '考核' : '仅监测', date: d.date, result: RES[d.status], seen: span(d.firstSeenAt, d.lastSeenAt),
  seenFrom: d.firstSeenAt || null, seenTo: d.lastSeenAt || null, samples: d.verifiedSamples,
  verifiedAt: d.verifiedSamples > 0 ? d.status === 'BROADCAST_SEEN' ? evidenceAt(d.date,d.lastSeenAt)
    : newest(rpa.filter(r => r.key === d.key && dyVerified(r)).map(r => evidenceAt(d.date,r.at))) : null
}))
  .sort((a, b) => b.date.localeCompare(a.date) || num(a.account) - num(b.account));
const dyStopLine = stopLine(dyLines, 'R316_RPA_STOPPED');
const dyStopped = !!dyStopLine || rpa.some(r => r.stop);
const dyPause = pauseOf(dyStopped ? (dyStopLine && tsOf(dyStopLine)) || rpa.find(r => r.stop)?.at || null : null);
// ---------- Tmall
const tmLines = L('tm.log');
const tmRecs = tmLines.flatMap(l => {
  const record = strip(l);
  if (!record.startsWith('R329_TMALL {')) return [];
  const r = JSON.parse(record.slice(11));
  return r.state === 'NOT_RUN' ? [] : [{ ...r, loggedAt: asIso(tsOf(l)) }];
});
const tmTs = tmRecs.map(r => r.loggedAt).filter(Boolean).sort();
const tmStopLine = stopLine(tmLines, 'R329_TMALL_STOPPED');
const tmStopped = !!tmStopLine || tmRecs.some(r => String(r.reason || '').startsWith('STOPPED_'));
const tmPause = pauseOf(tmStopped ? (tmStopLine && tsOf(tmStopLine)) || tmTs.at(-1) || null : null);
const tmDaily = daily(tmLines);
const tmLatest = tmDaily.map(d => d.date).sort().pop();
const nowText = r => !r ? '—' : !tmVerified(r) ? '无法判断' : r.state === 'LIVE' ? '在播' + (r.sourceStartTime ? ' · ' + hhmm(r.sourceStartTime) + ' 开始' : '') : '接口显示未开播';
const tmRows = tmDaily.map(d => ({
  shop: tmLabel(d.key), date: d.date, result: RES[d.status], seen: span(d.firstSeenAt, d.lastSeenAt),
  seenFrom: d.firstSeenAt || null, seenTo: d.lastSeenAt || null, samples: d.verifiedSamples,
  verifiedAt: d.verifiedSamples > 0 ? d.status === 'BROADCAST_SEEN' ? evidenceAt(d.date,d.lastSeenAt)
    : newest(tmRecs.filter(r => r.key === d.key && tmVerified(r)).map(r => evidenceAt(d.date,r.loggedAt))) : null,
  now: d.date === tmLatest ? nowText(tmRecs.find(r => r.key === d.key)) : '—',
  nowStart: d.date === tmLatest ? (tmRecs.find(r => r.key === d.key && r.state === 'LIVE' && tmVerified(r))?.sourceStartTime ?? null) : null
}))
  .sort((a, b) => b.date.localeCompare(a.date) || num(a.shop) - num(b.shop));
// ---------- JD
const jdLines = L('jd.log');
const jd = jdLines.map(strip).filter(l => l.startsWith('R327_JD_DAY ')).map(l => JSON.parse(l.slice(12)));
const jdFullLine = jdLines.filter(l => strip(l).startsWith('R327_JD_FULLDAY {')).at(-1);
if (!jdFullLine) throw new Error('JD_RUN_SUMMARY_MISSING');
const jdFull = JSON.parse(strip(jdFullLine).slice(16));
const jdAt = asIso(jdFull.attemptedAt) || asIso(tsOf(jdFullLine));
// Older success logs used only a read timestamp; newer logs provide observation time.
const jdVerifiedAt = Object.hasOwn(jdFull,'sourceStatus') ? asIso(jdFull.lastSuccessfulSourceAt)
  : jdFull.dailyOk > 0 ? jdAt : null;
// JD uses a calendar day, while Douyin/Tmall change broadcast day at 06:00.
const today = beijingDay(Date.now());
// Do not relabel an older record as the previous calendar day.
const prevDate = new Date(Date.parse(today + 'T00:00:00Z') - 864e5).toISOString().slice(0, 10);
const pct = a => a[0] === a[1] ? a[0] + '%' : a[0] + '%–' + a[1] + '%';
const ids = [...new Set(jd.map(r => r.roomId))].sort((a, b) => a - b);
const jdRows = ids.map(id => {
  const t = jd.find(r => r.roomId === id && r.date === today), p = jd.find(r => r.roomId === id && r.date === prevDate);
  const h = jd.filter(r => r.roomId === id && r.date < today).sort((a,b) => b.date.localeCompare(a.date))[0];
  const snap = p?.method === 'FROM_0800_SNAPSHOT' && Number.isFinite(p.ratePercent);
  const range = Array.isArray(p?.routineAssumedRangePercent) && p.routineAssumedRangePercent.length === 2 && p.routineAssumedRangePercent.every(Number.isFinite);
  return { room: 'jd-' + id, category: t?.category ?? p?.category ?? jd.find(r => r.roomId === id)?.category ?? '—', todayDate: today,
    todayMissing: !t, previousMissing: !p,
    verifiedAt: t && (Number.isFinite(t.soFarMinutes) || Number.isFinite(t.totalDayMinutes))
      ? (Object.hasOwn(t,'observedAt') ? asIso(t.observedAt) : jdVerifiedAt) : null,
    historyDate: h?.date ?? null, historyMinutes: h?.totalDayMinutes ?? h?.soFarMinutes ?? null,
    live8: t?.liveByWindowStart === true ? '是' : t?.liveByWindowStart === false ? '否' : '—',
    minutesToday: t?.soFarMinutes ?? t?.totalDayMinutes ?? null,
    dayRate: t?.method === 'FROM_0800_SNAPSHOT' && Number.isFinite(t.ratePercent) ? t.ratePercent + '%' : '',
    prevDate, prevRate: snap ? p.ratePercent + '%' : range ? pct(p.routineAssumedRangePercent) : '—',
    prevBasis: !p ? '无上一日记录' : snap ? '按 8 点快照计算' : range ? '估算（无 8 点快照）' : '无可用上一日结果',
    prevMinutes: p?.totalDayMinutes ?? null, prevLast: p?.lastMinuteBeijing ?? '—',
    prevEnd: p?.reachedWindowEnd === true ? '播到 24 点' : p?.reachedWindowEnd === false ? '没播到 24 点' : '—' };
});
// ---------- runs
// Douyin 'verified' uses the daily-ledger rule (profile identity checked); the room itself can only be checked while it is live.
const runsRows = [
  { platform: '京东', asOf: hhmm(jdAt), atFrom: jdAt, atTo: jdAt, verifiedAt: jdVerifiedAt,
    latestRun: latestRun('LATEST_JD_RUN'), checked: jdFull.rooms, reachable: jdFull.dailyOk, verified: '—', note: '运营平台只读，读每日分钟数' },
  { platform: '抖音', asOf: span(dyAts[0], dyAts.at(-1)), atFrom: dyAts[0] || null, atTo: dyAts.at(-1) || null,
    verifiedAt: newest([...dyRows.map(r => r.verifiedAt), ...rpa.filter(dyVerified).map(r => r.at)]),
    latestRun: latestRun('LATEST_DY_RUN'), checked: rpa.filter(r => r.state !== 'NOT_RUN').length,
    reachable: rpa.filter(r => r.state !== 'NOT_RUN' && r.profileHttp === 200).length, verified: rpa.filter(dyVerified).length, pause: dyPause },
  { platform: '天猫淘宝', asOf: span(tmTs[0], tmTs.at(-1)), atFrom: tmTs[0] || null, atTo: tmTs.at(-1) || null,
    verifiedAt: newest([...tmRows.map(r => r.verifiedAt), ...tmRecs.filter(tmVerified).map(r => r.loggedAt)]),
    latestRun: latestRun('LATEST_TM_RUN'), checked: tmRecs.length, reachable: tmRecs.filter(r => r.http === 200).length,
    verified: tmRecs.filter(tmVerified).length, pause: tmPause },
];
if (!jdRows.length || !dyRows.length || !tmRows.length || !rpa.length || !tmRecs.length) throw new Error('EMPTY_DATASET jd=' + jdRows.length + ' dy=' + dyRows.length + ' tm=' + tmRows.length + ' rpa=' + rpa.length + ' tmRecs=' + tmRecs.length);
const privateDir = process.env.V2_PRIVATE_DIR;
const v2 = privateDir && fs.existsSync(path.join(privateDir, 'source.json'))
  ? readV2(privateDir)
  : { source: null, rows: [], counts: null };
let latest = null;
if (privateDir) {
  const run = JSON.parse(fs.readFileSync(path.join(privateDir, 'latest.json'), 'utf8'));
  if (run !== null) {
    const at = asIso(run.at);
    if (typeof run.runId !== 'string' || !/^[1-9]\d{0,19}$/.test(run.runId) ||
        !Number.isSafeInteger(run.attempt) || run.attempt < 1 || !at || !runConclusions.has(run.conclusion)) {
      throw new Error('V2_INVALID_LATEST_RUN');
    }
    latest = { runId: run.runId, attempt: run.attempt, at, conclusion: run.conclusion };
  }
}
fs.mkdirSync('out', { recursive: true });
fs.writeFileSync('out/v2.json', JSON.stringify({ ...v2, latest }));
const write = (name, rows, meta) => fs.writeFileSync('out/' + name + '.json', JSON.stringify({ rows, meta }, null, 1));
write('jd', jdRows, prov('京东：GitHub Actions 运行 ' + runIds.jd + '（jd-fullday-rate，读运营平台每日分钟数）'));
write('douyin', dyRows, prov('抖音：GitHub Actions 运行 ' + runIds.dy + '（douyin-daily-broadcast，含前几次的 7 天台账）'));
write('tmall', tmRows, prov('天猫淘宝：GitHub Actions 运行 ' + runIds.tm + '（tmall-daily-broadcast，含前几次的 7 天台账）'));
write('runs', runsRows, prov('三个平台各自最近一次运行：京东 ' + runIds.jd + '，抖音 ' + runIds.dy + '，天猫淘宝 ' + runIds.tm));
console.log('rows:', { jd: jdRows.length, douyin: dyRows.length, tmall: tmRows.length, runs: runsRows.length }, 'today', today, 'prev', prevDate);
console.log(JSON.stringify(runsRows));
console.log(JSON.stringify(jdRows.slice(0, 2)));
console.log(JSON.stringify(dyRows.slice(0, 2)), JSON.stringify(tmRows.slice(0, 2)));
console.log('tmall offline row sample:', JSON.stringify(tmRows.find(r => r.now.startsWith('接口'))));
