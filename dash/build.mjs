// Builds the four masked dashboard datasets from the public GitHub Actions run logs.
// Inputs: jd.log (R327_JD_DAY), dy.log (R325_DAILY, R316_RPA), tm.log (R325_DAILY, R329_TMALL). Output: out/*.json
import fs from 'node:fs';
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
const tmKeys = JSON.parse(fs.readFileSync(M + 'probe-targets.json', 'utf8')).tmall.map(t => t.key);
const dyLabel = k => { const i = dyKeys.indexOf(k); if (i < 0) throw new Error('DY_KEY_UNMAPPED'); return '#' + (i + 1); };
const tmLabel = k => { const i = tmKeys.indexOf(k); if (i < 0) throw new Error('TM_KEY_UNMAPPED'); return 'T' + (i + 1); };
const daily = (lines) => Object.values(Object.fromEntries(lines.map(strip).filter(l => l.startsWith('R325_DAILY {')).map(l => JSON.parse(l.slice(11)))
  .filter(d => d && typeof d.key === 'string' && /^\d{4}-\d\d-\d\d$/.test(d.date) && typeof d.samples === 'number').map(d => [d.key + '|' + d.date, d])));
const stamp = d => d.toISOString();
const runIds = { jd: process.env.RUN_JD || 43595261311, dy: process.env.RUN_DY || 43593315399, tm: process.env.RUN_TM || 43593317583 };
const prov = (extra) => [{ label: '来源', value: extra }, { label: '整理', value: '脚本 build.mjs 解析 GitHub Actions 运行日志里的结构化行，账号统一用 #1–#7、T1–T9、jd-编号代替，不含任何真实标识。' }, { label: '性质', value: '快照，不是实时；只读采样，不用于处罚。' }];

// ---------- Douyin
const dyLines = L('dy.log');
const rpa = dyLines.map(strip).filter(l => l.startsWith('R316_RPA {')).map(l => JSON.parse(l.slice(9)));
const dyAts = rpa.map(r => r.at).sort();
const dyRows = daily(dyLines).map(d => ({ account: dyLabel(d.key), role: dyKeys.indexOf(d.key) < 4 ? '考核' : '仅监测', date: d.date, result: RES[d.status], seen: span(d.firstSeenAt, d.lastSeenAt), seenFrom: d.firstSeenAt || null, seenTo: d.lastSeenAt || null, samples: d.verifiedSamples }))
  .sort((a, b) => b.date.localeCompare(a.date) || num(a.account) - num(b.account));
const dyStopLine = stopLine(dyLines, 'R316_RPA_STOPPED');
const dyStopped = !!dyStopLine || rpa.some(r => r.stop);
const dyPause = pauseOf(dyStopped ? (dyStopLine && tsOf(dyStopLine)) || rpa.find(r => r.stop)?.at || null : null);
// ---------- Tmall
const tmLines = L('tm.log');
const tmRecs = tmLines.map(strip).filter(l => l.startsWith('R329_TMALL {')).map(l => JSON.parse(l.slice(11)));
const tmTs = tmLines.filter(l => l.includes('R329_TMALL {')).map(tsOf).filter(Boolean).sort();
const tmStopLine = stopLine(tmLines, 'R329_TMALL_STOPPED');
const tmStopped = !!tmStopLine || tmRecs.some(r => String(r.reason || '').startsWith('STOPPED_'));
const tmPause = pauseOf(tmStopped ? (tmStopLine && tsOf(tmStopLine)) || tmTs.at(-1) || null : null);
const tmDaily = daily(tmLines);
const tmLatest = tmDaily.map(d => d.date).sort().pop();
const nowText = r => !r ? '—' : r.state === 'LIVE' ? '在播' + (r.sourceStartTime ? ' · ' + hhmm(r.sourceStartTime) + ' 开始' : '') : r.state === 'OFFLINE' ? '接口显示未开播' : r.state === 'NOT_RUN' ? '未执行' : '无法判断';
const tmRows = tmDaily.map(d => ({ shop: tmLabel(d.key), date: d.date, result: RES[d.status], seen: span(d.firstSeenAt, d.lastSeenAt), seenFrom: d.firstSeenAt || null, seenTo: d.lastSeenAt || null, samples: d.verifiedSamples, now: d.date === tmLatest ? nowText(tmRecs.find(r => r.key === d.key)) : '—', nowStart: d.date === tmLatest ? (tmRecs.find(r => r.key === d.key && r.state === 'LIVE')?.sourceStartTime ?? null) : null }))
  .sort((a, b) => b.date.localeCompare(a.date) || num(a.shop) - num(b.shop));
