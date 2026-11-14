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
const dyRows = daily(dyLines).map(d => ({ account: dyLabel(d.key), role: dyKeys.indexOf(d.key) < 4 ? '考核' : '仅监测', date: d.date, result: RES[d.status], seen: span(d.firstSeenAt, d.lastSeenAt), samples: d.verifiedSamples }))
  .sort((a, b) => b.date.localeCompare(a.date) || num(a.account) - num(b.account));
const dyStopped = dyLines.map(strip).some(l => /^R316_RPA_STOPPED \{/.test(l));
// ---------- Tmall
const tmLines = L('tm.log');
const tmRecs = tmLines.map(strip).filter(l => l.startsWith('R329_TMALL {')).map(l => JSON.parse(l.slice(11)));
const tmTs = tmLines.filter(l => l.includes('R329_TMALL {')).map(tsOf).filter(Boolean).sort();
const tmDaily = daily(tmLines);
const tmLatest = tmDaily.map(d => d.date).sort().pop();
const nowText = r => !r ? '—' : r.state === 'LIVE' ? '在播' + (r.sourceStartTime ? ' · ' + hhmm(r.sourceStartTime) + ' 开始' : '') : r.state === 'OFFLINE' ? '接口显示未开播' : r.state === 'NOT_RUN' ? '未执行' : '无法判断';
const tmRows = tmDaily.map(d => ({ shop: tmLabel(d.key), date: d.date, result: RES[d.status], seen: span(d.firstSeenAt, d.lastSeenAt), samples: d.verifiedSamples, now: d.date === tmLatest ? nowText(tmRecs.find(r => r.key === d.key)) : '—' }))
  .sort((a, b) => b.date.localeCompare(a.date) || num(a.shop) - num(b.shop));
// ---------- JD
const jdLines = L('jd.log');
const jd = jdLines.map(strip).filter(l => l.startsWith('R327_JD_DAY ')).map(l => JSON.parse(l.slice(12)));
const jdAt = jdLines.filter(l => l.includes('R327_JD_FULLDAY ')).map(tsOf).filter(Boolean).pop();
const jdFull = JSON.parse(strip(jdLines.find(l => l.includes('R327_JD_FULLDAY '))).slice(16));
const dates = [...new Set(jd.map(r => r.date))].sort(), today = dates.at(-1), prevDate = dates.filter(d => d < today).at(-1);
const pct = a => a[0] === a[1] ? a[0] + '%' : a[0] + '%–' + a[1] + '%';
const ids = [...new Set(jd.map(r => r.roomId))].sort((a, b) => a - b);
const jdRows = ids.map(id => {
  const t = jd.find(r => r.roomId === id && r.date === today), p = jd.find(r => r.roomId === id && r.date === prevDate);
  const snap = p.method === 'FROM_0800_SNAPSHOT';
  return { room: 'jd-' + id, category: t.category, todayDate: today, live8: t.liveByWindowStart === true ? '是' : t.liveByWindowStart === false ? '否' : '—', minutesToday: t.soFarMinutes,
    prevDate, prevRate: snap ? p.ratePercent + '%' : p.routineAssumedRangePercent ? pct(p.routineAssumedRangePercent) : '—', prevBasis: snap ? '按 8 点快照计算' : '估算（无 8 点快照）',
    prevMinutes: p.totalDayMinutes, prevLast: p.lastMinuteBeijing ?? '—', prevEnd: p.reachedWindowEnd === true ? '播到 24 点' : p.reachedWindowEnd === false ? '没播到 24 点' : '—' };
});
// ---------- runs
const runsRows = [
  { platform: '京东', asOf: hhmm(jdAt), checked: jdFull.rooms, reachable: jdFull.dailyOk, verified: '—', note: '运营平台只读，读每日分钟数' },
  { platform: '抖音', asOf: span(dyAts[0], dyAts.at(-1)), checked: rpa.length, reachable: rpa.filter(r => r.profileHttp === 200).length, verified: rpa.filter(r => r.profileIdentityVerified && r.roomIdentityVerified).length, note: dyStopped ? '本次被拦停' : '没有被拦，没有进入冷却' },
  { platform: '天猫淘宝', asOf: span(tmTs[0], tmTs.at(-1)), checked: tmRecs.length, reachable: tmRecs.filter(r => r.http === 200).length, verified: tmRecs.filter(r => r.identityVerified).length, note: tmRecs.some(r => r.state === 'NOT_RUN') ? '本次被拦停' : '没有被拦，没有进入冷却' },
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
