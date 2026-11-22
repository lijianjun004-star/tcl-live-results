// Universal results page (v2): one list of every live room by store name, a tally-lamp overview, search,
// platform and "needs a look" filters, and copy-to-record. Works without JavaScript (filters and copy need it).
// Inputs: out/{jd,douyin,tmall,runs,samples,v2}.json and private/names.json (optional; falls back to codes).
// Output: universal/index.html. Usage: node render.mjs
import fs from 'node:fs';
import { assessFreshness, assessRefresh, beijingDay, isCountable, nextRefreshAfter } from './freshness.mjs';
import { v2Rows, v2Counts, v2CardAttributes, v2SummaryLine, v2Detail, v2Overview, v2BrowserFunctions, roles } from './v2-view.mjs';
const rd = f => JSON.parse(fs.readFileSync('out/' + f, 'utf8'));
const jdAll = rd('jd.json').rows, dyAll = rd('douyin.json').rows, tmAll = rd('tmall.json').rows, runs = rd('runs.json').rows, S = rd('samples.json');
const V = fs.existsSync('out/v2.json') ? rd('v2.json') : { source: null, rows: [] };
const v2 = v2Rows(V), v2ById = new Map(v2.map(r => [r.id, r]));
let N = {}, namesOk = true;
try { N = JSON.parse(fs.readFileSync('private/names.json', 'utf8')).names; } catch { namesOk = false; }
if (!jdAll.length || !dyAll.length || !tmAll.length || runs.length !== 3) throw new Error('RENDER_INPUT_EMPTY');
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const num = s => Number(String(s).replace(/\D+/g, '')) || 0;
const latest = rows => rows.reduce((m, r) => (r.date > m ? r.date : m), '');
const md = d => Number(d.slice(5, 7)) + '月' + Number(d.slice(8, 10)) + '日';
const wk = d => '周' + '日一二三四五六'[new Date(d + 'T00:00:00Z').getUTCDay()];
const short = d => (d ? d.slice(5) : '');
const SEEN = '已开播', UNSEEN = '采样中未见（不等于没播）';
const posOf = t => { const [h, m] = t.split(':').map(Number); return ((h * 60 + m - 360 + 1440) % 1440) / 1440 * 100; };

// Beijing time, always with the day it belongs to. Relative to the broadcast day shown: "07:59" (same day),
// "次日 00:56" (next calendar day), "11-13 23:10" (any other day).
const bjParts = x => { const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(x)).map(v => [v.type, v.value])); return { date: `${p.year}-${p.month}-${p.day}`, hm: `${p.hour}:${p.minute}` }; };
const nextDay = d => new Date(Date.parse(d + 'T00:00:00Z') + 864e5).toISOString().slice(0, 10);
const at = (x, day) => { if (x == null || x === '') return ''; const b = bjParts(x); return b.date === day ? b.hm : b.date === nextDay(day) ? '次日 ' + b.hm : short(b.date) + ' ' + b.hm; };
const spanAt = (a, b, day) => !a ? '' : !b || at(a, day) === at(b, day) ? at(a, day) : at(a, day) + '–' + at(b, day);
const longAt = x => { const b = bjParts(x); return Number(b.date.slice(5, 7)) + '月' + Number(b.date.slice(8, 10)) + '日 ' + b.hm; };
const isoBJ = x => { if (x == null || x === '') return ''; const b = bjParts(x); return b.date + ' ' + b.hm; };
const runSpan = r => { if (!r.atFrom) return r.asOf; const a = bjParts(r.atFrom), b = bjParts(r.atTo || r.atFrom); return longAt(r.atFrom) + (a.date !== b.date ? '–' + longAt(r.atTo) : a.hm !== b.hm ? '–' + b.hm : ''); };
const bdayOf = x => bjParts(Date.parse(x) - 6 * 3600e3).date;
const slug = c => c.startsWith('#') ? 'd' + c.slice(1) : c.startsWith('T') ? 't' + c.slice(1) : 'j' + c.replace(/\D/g, '');
const nameOf = c => N[c]?.name || c, roleOf = c => N[c]?.role || '';
const startOf = t => (String(t).match(/(\d\d:\d\d) 开始/) || [])[1];
const validSourceTime = r => assessFreshness(r.verifiedAt).state === 'UNKNOWN' ? null : r.verifiedAt;
const genIso = new Date().toISOString(), genMs = Date.parse(genIso);
const latestIso = runs.map(validSourceTime).filter(Boolean).sort().at(-1) || null;
const runBy = { jd: runs[0], douyin: runs[1], tmall: runs[2] };
const sourceAt = Object.fromEntries(Object.entries(runBy).map(([key,run]) => [key,validSourceTime(run)]));
const genText = bjParts(genIso).date.slice(0, 4) + '年' + longAt(genIso);
const refreshDue = nextRefreshAfter(genIso);
const publishRun = /^[1-9]\d{0,17}$/.test(process.env.GITHUB_RUN_ID || '') ? process.env.GITHUB_RUN_ID : null;
const publishLink = publishRun ? 'https://github.com/lijianjun004-star/tcl-live-results/actions/runs/' + publishRun : null;
const pauses = { douyin: runs[1].pause || null, tmall: runs[2].pause || null };
const paused = p => !!pauses[p] && Date.parse(pauses[p].until) > Date.parse(genIso);
const blocked = p => paused(p) || (!!runBy[p].latestRun && runBy[p].latestRun.conclusion !== 'success');
const dyDate = latest(dyAll), tmDate = latest(tmAll), day = beijingDay(genMs,6), jdDay = beijingDay(genMs);
const CATS = ['冰箱', '洗衣机', '空调', '电视', '显示器'];