// ---------- JD
const jdLines = L('jd.log');
const jd = jdLines.map(strip).filter(l => l.startsWith('R327_JD_DAY ')).map(l => JSON.parse(l.slice(12)));
const jdAt = jdLines.filter(l => l.includes('R327_JD_FULLDAY ')).map(tsOf).filter(Boolean).pop();
const jdFull = JSON.parse(strip(jdLines.find(l => l.includes('R327_JD_FULLDAY '))).slice(16));
// JD follows the broadcast day the Douyin/Tmall results show, so one page never mixes two days
// (a JD run after midnight, or the 08:02 snapshot before the first Douyin/Tmall sample of the day).
const pageDay = [...dyRows.map(r => r.date), ...tmRows.map(r => r.date)].sort().at(-1);
const dates = [...new Set(jd.map(r => r.date))].sort(), today = dates.includes(pageDay) ? pageDay : dates.at(-1);
if (!today) throw new Error('JD_DAILY_DATA_MISSING');
// Do not relabel an older record as the previous calendar day.
const prevDate = new Date(Date.parse(today + 'T00:00:00Z') - 864e5).toISOString().slice(0, 10);
const pct = a => a[0] === a[1] ? a[0] + '%' : a[0] + '%–' + a[1] + '%';
const ids = [...new Set(jd.map(r => r.roomId))].sort((a, b) => a - b);
const jdRows = ids.map(id => {
  const t = jd.find(r => r.roomId === id && r.date === today), p = jd.find(r => r.roomId === id && r.date === prevDate);
  const snap = p?.method === 'FROM_0800_SNAPSHOT' && Number.isFinite(p.ratePercent);
  const range = Array.isArray(p?.routineAssumedRangePercent) && p.routineAssumedRangePercent.length === 2 && p.routineAssumedRangePercent.every(Number.isFinite);
  return { room: 'jd-' + id, category: t?.category ?? p?.category ?? jd.find(r => r.roomId === id)?.category ?? '—', todayDate: today,
    todayMissing: !t, previousMissing: !p,
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
  { platform: '京东', asOf: hhmm(jdAt), atFrom: jdAt || null, atTo: jdAt || null, checked: jdFull.rooms, reachable: jdFull.dailyOk, verified: '—', note: '运营平台只读，读每日分钟数' },
  { platform: '抖音', asOf: span(dyAts[0], dyAts.at(-1)), atFrom: dyAts[0] || null, atTo: dyAts.at(-1) || null, checked: rpa.length, reachable: rpa.filter(r => r.profileHttp === 200).length, verified: rpa.filter(r => r.state !== 'NOT_RUN' && r.profileIdentityVerified).length, pause: dyPause, note: dyStopped ? '平台要求验证，按规则暂停 24 小时' : '没有被拦，没有进入冷却' },
  { platform: '天猫淘宝', asOf: span(tmTs[0], tmTs.at(-1)), atFrom: tmTs[0] || null, atTo: tmTs.at(-1) || null, checked: tmRecs.length, reachable: tmRecs.filter(r => r.http === 200).length, verified: tmRecs.filter(r => r.identityVerified).length, pause: tmPause, note: tmStopped ? '平台要求验证，按规则暂停 24 小时' : '没有被拦，没有进入冷却' },
];
if (!jdRows.length || !dyRows.length || !tmRows.length || !rpa.length || !tmRecs.length) throw new Error('EMPTY_DATASET jd=' + jdRows.length + ' dy=' + dyRows.length + ' tm=' + tmRows.length + ' rpa=' + rpa.length + ' tmRecs=' + tmRecs.length);
fs.mkdirSync('out', { recursive: true });
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