// one record per live room
const R = [];
const prevOf = (all, key, code, date) => all.filter(x => x[key] === code && x.date < date).sort((a, b) => b.date.localeCompare(a.date))[0];
for (const [p, pl, all, key, date] of [['douyin', '抖音', dyAll, 'account', dyDate], ['tmall', '天猫淘宝', tmAll, 'shop', tmDate]]) {
  for (const r of all.filter(x => x.date === date).sort((a, b) => num(a[key]) - num(b[key]))) {
    const code = r[key], kind = r.result === SEEN ? 'seen' : r.result === UNSEEN ? 'unseen' : 'unknown';
    const evidence = { platform:p, kind, date, at:r.verifiedAt || null, blocked:blocked(p) };
    const st = isCountable(evidence,genMs) ? kind : 'unknown';
    const smp = S.ok?.[p] ? S.rows.filter(s => s.platform === p && s.account === code && s.date === date) : [];
    const off = smp.filter(s => s.kind === 'notseen'), apiOff = off.length > 0 && off.every(s => s.api === 'OFFLINE');
    const start = p === 'tmall' && String(r.now).startsWith('在播') ? (r.nowStart ? at(r.nowStart, date) : startOf(r.now)) : null;
    const seenTxt = spanAt(r.seenFrom, r.seenTo, date) || r.seen;
    const pz = paused(p) ? pauses[p] : null, pzLine = pz ? `平台要求验证，${at(pz.from, date)} 起暂停采样，计划 ${longAt(pz.until)} 后复核` : '';
    const line = st === 'seen' ? `看到在播 ${seenTxt}${start ? `，本场 ${start} 开始` : ''}`
      : st === 'unseen' ? (apiOff ? `${r.samples} 次采样，接口都显示未开播` : `${r.samples} 次采样都没看到在播`)
      : evidence.at && kind === 'seen' ? `历史记录 ${longAt(evidence.at)} 看到在播，本日暂无法判断`
      : evidence.at ? '最近有效记录已过期或当前采集未通过，暂无法判断' : '没有核验通过的采样';
    const prev = prevOf(all, key, code, date);
    R.push({ id: slug(code), code, p, pl, name: nameOf(code), role: roleOf(code), st, status: st === 'seen' ? '已开播' : st === 'unseen' ? '采样中未见' : '无法判断',
      line: pz && st !== 'seen' && !r.samples ? pzLine : line, lineWarn: false, line2: pz && (st === 'seen' || r.samples) ? pzLine : '', attn: [...(st === 'seen' ? [] : [st === 'unseen' ? '采样中未见' : '无法判断']), ...(pz ? ['暂停采样'] : [])], date, seen: st === 'seen' ? seenTxt : '', start: start || '', seenFrom: st === 'seen' ? r.seenFrom || null : null, seenTo: st === 'seen' ? r.seenTo || null : null, startIso: r.nowStart || null,
      evidence, skipped: S.ok?.[p] && S.day?.[p] === date ? S.notRun?.[p]?.[code] || 0 : 0,
      samples: r.samples, smp, prev: prev ? `${short(prev.date)}：${prev.result === SEEN ? '已开播，看到在播 ' + (spanAt(prev.seenFrom, prev.seenTo, prev.date) || prev.seen) : prev.result}，核验 ${prev.samples} 次` : '' });
  }
}
for (const r of [...jdAll].sort((a, b) => num(a.room) - num(b.room))) {
  const code = r.room, name = nameOf(code), est = r.prevBasis.startsWith('估算');
  const minutes = Number.isFinite(r.minutesToday) && r.minutesToday >= 0 ? r.minutesToday : null;
  const evidence = { platform:'jd', kind:minutes === null || r.todayMissing ? 'unknown' : minutes > 0 ? 'seen' : 'unseen',
    date:r.todayDate, at:r.verifiedAt || null, blocked:blocked('jd') };
  const current = isCountable(evidence,genMs);
  const m = current ? minutes : null, missing = m === null;
  const live8 = current ? r.live8 : '—';
  const late = live8 === '否', short24 = r.prevEnd === '没播到 24 点';
  const inName = CATS.find(c => name.includes(c));
  R.push({ id: slug(code), code, p: 'jd', pl: '京东', name, role: '', st: missing ? 'unknown' : m > 0 ? 'seen' : 'unseen', status: missing ? '当天数据缺失，无法判断' : m > 0 ? '已开播' : '当天累计 0 分钟',
    line: missing ? '当天没有新鲜且可用的分钟记录，无法判断' : `${live8 === '是' ? '8 点在播' : late ? '8 点时还没在播' : '8 点没有快照'}，当天累计 ${m} 分钟`, lineWarn: missing || late,
    line2: current && r.dayRate ? `${short(r.todayDate)} 覆盖估算 ${r.dayRate}（按 8 点快照）` : '',
    attn: [missing ? '当天数据缺失' : '', late ? '8 点时还没在播' : '', short24 ? `${short(r.prevDate)} 没播到 24 点` : ''].filter(Boolean),
    date: r.todayDate, live8, minutes: m, dayRate: current ? r.dayRate || '' : '', prevDate: r.prevDate, prevRate: r.prevRate, previousMissing: r.previousMissing, prevBasis: r.prevBasis, est, prevLast: r.prevLast, prevEnd: r.prevEnd,
    evidence, historyDate: r.historyDate, historyMinutes: r.historyMinutes,
    room: num(code), category: r.category, conflict: inName && r.category && inName !== r.category ? inName : '' });
}
const by = p => R.filter(r => r.p === p);
// Only T codes can join a ledger card. A missing ledger card gets a V2-only
// entry. The JD candidate has no established correspondence to a JD room.
const ledgerCodes = new Set(by('tmall').map(r => r.code));
const v2Only = v2.filter(r => !ledgerCodes.has(r.id)).sort((a, b) => a.id.localeCompare(b.id)).map(r => ({
  id: r.id === 'J-C01' ? 'jc01' : slug(r.id), code: r.id, p: r.platform,
  pl: r.platform === 'jd' ? '京东' : '天猫淘宝', name: nameOf(r.id), role: roles[r.role], v2: r
}));
const shopCount = p => (p ? by(p).length : R.length) + v2Only.filter(r => !p || r.p === p).length;
const seenAll = R.filter(r => r.st === 'seen').length, attnAll = R.filter(r => r.attn.length).length;
const titleFor = count => count > 0 ? `${count} 个直播间已确认开播` : '本日暂无可确认的开播数据';
const title = titleFor(seenAll);
const dekParts = [];
for (const [p, pl, unit] of [['douyin', '抖音', '个账号'], ['tmall', '天猫淘宝', '家']]) {
  const un = by(p).filter(r => r.st === 'unseen').length, uk = by(p).filter(r => r.st === 'unknown').length;
  const parts = [un ? `${un} ${unit}采样中未见` : '', uk ? `${uk} ${unit}${paused(p) ? '暂停采样，无法判断' : '无法判断'}` : ''].filter(Boolean);
  if (parts.length) dekParts.push(`${pl} ${parts.join('，')}`);
}
const late8 = by('jd').filter(r => r.live8 === '否').length;
if (late8) dekParts.push(`京东 ${late8} 家 8 点时还没在播`);
const jdUnknown = by('jd').filter(r => r.st === 'unknown').length;
if (jdUnknown) dekParts.push(`京东 ${jdUnknown} 家无可用当日数据`);
const dek = dekParts.length ? dekParts.join('；') + '。' : '没有需要关注的直播间。';

// pieces
const K = k => `<i class="k ${k}" aria-hidden="true"></i>`;
const lamp = r => `<a class="lamp ${r.st}${r.attn.length ? ' attn' : ''}" href="#${r.id}" data-room-lamp="${r.id}" aria-label="${esc(r.name)}：${esc(r.status)}${r.attn.length ? '，要关注' : ''}" title="${esc(r.name)}：${esc(r.status)}"></a>`;
const groupText = (seen,unknown) => `已确认开播 ${seen}，无法判断 ${unknown}`;
const groupMeta = p => groupText(by(p).filter(r => r.st === 'seen').length,by(p).filter(r => r.st === 'unknown').length);
const ruler = `<div class="rl" aria-hidden="true"><span style="left:0">06</span><span style="left:25%">12</span><span style="left:50%">18</span><span style="left:75%">24</span><span style="left:100%">06</span></div>`;
const strip = r => {
  const skipped = r.skipped ? `<p class="fine">未执行 ${r.skipped} 次（停止后记录，不计入访问）</p>` : '';
  if (!r.smp.length) return skipped || '<p class="fine">这一天没有逐次采样明细。</p>';
  const open = bdayOf(genIso) === r.date;   // the broadcast day is still running: shade the hours that have not come yet
  const words = s => s.kind === 'seen' ? '看到在播' : s.kind === 'notseen' ? (s.api === 'OFFLINE' ? '接口显示未开播' : '没看到在播') : '未能核验';
  return skipped + `<p class="sub">当天的采样（每条竖线一次，06:00 到次日 06:00）</p>${ruler}<div class="tr" role="img" aria-label="${esc(r.smp.map(s => (s.iso ? at(s.iso, r.date) : s.at) + ' ' + words(s)).join('，'))}">${open ? `<i class="fut" style="left:${posOf(bjParts(genIso).hm).toFixed(2)}%"></i>` : ''}${r.smp.map(s => `<i class="m ${s.kind}" style="left:${(s.pos * 100).toFixed(2)}%"></i>`).join('')}</div>
<ul class="smp">${r.smp.map(s => `<li>${K(s.kind === 'seen' ? 'seen' : s.kind === 'notseen' ? 'unseen' : 'unknown')}<b>${esc(s.iso ? at(s.iso, r.date) : s.at)}</b> ${esc(words(s))}</li>`).join('')}</ul>`;
};
const rate = s => { const m = String(s).match(/^([\d.]+)%(?:–([\d.]+)%)?$/); return m ? [Number(m[1]), Number(m[2] ?? m[1])] : null; };
const jdMore = r => {
  const v = rate(r.prevRate);
  const bar = v ? `<div class="bar" aria-hidden="true"><i class="lo" style="width:${v[0]}%"></i>${v[1] > v[0] ? `<i class="hi" style="left:${v[0]}%;width:${(v[1] - v[0]).toFixed(1)}%"></i>` : ''}</div>` : '';
  const history = r.historyDate && r.historyDate !== r.prevDate && Number.isFinite(r.historyMinutes) ? `<p class="fine">最近历史 ${esc(r.historyDate)}，记录 ${r.historyMinutes} 分钟（不计入当天）</p>` : '';
  const expiredToday = r.minutes === null ? '' : `<p class="fine snapshot-expired">本版历史快照 ${esc(r.date)}，累计 ${r.minutes} 分钟</p>`;
  return expiredToday + history + `<div class="rate"><span>${esc(short(r.prevDate))} 满播率</span>${bar}<b>${esc(r.prevRate)}</b></div>
<ul class="facts"><li>${r.previousMissing ? '没有上一日记录，不推算满播率或停播状态' : r.est ? `${esc(short(r.prevDate))} 没有 8 点快照，只能按「7–8 点开播」估算范围，斜纹是不确定的部分` : esc(r.prevBasis)}</li>
<li>${esc(short(r.prevDate))} 最后一分钟 ${esc(r.prevLast)}${r.prevEnd === '没播到 24 点' ? '，没播到 24 点' : r.prevEnd === '播到 24 点' ? '，播到了 24 点' : ''}</li>
<li>运营平台 ${r.room} 号直播间，品类「${esc(r.category)}」${r.conflict ? `（和名称里的「${esc(r.conflict)}」不一致，待运营平台核实）` : ''}</li></ul>`;
};
const row = r => {
  const sample = r.p === 'tmall' && v2ById.get(r.code);
  const tag = r.role === '考核' ? '<span class="tag">考核</span>' : '';
  const q = (r.name + ' ' + r.code + ' ' + r.pl + ' ' + (r.conflict ? '' : r.category || '')).toLowerCase().replace(/\s+/g, '');
  const extra = r.p === 'jd' ? r.attn.filter(a => a.includes('24 点')) : [];
  return `<details class="st" id="${r.id}" data-p="${r.p}" data-a="${r.attn.length ? 1 : 0}" data-q="${esc(q)}"${sample ? ' ' + v2CardAttributes(sample, genMs) : ''}>
<summary><span class="nm">${esc(r.name)}${tag}</span><span class="pill snapshot-current">${K(r.st)}${sample ? '原台账 · ' : ''}${esc(r.status)}</span>
<span class="ln snapshot-current${r.lineWarn ? ' warn' : ''}">${r.line.split('，').map((x, i, a) => `<span class="nw">${esc(x)}${i < a.length - 1 ? '，' : ''}</span>`).join('')}</span>${r.line2 ? `<span class="ln2 snapshot-current">${esc(r.line2)}</span>` : ''}${extra.length ? `<span class="ln2 warn">${esc(extra.join('，'))}</span>` : ''}
<span class="pill snapshot-expired">${K('unknown')}${sample ? '原台账 · ' : ''}无法判断</span>
<span class="ln warn snapshot-expired">本版观测已过期，展开查看采样记录</span>${sample ? v2SummaryLine(sample, genMs) : ''}<i class="chev" aria-hidden="true"></i></summary>
<div class="more">${sample ? v2Detail(sample, genMs) + '<h3>原台账</h3>' : ''}${r.p === 'jd' ? jdMore(r) : strip(r) + (r.prev ? `<p class="fine">前一天 ${esc(r.prev)}</p>` : '')}<p class="fine">监控编号 ${esc(r.code)}</p></div>
</details>`;
};
const standaloneRow = r => `<details class="st" id="${r.id}" data-p="${r.p}" data-a="0" data-q="${esc((r.name + r.code + r.pl).toLowerCase().replace(/\s+/g, ''))}" ${v2CardAttributes(r.v2, genMs)}>
<summary><span class="nm">${esc(r.name)}<span class="tag">${esc(r.role)}</span></span>${v2SummaryLine(r.v2, genMs)}<i class="chev" aria-hidden="true"></i></summary>
<div class="more">${v2Detail(r.v2, genMs)}<p class="fine">监控编号 ${esc(r.code)} · ${r.p === 'jd' ? '店铺与原台账直播间的对应关系待核实' : '本版缺少该店原台账'}</p></div></details>`;
const healthText = { success:'成功', failure:'失败', cancelled:'取消', timed_out:'超时', action_required:'需处理',
  skipped:'跳过', neutral:'中性', stale:'过期', startup_failure:'启动失败' };
const group = (p, pl) => {
  const freshness = assessFreshness(sourceAt[p], Date.parse(genIso));
  const run = runBy[p], latestRun = run.latestRun;
  const attempt = runSpan(run) || '时间无法确认';
  const health = latestRun ? `<p class="fine">最近完成任务 <a href="https://github.com/lijianjun004-star/tcl-live-monitor/actions/runs/${latestRun.id}">${esc(longAt(latestRun.at))}</a> · ${esc(healthText[latestRun.conclusion] || "未知")}</p>` : '';
  return `<section class="grp" data-p="${p}" aria-labelledby="g-${p}"><h2 id="g-${p}">${pl}<span>原台账 · <span data-current-group="${p}">${esc(groupMeta(p))}</span></span></h2><p class="fine">本版采用的采集尝试 ${esc(attempt)}（北京时间）</p><p class="fine">最近有效观测 ${esc(sourceAt[p] ? longAt(sourceAt[p]) : '时间无法确认')}（北京时间） · <span data-source-time="${esc(sourceAt[p] || '')}" data-age-state="${freshness.state}">${esc(freshness.text)}</span></p>${health}${by(p).map(row).join('')}${p === 'tmall' ? v2Only.filter(r => r.p === p).map(standaloneRow).join('') : ''}</section>`;
};

// data for copy-to-record (names, results and times only)
const recs = R.map(r => {
  const extra = r.p === 'jd' ? r.attn.filter(a => a.includes('24 点')) : [];
  return { id: r.id, p: r.pl, name: r.name, role: r.role, status: r.status, date: r.date, ...(r.p === 'tmall' && v2ById.has(r.code) ? { v2: v2ById.get(r.code) } : {}),
    text: r.status + '，' + r.line + (r.line2 ? '；' + r.line2 : '') + (extra.length ? '；' + extra.join('，') : '') + '；数据截至 ' + (r.evidence.at ? isoBJ(r.evidence.at) : '时间无法确认'),
    asOfIso: r.evidence.at ? isoBJ(r.evidence.at) : '', evidence: r.evidence,
    seen: r.seen || '', start: r.startIso ? isoBJ(r.startIso) : r.start || '', seenFrom: isoBJ(r.seenFrom), seenTo: isoBJ(r.seenTo), live8: r.p === 'jd' ? (r.live8 === '是' ? '是' : r.live8 === '否' ? '否' : '') : '', minutes: r.p === 'jd' ? r.minutes : '',
    prevRate: r.p === 'jd' ? r.prevRate + (r.est ? '（估算）' : '') : '', dayRate: r.p === 'jd' ? r.dayRate : '', note: r.attn.join('；') };
});
for (const r of v2Only) {
  recs.push({ id: r.id, p: r.pl, name: r.name, role: r.role, v2: r.v2, evidence: null, status: '',
    date: '', text: '', seenFrom: '', seenTo: '', start: '', live8: '', minutes: null, dayRate: '', prevRate: '', note: '', asOfIso: '' });
}
const recJson = JSON.stringify({ day, head: `TCL 直播记录 ${md(day)}（${wk(day)}）`, asOf:'各平台有效观测时间见每条记录；本版页面生成于 ' + genText + '（北京时间）', asOfIso:latestIso ? isoBJ(latestIso) : '', rows:recs }).replace(/</g, '\\u003c');
const summaryData = JSON.stringify(R.map(r => ({
  ...r.evidence, id: r.id, name: r.name, status: r.status, attention: !!r.attn.length,
  initiallyCountable: r.st !== 'unknown'
}))).replace(/</g, '\\u003c');
const runRow = r => `<tr><td>${esc(r.platform)}</td><td class="n tm">${esc(runSpan(r) || '—')}</td><td class="n">${r.reachable === '—' ? '—' : esc(r.reachable) + '/' + esc(r.checked)}</td><td class="n">${r.verified === '—' ? '—' : esc(r.verified) + '/' + esc(r.checked)}</td></tr>`;

const DARK = '--bg:#0e1a21;--ink:#e8eef2;--mut:#9aacb6;--line:#22343d;--plate:#132630;--wash:#1a313c;--on:#ff4d6d;--glow:rgba(255,77,109,.28);--off:#5b7480;--warn:#eaa25f;--sel:#e8eef2;--selink:#0e1a21;--nav:rgba(14,26,33,.9);--grid:#2a404a;--fut:#132a35;--sea:#6cc3de;--seahi:rgba(108,195,222,.35)';
const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="format-detection" content="telephone=no,date=no,address=no,email=no">
<meta name="theme-color" content="#ffffff" media="(prefers-color-scheme: light)">
<meta name="theme-color" content="#0e1a21" media="(prefers-color-scheme: dark)">
<meta name="apple-mobile-web-app-title" content="直播全天结果">
<title>TCL 直播全天结果</title>
<style>
/* VOICE   an ops duty sheet: who went on air today, what needs a look, and a record you can paste
   IDEA    a studio tally board: one lamp per live room, lit red when a sample saw it on air
   PICTURE the lamp board up top; each lamp jumps to its store, an amber dot marks what needs a look
   COLOUR  white paper, blue-black ink, on-air red only for lamps and dots, amber for things to check
   TYPE    system fonts only (PingFang SC, SF): nothing to download, opens offline and in mainland China
   LAYOUT  one column; sticky search and platform switch; each row opens for its sampling detail */
:root{color-scheme:light;--bg:#fff;--ink:#14212b;--mut:#5c6a73;--line:#e2e8eb;--plate:#f1f4f6;--wash:#eef2f4;--on:#e0103a;--glow:rgba(224,16,58,.16);--off:#b3bfc6;--warn:#9f4f0c;--sel:#14212b;--selink:#fff;--nav:rgba(255,255,255,.93);--grid:#c9d4d9;--fut:#eef2f4;--sea:#1d6b86;--seahi:rgba(29,107,134,.28)}
@media (prefers-color-scheme:dark){:root:not([data-theme=light]){color-scheme:dark;${DARK}}}
:root[data-theme=dark]{color-scheme:dark;${DARK}}
*{box-sizing:border-box;min-width:0}
html{-webkit-text-size-adjust:100%;text-size-adjust:100%}
body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.55 -apple-system,BlinkMacSystemFont,"PingFang SC","Hiragino Sans GB","Microsoft YaHei","Noto Sans CJK SC","Source Han Sans SC","Helvetica Neue",Arial,sans-serif;-webkit-font-smoothing:antialiased;overflow-x:clip}
[hidden]{display:none!important}
button{font:inherit;color:inherit}
.wrap{max-width:860px;margin:0 auto;padding:0 16px}
header{padding:20px 0 0}
.meta{margin:0;font-size:13px;color:var(--mut)}
.pause{margin:6px 0 0;font-size:13px;font-weight:600;color:var(--warn)}
h1{margin:6px 0 0;font-size:clamp(24px,6.4vw,34px);line-height:1.25;font-weight:700;text-wrap:balance}
.dek{margin:8px 0 0;font-size:15px;text-wrap:balance}
.board{margin:16px 0 0;padding:12px 12px 8px;background:var(--plate);border-radius:16px}
.bg{margin:0 0 6px}
.bl{display:flex;justify-content:space-between;align-items:baseline;margin:0 2px;font-size:13px;color:var(--mut)}
.bl b{font-size:15px;font-weight:600;color:var(--ink)}
.lamps{display:flex;flex-wrap:wrap;margin:0 -2px}
.lamp{position:relative;display:inline-flex;align-items:center;justify-content:center;width:36px;height:44px;border-radius:12px;-webkit-tap-highlight-color:transparent}
.lamp::before{content:"";width:18px;height:18px;border-radius:50%;border:2px solid var(--off);box-sizing:border-box}
.lamp.seen::before{background:var(--on);border-color:var(--on);box-shadow:0 0 0 4px var(--glow)}
.lamp.unknown::before{border-style:dashed;border-color:var(--warn)}
.lamp[data-expired]::before{background:transparent;box-shadow:none;border-style:dashed;border-color:var(--warn)}
.lamp.attn::after,.lamp[data-expired]::after{content:"";position:absolute;top:8px;right:5px;width:8px;height:8px;border-radius:50%;background:var(--warn);border:2px solid var(--plate)}
.lamp:focus-visible{outline:2px solid var(--ink);outline-offset:-2px}
.key{display:flex;flex-wrap:wrap;margin:4px 2px 0;font-size:13px;color:var(--mut)}
.key span{display:inline-flex;align-items:center;margin:0 14px 4px 0;white-space:nowrap}
.key .dot{display:inline-block;width:8px;height:8px;margin-right:5px;border-radius:50%;background:var(--warn)}
.k{display:inline-block;flex:none;width:9px;height:9px;margin-right:6px;border-radius:50%;border:2px solid var(--off)}
.k.seen{background:var(--on);border-color:var(--on)}
.k.unknown{border-style:dashed;border-color:var(--warn)}
.tools{display:none}
.js .tools{display:block}
.find{position:-webkit-sticky;position:sticky;top:0;z-index:5;margin:14px 0 0;padding:8px 0;background:var(--nav);-webkit-backdrop-filter:saturate(1.6) blur(12px);backdrop-filter:saturate(1.6) blur(12px)}
.find input{display:block;width:100%;height:44px;padding:0 14px;font-size:16px;color:var(--ink);background:var(--wash);border:1.5px solid transparent;border-radius:12px;-webkit-appearance:none;appearance:none}
.find input::placeholder{color:var(--mut)}
.find input:focus{outline:none;border-color:var(--ink)}
.seg{display:flex;margin:8px -16px 0 0;padding-right:16px;overflow-x:auto;-webkit-overflow-scrolling:touch;scrollbar-width:none}
.seg::-webkit-scrollbar{display:none}
.seg button,.acts button{flex:none;min-height:44px;margin:0 8px 0 0;padding:0 14px;font-size:15px;background:var(--wash);border:0;border-radius:10px;white-space:nowrap;cursor:pointer;-webkit-tap-highlight-color:transparent}
.seg button span,.acts button span{margin-left:5px;color:var(--mut);font-variant-numeric:tabular-nums}
.seg button[aria-pressed=true]{background:var(--sel);color:var(--selink)}
.seg button[aria-pressed=true] span{color:inherit;opacity:.7}
.acts{display:flex;flex-wrap:wrap;margin:6px 0 0}
.acts button{margin-bottom:8px}
#attn[aria-pressed=true]{background:var(--warn);color:var(--bg)}
#attn[aria-pressed=true] span{color:inherit;opacity:.8}
.seg button:focus-visible,.acts button:focus-visible,summary:focus-visible{outline:2px solid var(--sea);outline-offset:2px}
.msg{margin:0;font-size:13px;color:var(--mut);min-height:1.2em}
#fb{display:block;width:100%;height:200px;margin:6px 0 0;padding:10px;font:13px/1.5 -apple-system,"PingFang SC",sans-serif;color:var(--ink);background:var(--bg);border:1px solid var(--line);border-radius:10px}
.empty{margin:18px 0 0;padding:16px;background:var(--plate);border-radius:12px;font-size:15px}
.empty button{margin-left:6px;min-height:44px;padding:0 12px;background:var(--wash);border:0;border-radius:10px;cursor:pointer}
.grp{margin:22px 0 0}
.grp h2{display:flex;flex-wrap:wrap;justify-content:space-between;align-items:baseline;margin:0;padding:0 0 6px;font-size:20px;line-height:1.3;border-bottom:2px solid var(--ink)}
.grp h2 span{font-size:13px;font-weight:400;color:var(--mut)}
.st{border-bottom:1px solid var(--line);scroll-margin-top:120px}
.st>summary{display:grid;grid-template-columns:minmax(0,1fr) auto;grid-column-gap:12px;padding:13px 0;cursor:pointer;list-style:none;-webkit-tap-highlight-color:transparent}
.st>summary::-webkit-details-marker{display:none}
.st:target>summary .nm{text-decoration:underline;text-decoration-color:var(--on);text-decoration-thickness:2px;text-underline-offset:4px}
.nm{font-size:17px;font-weight:600;line-height:1.4;overflow-wrap:anywhere}
.tag{display:inline-block;margin-left:6px;padding:0 6px;font-size:13px;font-weight:500;line-height:20px;color:var(--mut);border:1px solid var(--line);border-radius:6px;vertical-align:2px}
.pill{grid-column:2;grid-row:1;align-self:start;display:inline-flex;align-items:center;margin-top:1px;padding:0 9px;font-size:13px;line-height:26px;background:var(--wash);border-radius:8px;white-space:nowrap}
.ln,.ln2{grid-column:1;display:block}
.ln{margin-top:2px;font-size:15px;color:var(--mut)}
.ln2{font-size:13px;color:var(--mut)}
.st:not([data-expired]) .snapshot-expired,.st[data-expired] .snapshot-current{display:none}
.warn{color:var(--warn)!important}
.nw{white-space:nowrap}
.chev{grid-column:2;grid-row:2 / span 3;align-self:center;justify-self:end;width:9px;height:9px;margin-right:4px;border-right:2px solid var(--off);border-bottom:2px solid var(--off);-webkit-transform:rotate(45deg);transform:rotate(45deg)}
.st[open]>summary .chev{-webkit-transform:rotate(-135deg);transform:rotate(-135deg)}
.more{padding:0 0 14px}
.sub{margin:0 0 6px;font-size:13px;color:var(--mut)}
.rl{position:relative;height:18px;font-size:13px;color:var(--mut);font-variant-numeric:tabular-nums}
.rl span{position:absolute;top:0;-webkit-transform:translateX(-50%);transform:translateX(-50%)}
.rl span:first-child{-webkit-transform:none;transform:none}
.rl span:last-child{-webkit-transform:translateX(-100%);transform:translateX(-100%)}
.tr{position:relative;height:26px;border-bottom:1px solid var(--grid);background-image:linear-gradient(to right,var(--grid) 1px,transparent 1px),linear-gradient(to right,var(--line) 1px,transparent 1px);background-size:25% 100%,4.1666% 5px;background-position:0 0,0 100%;background-repeat:repeat-x}
.tr .fut{position:absolute;top:0;bottom:0;right:0;background:repeating-linear-gradient(135deg,var(--fut) 0,var(--fut) 4px,transparent 4px,transparent 8px)}
.m{position:absolute;bottom:0;width:4px;margin-left:-2px;border-radius:2px 2px 0 0}
.m.seen{height:20px;background:var(--on)}
.m.notseen{height:9px;background:var(--mut)}
.m.unknown{height:9px;width:6px;margin-left:-3px;border:1.5px solid var(--warn);border-bottom:0;background:var(--bg)}
.smp{display:flex;flex-wrap:wrap;margin:10px 0 0;padding:0;list-style:none;font-size:13px;color:var(--mut)}
.smp li{display:inline-flex;align-items:center;margin:0 14px 4px 0;white-space:nowrap}
.smp b{margin-right:4px;color:var(--ink);font-weight:600;font-variant-numeric:tabular-nums}
.fine{margin:8px 0 0;font-size:13px;color:var(--mut)}
.v2-overview{margin:20px 0;padding:14px 16px;border:1px solid var(--line);border-radius:14px}
.v2-overview h2{margin:0;font-size:20px}
.v2-overview h3,.more h3{margin:12px 0 4px;font-size:15px}
.v2-overview p,.v2-detail p{margin:4px 0;font-size:14px}
.v2-overview summary{margin-top:8px;cursor:pointer;font-size:14px;color:var(--mut)}
.v2-tally{display:flex;flex-wrap:wrap;gap:3px 16px;font-size:14px}
.v2-tally b,.v2-line small,.v2-timeline time{font-variant-numeric:tabular-nums}
.v2-line{grid-column:1/-1;display:block;margin-top:7px;font-size:14px}
.v2-line b{color:var(--sea);margin-right:4px}
.v2-line small{display:block;color:var(--mut);font-size:13px}
.v2-recent{grid-column:1/-1;display:block;padding:8px 10px;margin-top:6px;border-left:3px solid #a76c16;background:#fff4df;color:#69450e;font-size:13px;line-height:1.6;border-radius:4px;overflow-wrap:anywhere}
.v2-recent[hidden]{display:none}
[data-v2-recent="EXPIRED"] .v2-recent{border-color:var(--line);background:var(--wash);color:var(--mut)}
.v2-recent-total{margin:10px 0 4px;padding:10px 12px;border:1px solid #dfc38e;border-radius:8px;background:#fff8eb;color:#69450e;font-size:14px}
.v2-recent-total small{display:block;margin-top:3px;font-size:13px}
.v2-reference-detail{overflow-wrap:anywhere}
.v2-detail{margin:0 0 12px;padding:2px 12px 8px;background:var(--plate);border-radius:8px}
.v2-timeline{margin:8px 0;padding-left:20px;list-style:disc;font-size:14px}
.v2-timeline li::marker{color:var(--sea)}
.v2-filter{display:flex;align-items:center;gap:6px;margin:0 8px 8px 0;font-size:14px}
.v2-filter select{min-height:44px;padding:0 8px;font:inherit;color:var(--ink);background:var(--wash);border:1px solid var(--line);border-radius:8px}
[data-age-state=STALE],[data-age-state=UNKNOWN]{color:var(--warn);font-weight:600}
.rate{display:grid;grid-template-columns:auto minmax(0,1fr) auto;grid-column-gap:10px;align-items:center;font-size:13px;color:var(--mut)}
.rate b{color:var(--ink);font-size:15px;font-variant-numeric:tabular-nums;white-space:nowrap}
.bar{position:relative;height:8px;border-radius:4px;background:var(--wash);overflow:hidden}
.bar .lo{position:absolute;top:0;bottom:0;left:0;background:var(--sea)}
.bar .hi{position:absolute;top:0;bottom:0;background:repeating-linear-gradient(135deg,var(--sea) 0,var(--sea) 2px,var(--seahi) 2px,var(--seahi) 5px)}
.facts{margin:8px 0 0;padding:0 0 0 18px;font-size:13px;color:var(--mut);line-height:1.7}
.about{margin:26px 0 0;border-top:2px solid var(--ink)}
.about>summary{display:flex;align-items:center;min-height:48px;font-size:17px;font-weight:600;cursor:pointer;list-style:none}
.about>summary::-webkit-details-marker{display:none}
.about>summary::after{content:"";width:8px;height:8px;margin-left:10px;border-right:2px solid var(--off);border-bottom:2px solid var(--off);-webkit-transform:rotate(45deg);transform:rotate(45deg)}
.about[open]>summary::after{-webkit-transform:rotate(-135deg);transform:rotate(-135deg)}
.about h3{margin:14px 0 4px;font-size:15px}
.about p,.about li{font-size:13px;color:var(--mut);line-height:1.7}
.about p{margin:0}
.about ul{margin:0;padding:0 0 0 18px}
table{width:100%;border-collapse:collapse;font-size:13px}
th{text-align:left;font-weight:600;color:var(--mut);padding:6px 8px 6px 0;border-bottom:1px solid var(--line)}
td{padding:7px 8px 7px 0;border-bottom:1px solid var(--line)}
.n{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}
.tm{white-space:normal}.tm span{white-space:nowrap}
td:first-child,th:first-child{white-space:nowrap}
footer{margin:18px 0 0;padding:14px 0 30px;border-top:1px solid var(--line);font-size:13px;color:var(--mut);line-height:1.7}
@media (max-width:420px){.m{width:3px;margin-left:-1.5px}}
@media (min-width:720px){.board{padding:12px 16px 8px}.bg{display:grid;grid-template-columns:150px minmax(0,1fr);align-items:center;margin:0}.bl{flex-direction:column;align-items:flex-start;margin:0}.key{margin-top:6px}header{padding-top:32px}.find{display:grid;grid-template-columns:minmax(0,1fr) auto;grid-column-gap:12px;align-items:center}.seg{margin:0;padding:0}}
@media print{.tools{display:none!important}.st>summary .chev{display:none}}
</style>
</head>
<body>
<div class="wrap">
<header>
<p class="meta">${esc(md(day))} 广播日（京东 ${esc(md(jdDay))} 自然日）的直播结果。时间均为北京时间。${latestIso ? '最新有效观测 ' + esc(longAt(latestIso)) + '，平台各自时间见下。' : '当前没有可确认的观测时间。'}</p>${['douyin', 'tmall'].filter(paused).map(p => `<p class="pause">${p === 'douyin' ? '抖音' : '天猫淘宝'}：${esc(longAt(pauses[p].from))} 平台要求验证，暂停后计划 ${esc(longAt(pauses[p].until))} 复核；当前无法判断。</p>`).join('')}
<p class="fine">原台账 · 当日汇总</p><h1 data-current-total>${esc(title)}</h1>
<p class="dek" data-current-dek data-original-dek="${esc(dek)}">${esc(dek)}</p>
<div class="board" aria-label="本版页面收录的店铺及快照记录，点一下跳到对应店铺">
${[['douyin', '抖音'], ['tmall', '天猫淘宝'], ['jd', '京东']].map(([p, pl]) => `<div class="bg"><p class="bl"><b>${pl}</b><span data-current-group="${p}">${esc(groupMeta(p))}</span></p><p class="lamps">${by(p).map(lamp).join('')}</p></div>`).join('')}
<p class="key"><span>${K('seen')}快照内已确认开播</span><span>${K('unseen')}快照内采样中未见</span><span>${K('unknown')}无法判断或过期</span><span><i class="dot" aria-hidden="true"></i>要关注&nbsp;<b data-attention-total>${attnAll}</b></span></p>
</div>
</header>
${v2Overview(V.source, V.latest, V.counts, v2Counts(v2, genMs), V.historyStatus)}
<div class="tools">
<div class="find" role="search">
<input id="q" type="search" placeholder="搜索店铺名称，比如 空调、雷鸟" autocomplete="off" enterkeyhint="search" aria-label="搜索店铺名称">
<div class="seg" role="group" aria-label="按平台筛选">${[['all','全部'],['douyin','抖音'],['tmall','天猫淘宝'],['jd','京东']].map(([p, name]) => `<button type="button" data-pf="${p}" aria-pressed="${p === 'all'}">${name}<span>${shopCount(p === 'all' ? null : p)}</span></button>`).join('')}</div>
</div>
<div class="acts">${v2.length ? `<label class="v2-filter">V2 状态<select id="v2-filter">
<option value="all">全部店卡</option><option value="covered">本轮全部店铺</option><option value="live">当前有在播实证</option><option value="recent">近期在播参考 · 待复核</option><option value="offline">当前有未播实证</option><option value="replay">当前有回放实证</option><option value="unknown">当前未知</option><option value="skipped">本轮跳过</option><option value="uncalibrated">本轮规则待校准</option><option value="historical">历史记录</option></select></label>` : ''}<button type="button" id="attn" aria-pressed="false">台账需关注<span data-attention-total>${attnAll}</span></button><button type="button" id="cp">复制记录</button><button type="button" id="cpx">复制表格</button></div>
<p class="msg" id="msg" aria-live="polite"></p>
<textarea id="fb" readonly hidden aria-label="要复制的记录"></textarea>
<p class="empty" id="empty" hidden>没有符合条件的直播间。<button type="button" id="clr">清空搜索和筛选</button></p>
</div>
<main>
${group('douyin', '抖音')}
${group('tmall', '天猫淘宝')}
${group('jd', '京东')}
${v2Only.some(r => r.p === 'jd') ? `<section class="grp" data-p="jd" aria-labelledby="g-jd-candidate"><h2 id="g-jd-candidate">京东候选店</h2>${v2Only.filter(r => r.p === 'jd').map(standaloneRow).join('')}</section>` : ''}
</main>
<details class="about"><summary>关于这些数据</summary>
<h3>数据时间</h3><p>抖音、天猫淘宝按北京时间 06:00 切换广播日，京东按北京时间自然日计算。页面只读取已存在的采集结果。本版采用的采集尝试、有效观测、页面生成和发布记录分别显示。GitHub 计划每小时 :03、:33 刷新，实际时间以发布记录为准。</p>
<h3>本版采用的采集尝试</h3><table><thead><tr><th>平台</th><th class="n">尝试时间</th><th class="n">页面可达</th><th class="n">有效观测</th></tr></thead><tbody>${runs.map(runRow).join('')}</tbody></table>
<h3>怎么判断</h3><ul>
<li>抖音、天猫淘宝：只读公开页面，约每 2 小时采样一次。采样时看到在播、且身份核验通过，记「已开播」。凌晨 0–6 点看到在播算前一天。</li>
<li>「采样中未见」不等于没播：两次采样之间的直播可能漏掉。天猫淘宝接口显示「房间和流都关」的规则还没校准，所以不算确认下播。</li>
<li>京东：读运营平台的分钟数据。08:00–24:00 的分钟数用于覆盖估算，采集中断会少算。历史记录保留各自日期。</li>
<li>「要关注」：抖音、天猫淘宝当天采样中未见；京东 8 点时还没在播（按 7–8 点开播的安排），或前一天没播到 24 点。</li>
</ul>
<h3>店铺名称从哪来</h3><p>抖音、天猫淘宝用监控里登记的账号和店铺名称；京东用 TCL 运营平台里的直播间名称（${esc(N['jd-15']?.asOf ? short(N['jd-15'].asOf) : '11-12')} 读取）。名称按用户要求公开显示，名称表也在本页面的公开仓库里（tcl-live-results 的 dash/private/names.json）。${namesOk ? '' : '（这次没有读到名称表，暂时显示编号。）'}</p>
<p>只读采样，没有接入处罚或正式考核。</p>
</details>
<footer>本版页面生成于 ${esc(genText)}（北京时间）。${publishLink ? `<a href="${publishLink}">发布记录</a>。` : '发布时间以发布记录为准。'}计划下次刷新 ${esc(longAt(refreshDue))} · <span data-refresh-due="${refreshDue}" data-refresh-state="${assessRefresh(refreshDue,genMs).state}">${esc(assessRefresh(refreshDue,genMs).text)}</span></footer>
</div>
<script type="application/json" id="rec">${recJson}</script>
<script type="application/json" id="freshness-summary">${summaryData}</script>
<script>
// Re-evaluate each platform's age while the page is open; no network requests.
const assessFreshness = ${assessFreshness.toString()};
const assessRefresh = ${assessRefresh.toString()};
const beijingDay = ${beijingDay.toString()};
const isCountable = ${isCountable.toString()};
const titleFor = ${titleFor.toString()};
const groupText = ${groupText.toString()};
${v2BrowserFunctions}
let refreshActiveFilter = () => {};
const exportRecords = document.getElementById('rec');
const records = exportRecords ? JSON.parse(exportRecords.textContent) : { rows: [] };
const sampledCards = records.rows.filter(r => r.v2);
let referenceExpiryTimer;
function updateV2Summary(now) {
  if (!sampledCards.length) return;
  let changed = false;
  const labels = new Map(Array.from(document.querySelectorAll('[data-v2-label]'), n => [n.getAttribute('data-v2-label'), n]));
  const references = new Map(Array.from(document.querySelectorAll('[data-v2-reference]'), n => [n.getAttribute('data-v2-reference'), n]));
  for (const item of sampledCards) {
    const state = v2State(item.v2, now);
    const label = labels.get(item.v2.id);
    if (label) label.textContent = state.label;
    const reference = references.get(item.v2.id);
    if (reference) { reference.textContent = state.recentLabel; reference.hidden = state.recentState === 'NONE'; }
    const card = document.getElementById(item.id);
    if (!card) continue;
    if (card.getAttribute('data-v2-age') !== state.age || card.getAttribute('data-v2-result') !== state.current || card.getAttribute('data-v2-recent') !== state.recentState) {
      card.setAttribute('data-v2-age', state.age);
      card.setAttribute('data-v2-result', state.current);
      card.setAttribute('data-v2-recent', state.recentState);
      changed = true;
    }
  }
  const totals = v2Counts(sampledCards.map(x => x.v2), now);
  document.querySelectorAll('[data-v2-count]').forEach(n => { n.textContent = String(totals[n.getAttribute('data-v2-count')]); });
  if (changed) refreshActiveFilter();
  // Expire the reference at the original observation deadline, even if the
  // page stays open between minute ticks. Resume from background also checks.
  if (referenceExpiryTimer) clearTimeout(referenceExpiryTimer);
  const deadlines = sampledCards.map(x => Date.parse(x.v2.recentLive?.observedAt) + 180 * 60000 + 1).filter(t => t > now);
  if (deadlines.length) referenceExpiryTimer = setTimeout(updateSourceAges, Math.min(2147483647, Math.min(...deadlines) - now));
}
function updateCurrentSummary(evidence, now) {
  const counts = {jd:{seen:0,unknown:0},douyin:{seen:0,unknown:0},tmall:{seen:0,unknown:0}};
  const lamps = new Map(Array.from(document.querySelectorAll('[data-room-lamp]'),
    lamp => [lamp.getAttribute('data-room-lamp'), lamp]));
  let attention = 0, anyExpired = false, changed = false;
  for (const row of evidence) {
    if (!counts[row.platform]) continue;
    const current = row.initiallyCountable && isCountable(row,now);
    if (!current) counts[row.platform].unknown++;
    else if (row.kind === 'seen') counts[row.platform].seen++;
    const expired = row.initiallyCountable && !current;
    const needsAttention = row.attention || expired;
    if (expired) anyExpired = true;
    if (needsAttention) attention++;
    const card = document.getElementById(row.id);
    if (card) {
      card.toggleAttribute('data-expired', expired);
      const flag = needsAttention ? '1' : '0';
      if (card.getAttribute('data-a') !== flag) {
        card.setAttribute('data-a', flag);
        changed = true;
      }
    }
    const lamp = lamps.get(row.id);
    if (lamp) {
      lamp.toggleAttribute('data-expired', expired);
      const label = row.name + '：' + (expired ? '观测已过期，无法判断' : row.status);
      lamp.setAttribute('title', label);
      lamp.setAttribute('aria-label', label + (needsAttention ? '，要关注' : ''));
    }
  }
  const total = Object.values(counts).reduce((sum,g) => sum + g.seen, 0);
  document.querySelectorAll('[data-current-total]').forEach(node => { node.textContent = titleFor(total); });
  document.querySelectorAll('[data-current-group]').forEach(node => {
    const g = counts[node.getAttribute('data-current-group')];
    if (g) node.textContent = groupText(g.seen,g.unknown);
  });
  document.querySelectorAll('[data-attention-total]').forEach(node => { node.textContent = String(attention); });
  document.querySelectorAll('[data-current-dek]').forEach(node => {
    node.textContent = anyExpired ? '部分或全部观测已过期。展开店铺查看本版采样记录。' : node.getAttribute('data-original-dek');
  });
  if (changed) refreshActiveFilter();
}
function updateSourceAges() {
  document.querySelectorAll('[data-source-time]').forEach(function (node) {
    const value = assessFreshness(node.getAttribute('data-source-time'));
    node.textContent = value.text;
    node.setAttribute('data-age-state', value.state);
  });
  document.querySelectorAll('[data-refresh-due]').forEach(function (node) {
    const status = assessRefresh(node.getAttribute('data-refresh-due'));
    node.textContent = status.text;
    node.setAttribute('data-refresh-state', status.state);
  });
  const element = document.getElementById('freshness-summary');
  if (element) updateCurrentSummary(JSON.parse(element.textContent), Date.now());
  updateV2Summary(Date.now());
}
updateSourceAges();
setInterval(updateSourceAges, 60000);
document.addEventListener('visibilitychange', updateSourceAges);
{
  const doc = document.documentElement;
  doc.classList.add('js');
  const data = records;
  const $ = s => document.querySelector(s), $$ = s => Array.prototype.slice.call(document.querySelectorAll(s));
  const q = $('#q'), rows = $$('.st'), groups = $$('.grp'), segs = $$('[data-pf]'), attn = $('#attn'), msg = $('#msg'), fb = $('#fb'), empty = $('#empty'), cp = $('#cp'), cpx = $('#cpx');
  let pf = 'all', only = false;
  const vf = $('#v2-filter');
  const matchesV2 = r => {
    if (!vf || vf.value === 'all') return true;
    if (!r.hasAttribute('data-v2-code')) return false;
    if (vf.value === 'covered') return true;
    if (vf.value === 'recent') return r.dataset.v2Recent === 'AVAILABLE';
    if (vf.value === 'historical') return r.dataset.v2Age === 'STALE';
    if (vf.value === 'skipped') return r.hasAttribute('data-v2-skip');
    if (vf.value === 'uncalibrated') return r.hasAttribute('data-v2-uncalibrated');
    return r.dataset.v2Result === vf.value;
  };
  const norm = s => String(s || '').toLowerCase().replace(/\\s+/g, '');
  const shown = () => rows.filter(r => !r.hidden);
  const apply = () => {
    const t = norm(q.value);
    rows.forEach(r => { r.hidden = !((pf === 'all' || r.dataset.p === pf) && (!only || r.dataset.a === '1') && matchesV2(r) && (!t || r.dataset.q.indexOf(t) >= 0)); });
    groups.forEach(g => { g.hidden = !g.querySelector('.st:not([hidden])'); });
    const n = shown().length;
    empty.hidden = n > 0;
    cp.textContent = n === rows.length ? '复制记录' : '复制 ' + n + ' 条';
    cp.disabled = cpx.disabled = n === 0;
    msg.textContent = ''; fb.hidden = true;
  };
  const reset = () => { q.value = ''; pf = 'all'; only = false; if (vf) vf.value = 'all'; segs.forEach(b => b.setAttribute('aria-pressed', String(b.dataset.pf === 'all'))); attn.setAttribute('aria-pressed', 'false'); apply(); };
  refreshActiveFilter = () => { if (only || (vf && vf.value !== 'all')) apply(); };
  if (vf) vf.addEventListener('change', apply);
  q.addEventListener('input', apply);
  segs.forEach(b => b.addEventListener('click', () => { pf = b.dataset.pf; segs.forEach(x => x.setAttribute('aria-pressed', String(x === b))); apply(); }));
  attn.addEventListener('click', () => { only = !only; attn.setAttribute('aria-pressed', String(only)); apply(); });
  $('#clr').addEventListener('click', reset);
  $$('.lamp').forEach(a => a.addEventListener('click', () => { const d = document.getElementById(a.getAttribute('href').slice(1)); if (!d) return; if (d.hidden) reset(); d.open = true; }));
  const pick = () => {
    updateSourceAges();
    const ids = new Set(shown().map(r => r.id)), now = Date.now();
    return data.rows.filter(x => ids.has(x.id)).map(x => {
      const daily = !x.evidence || isCountable(x.evidence,now) ? x : {
        ...x, status:'无法判断', text:'当前无法判断；原版快照：' + x.text,
        seenFrom:'', seenTo:'', start:'', live8:'', minutes:'', dayRate:''
      };
      return x.v2 ? { ...daily, sample: v2Export(x.v2, now) } : daily;
    });
  };
  const text = list => {
    const out = [data.head, data.asOf];
    ['抖音', '天猫淘宝', '京东'].forEach(p => {
      const g = list.filter(x => x.p === p); if (!g.length) return;
      out.push('', p + '（' + g.length + ' 个，原台账已开播 ' + g.filter(x => x.status === '已开播').length + '）');
      g.forEach((x, i) => {
        const daily = x.text && x.v2 ? '原台账 · ' + x.text : x.text;
        out.push((i + 1) + '. ' + x.name + (x.role === '考核' ? '〔考核〕' : '') + '：' +
          [daily, x.sample ? x.v2.id + ' ' + x.sample.text : ''].filter(Boolean).join('；'));
      });
    });
    out.push('', '注：时间均为北京时间；采样约每 2 小时一次，「采样中未见」不等于没播。');
    return out.join('\\n');
  };
  const cell = v => String(v == null ? '' : v).replace(/[\\t\\n]/g, ' ');
  const table = list => [['广播日', '平台', '店铺', '类型', '原台账结果', '首次看到在播', '最后看到在播', '本场开始', '8点在播', '当天累计分钟', '当天满播率', '上一日满播率', '台账需关注', '台账数据截至',
    'V2 编号','V2 范围','V2 本轮记录','V2 时效','V2 当前状态','V2 原因','V2 记录时间','V2 调度登记','V2 采样尝试','V2 有效观测','V2 历史参考状态','V2 历史在播确认时间','V2 历史来源批次'].join('\\t')]
    .concat(list.map(x => [x.date, x.p, x.name, x.role, x.status, x.seenFrom, x.seenTo, x.start, x.live8, x.minutes, x.dayRate, x.prevRate, x.note, x.asOfIso,
      x.v2?.id, x.sample?.role, x.sample?.sample, x.sample?.age, x.sample?.status, x.sample?.reason, x.sample?.recorded, x.sample?.schedule, x.sample?.attempt, x.sample?.verified, x.sample?.recentStatus, x.sample?.recentObserved, x.sample?.recentSource].map(cell).join('\\t'))).join('\\n');
  const copy = (t, n, what) => {
    const done = () => { msg.textContent = '已复制 ' + n + ' 条' + what; fb.hidden = true; };
    const fail = () => { fb.value = t; fb.hidden = false; fb.focus(); fb.select(); try { fb.setSelectionRange(0, t.length); } catch (e) {} msg.textContent = '这里不能自动复制。下面的文字已全选，长按选择「拷贝」即可。'; };
    try { navigator.clipboard.writeText(t).then(done, fail); } catch (e) { fail(); }
  };
  cp.addEventListener('click', () => { const l = pick(); copy(text(l), l.length, '记录，可以直接粘贴到微信'); });
  cpx.addEventListener('click', () => { const l = pick(); copy(table(l), l.length, '，粘贴到表格会自动分列'); });
  const age = document.getElementById('age');
  if (age) { const mins = Math.round((Date.now() - Date.parse(age.dataset.gen)) / 60000); if (mins >= 0) age.textContent = mins < 1 ? '，刚刚' : mins < 60 ? '，' + mins + ' 分钟前' : '，约 ' + Math.round(mins / 60) + ' 小时前'; }
  apply();
}
</script>
</body>
</html>
`;
fs.mkdirSync('universal', { recursive: true });
fs.writeFileSync('universal/index.html', html);
console.log('RENDERED', JSON.stringify({ bytes: Buffer.byteLength(html), title, dek, rows: R.length, seen: seenAll, attn: attnAll, names: namesOk, ok: S.ok }));
