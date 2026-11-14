// Universal results page (v2): one list of every live room by store name, a tally-lamp overview, search,
// platform and "needs a look" filters, and copy-to-record. Works without JavaScript (filters and copy need it).
// Inputs: out/{jd,douyin,tmall,runs,samples}.json and private/names.json (optional; falls back to codes).
// Output: universal/index.html.   Usage: node render.mjs   (NEXT_REFRESH="11-15 09:10" adds a refresh note)
import fs from 'node:fs';
const rd = f => JSON.parse(fs.readFileSync('out/' + f, 'utf8'));
const jdAll = rd('jd.json').rows, dyAll = rd('douyin.json').rows, tmAll = rd('tmall.json').rows, runs = rd('runs.json').rows, S = rd('samples.json');
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
const slug = c => c.startsWith('#') ? 'd' + c.slice(1) : c.startsWith('T') ? 't' + c.slice(1) : 'j' + c.replace(/\D/g, '');
const nameOf = c => N[c]?.name || c, roleOf = c => N[c]?.role || '';
const startOf = t => (String(t).match(/(\d\d:\d\d) 开始/) || [])[1];
const lastOf = t => String(t).split('–').at(-1);
const asOf = { douyin: lastOf(runs[1].asOf), tmall: lastOf(runs[2].asOf), jd: lastOf(runs[0].asOf) };
const dyDate = latest(dyAll), tmDate = latest(tmAll), day = dyDate > tmDate ? dyDate : tmDate;
const CATS = ['冰箱', '洗衣机', '空调', '电视', '显示器'];

// one record per live room
const R = [];
const prevOf = (all, key, code, date) => all.filter(x => x[key] === code && x.date < date).sort((a, b) => b.date.localeCompare(a.date))[0];
for (const [p, pl, all, key, date] of [['douyin', '抖音', dyAll, 'account', dyDate], ['tmall', '天猫淘宝', tmAll, 'shop', tmDate]]) {
  for (const r of all.filter(x => x.date === date).sort((a, b) => num(a[key]) - num(b[key]))) {
    const code = r[key], st = r.result === SEEN ? 'seen' : r.result === UNSEEN ? 'unseen' : 'unknown';
    const smp = S.ok?.[p] ? S.rows.filter(s => s.platform === p && s.account === code) : [];
    const off = smp.filter(s => s.kind === 'notseen'), apiOff = off.length > 0 && off.every(s => s.api === 'OFFLINE');
    const start = p === 'tmall' && String(r.now).startsWith('在播') ? startOf(r.now) : null;
    const line = st === 'seen' ? `看到在播 ${r.seen}${start ? `，本场 ${start} 开始` : ''}`
      : st === 'unseen' ? (apiOff ? `${r.samples} 次采样，接口都显示未开播` : `${r.samples} 次采样都没看到在播`) : '没有核验通过的采样';
    const prev = prevOf(all, key, code, date);
    R.push({ id: slug(code), code, p, pl, name: nameOf(code), role: roleOf(code), st, status: st === 'seen' ? '已开播' : st === 'unseen' ? '采样中未见' : '无法判断',
      line, lineWarn: false, line2: '', attn: st === 'seen' ? [] : [st === 'unseen' ? '采样中未见' : '无法判断'], date, seen: st === 'seen' ? r.seen : '', start: start || '',
      samples: r.samples, smp, prev: prev ? `${short(prev.date)}：${prev.result === SEEN ? '已开播，看到在播 ' + prev.seen : prev.result}，核验 ${prev.samples} 次` : '' });
  }
}
for (const r of [...jdAll].sort((a, b) => num(a.room) - num(b.room))) {
  const code = r.room, name = nameOf(code), est = r.prevBasis.startsWith('估算'), m = Number(r.minutesToday) || 0;
  const late = r.live8 === '否', short24 = r.prevEnd === '没播到 24 点';
  const inName = CATS.find(c => name.includes(c));
  R.push({ id: slug(code), code, p: 'jd', pl: '京东', name, role: '', st: m > 0 ? 'seen' : 'unseen', status: m > 0 ? '已开播' : '今天还没有数据',
    line: `${r.live8 === '是' ? '8 点在播' : late ? '8 点时还没在播' : '8 点没有快照'}，今天累计 ${m} 分钟`, lineWarn: late,
    line2: `${short(r.prevDate)} 满播率 ${r.prevRate}${est ? '（估算）' : ''}`,
    attn: [late ? '8 点时还没在播' : '', short24 ? `${short(r.prevDate)} 没播到 24 点` : ''].filter(Boolean),
    date: r.todayDate, live8: r.live8, minutes: m, prevDate: r.prevDate, prevRate: r.prevRate, est, prevLast: r.prevLast, prevEnd: r.prevEnd,
    room: num(code), category: r.category, conflict: inName && r.category && inName !== r.category ? inName : '' });
}
const by = p => R.filter(r => r.p === p);
const seenAll = R.filter(r => r.st === 'seen').length, attnAll = R.filter(r => r.attn.length).length;
const title = seenAll === R.length ? `${R.length} 个直播间今天都开播了` : `${R.length} 个直播间里 ${seenAll} 个今天开播了`;
const dekParts = [];
for (const [p, pl, unit] of [['douyin', '抖音', '个账号'], ['tmall', '天猫淘宝', '家']]) { const n = by(p).filter(r => r.st !== 'seen').length; if (n) dekParts.push(`${pl} ${n} ${unit}采样中未见`); }
const late8 = by('jd').filter(r => r.live8 === '否').length;
if (late8) dekParts.push(`京东 ${late8} 家 8 点时还没在播`);
const dek = dekParts.length ? dekParts.join('；') + '。' : '没有需要关注的直播间。';

// pieces
const K = k => `<i class="k ${k}" aria-hidden="true"></i>`;
const lamp = r => `<a class="lamp ${r.st}${r.attn.length ? ' attn' : ''}" href="#${r.id}" aria-label="${esc(r.name)}：${esc(r.status)}${r.attn.length ? '，要关注' : ''}" title="${esc(r.name)}：${esc(r.status)}"></a>`;
const groupMeta = p => {
  const g = by(p), s = g.filter(r => r.st === 'seen').length;
  if (p === 'jd') return `开播 ${s}/${g.length}，8 点在播 ${g.filter(r => r.live8 === '是').length}/${g.length}`;
  return `开播 ${s}/${g.length}`;
};
const ruler = `<div class="rl" aria-hidden="true"><span style="left:0">06</span><span style="left:25%">12</span><span style="left:50%">18</span><span style="left:75%">24</span><span style="left:100%">06</span></div>`;
const strip = r => {
  if (!r.smp.length) return '<p class="fine">这一天没有逐次采样明细。</p>';
  const stop = asOf[r.p];
  const words = s => s.kind === 'seen' ? '看到在播' : s.kind === 'notseen' ? (s.api === 'OFFLINE' ? '接口显示未开播' : '没看到在播') : '未能核验';
  return `<p class="sub">今天的采样（每条竖线一次，06:00 到次日 06:00）</p>${ruler}<div class="tr" role="img" aria-label="${esc(r.smp.map(s => s.at + ' ' + words(s)).join('，'))}"><i class="fut" style="left:${posOf(stop).toFixed(2)}%"></i>${r.smp.map(s => `<i class="m ${s.kind}" style="left:${(s.pos * 100).toFixed(2)}%"></i>`).join('')}</div>
<ul class="smp">${r.smp.map(s => `<li>${K(s.kind === 'seen' ? 'seen' : s.kind === 'notseen' ? 'unseen' : 'unknown')}<b>${esc(s.at)}</b> ${esc(words(s))}</li>`).join('')}</ul>`;
};
const rate = s => { const m = String(s).match(/^([\d.]+)%(?:–([\d.]+)%)?$/); return m ? [Number(m[1]), Number(m[2] ?? m[1])] : null; };
const jdMore = r => {
  const v = rate(r.prevRate);
  const bar = v ? `<div class="bar" aria-hidden="true"><i class="lo" style="width:${v[0]}%"></i>${v[1] > v[0] ? `<i class="hi" style="left:${v[0]}%;width:${(v[1] - v[0]).toFixed(1)}%"></i>` : ''}</div>` : '';
  return `<div class="rate"><span>${esc(short(r.prevDate))} 满播率</span>${bar}<b>${esc(r.prevRate)}</b></div>
<ul class="facts"><li>${r.est ? `${esc(short(r.prevDate))} 没有 8 点快照，只能按「7–8 点开播」估算范围，斜纹是不确定的部分` : '按 8 点快照计算'}</li>
<li>${esc(short(r.prevDate))} 最后一分钟 ${esc(r.prevLast)}${r.prevEnd === '没播到 24 点' ? '，没播到 24 点' : r.prevEnd === '播到 24 点' ? '，播到了 24 点' : ''}</li>
<li>运营平台 ${r.room} 号直播间，品类「${esc(r.category)}」${r.conflict ? `（和名称里的「${esc(r.conflict)}」不一致，待运营平台核实）` : ''}</li></ul>`;
};
const row = r => {
  const tag = r.role === '考核' ? '<span class="tag">考核</span>' : '';
  const q = (r.name + ' ' + r.code + ' ' + r.pl + ' ' + (r.conflict ? '' : r.category || '')).toLowerCase().replace(/\s+/g, '');
  const extra = r.p === 'jd' ? r.attn.filter(a => a.includes('24 点')) : [];
  return `<details class="st" id="${r.id}" data-p="${r.p}" data-a="${r.attn.length ? 1 : 0}" data-q="${esc(q)}">
<summary><span class="nm">${esc(r.name)}${tag}</span><span class="pill">${K(r.st)}${esc(r.status)}</span>
<span class="ln${r.lineWarn ? ' warn' : ''}">${r.line.split('，').map((x, i, a) => `<span class="nw">${esc(x)}${i < a.length - 1 ? '，' : ''}</span>`).join('')}</span>${r.line2 ? `<span class="ln2">${esc(r.line2)}</span>` : ''}${extra.length ? `<span class="ln2 warn">${esc(extra.join('，'))}</span>` : ''}<i class="chev" aria-hidden="true"></i></summary>
<div class="more">${r.p === 'jd' ? jdMore(r) : strip(r) + (r.prev ? `<p class="fine">前一天 ${esc(r.prev)}</p>` : '')}<p class="fine">监控编号 ${esc(r.code)}</p></div>
</details>`;
};
const group = (p, pl) => `<section class="grp" data-p="${p}" aria-labelledby="g-${p}"><h2 id="g-${p}">${pl}<span>${esc(groupMeta(p))}</span></h2>${by(p).map(row).join('')}</section>`;

// data for copy-to-record (names, results and times only)
const recs = R.map(r => {
  const extra = r.p === 'jd' ? r.attn.filter(a => a.includes('24 点')) : [];
  return { id: r.id, p: r.pl, name: r.name, role: r.role, status: r.status, date: r.date,
    text: r.status + '，' + r.line + (r.line2 ? '；' + r.line2 : '') + (extra.length ? '；' + extra.join('，') : ''),
    seen: r.seen || '', start: r.start || '', live8: r.p === 'jd' ? (r.live8 === '是' ? '是' : r.live8 === '否' ? '否' : '') : '', minutes: r.p === 'jd' ? r.minutes : '',
    prevRate: r.p === 'jd' ? r.prevRate + (r.est ? '（估算）' : '') : '', note: r.attn.join('；') };
});
const recJson = JSON.stringify({ day, head: `TCL 直播记录 ${md(day)}（${wk(day)}）`, asOf: `快照：抖音 ${asOf.douyin}，天猫淘宝 ${asOf.tmall}，京东 ${asOf.jd}（不是实时）`, rows: recs }).replace(/</g, '\\u003c');
const runRow = r => `<tr><td>${esc(r.platform)}</td><td class="n">${esc(r.asOf)}</td><td class="n">${r.reachable === '—' ? '—' : esc(r.reachable) + '/' + esc(r.checked)}</td><td class="n">${r.verified === '—' ? '—' : esc(r.verified) + '/' + esc(r.checked)}</td></tr>`;
const now = new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date()).replace('/', '-');
const times = [asOf.douyin, asOf.tmall, asOf.jd].map(t => String(t).split('–')[0]).sort();

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
.lamp.attn::after{content:"";position:absolute;top:8px;right:5px;width:8px;height:8px;border-radius:50%;background:var(--warn);border:2px solid var(--plate)}
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
footer{margin:18px 0 0;padding:14px 0 30px;border-top:1px solid var(--line);font-size:13px;color:var(--mut);line-height:1.7}
@media (max-width:420px){.m{width:3px;margin-left:-1.5px}}
@media (min-width:720px){.board{padding:12px 16px 8px}.bg{display:grid;grid-template-columns:150px minmax(0,1fr);align-items:center;margin:0}.bl{flex-direction:column;align-items:flex-start;margin:0}.key{margin-top:6px}header{padding-top:32px}.find{display:grid;grid-template-columns:minmax(0,1fr) auto;grid-column-gap:12px;align-items:center}.seg{margin:0;padding:0}}
@media print{.tools{display:none!important}.st>summary .chev{display:none}}
</style>
</head>
<body>
<div class="wrap">
<header>
<p class="meta">${esc(md(day))} ${esc(wk(day))}　快照 ${esc(times[0])}–${esc(times.at(-1))}，不是实时</p>
<h1>${esc(title)}</h1>
<p class="dek">${esc(dek)}</p>
<div class="board" aria-label="每个直播间今天的开播情况，点一下跳到对应店铺">
${[['douyin', '抖音'], ['tmall', '天猫淘宝'], ['jd', '京东']].map(([p, pl]) => `<div class="bg"><p class="bl"><b>${pl}</b><span>${esc(groupMeta(p).split('，')[0])}</span></p><p class="lamps">${by(p).map(lamp).join('')}</p></div>`).join('')}
<p class="key"><span>${K('seen')}已开播 ${seenAll}</span>${R.some(r => r.st === 'unseen') ? `<span>${K('unseen')}采样中未见 ${R.filter(r => r.st === 'unseen').length}</span>` : ''}${R.some(r => r.st === 'unknown') ? `<span>${K('unknown')}无法判断 ${R.filter(r => r.st === 'unknown').length}</span>` : ''}${attnAll ? `<span><i class="dot" aria-hidden="true"></i>要关注 ${attnAll}</span>` : ''}</p>
</div>
</header>
<div class="tools">
<div class="find" role="search">
<input id="q" type="search" placeholder="搜索店铺名称，比如 空调、雷鸟" autocomplete="off" enterkeyhint="search" aria-label="搜索店铺名称">
<div class="seg" role="group" aria-label="按平台筛选"><button type="button" data-pf="all" aria-pressed="true">全部<span>${R.length}</span></button><button type="button" data-pf="douyin" aria-pressed="false">抖音<span>${by('douyin').length}</span></button><button type="button" data-pf="tmall" aria-pressed="false">天猫淘宝<span>${by('tmall').length}</span></button><button type="button" data-pf="jd" aria-pressed="false">京东<span>${by('jd').length}</span></button></div>
</div>
<div class="acts"><button type="button" id="attn" aria-pressed="false">只看要关注<span>${attnAll}</span></button><button type="button" id="cp">复制记录</button><button type="button" id="cpx">复制表格</button></div>
<p class="msg" id="msg" aria-live="polite"></p>
<textarea id="fb" readonly hidden aria-label="要复制的记录"></textarea>
<p class="empty" id="empty" hidden>没有符合条件的直播间。<button type="button" id="clr">清空搜索和筛选</button></p>
</div>
<main>
${group('douyin', '抖音')}
${group('tmall', '天猫淘宝')}
${group('jd', '京东')}
</main>
<details class="about"><summary>关于这些数据</summary>
<h3>数据时间</h3><p>抖音 ${esc(asOf.douyin)}，天猫淘宝 ${esc(asOf.tmall)}，京东 ${esc(asOf.jd)}（北京时间）。这是快照，不是实时；由 Claude 核对后刷新${process.env.NEXT_REFRESH ? '，下次计划 ' + esc(process.env.NEXT_REFRESH) : ''}。</p>
<h3>最近一次采样</h3><table><thead><tr><th>平台</th><th class="n">时间</th><th class="n">页面可达</th><th class="n">身份核验通过</th></tr></thead><tbody>${runs.map(runRow).join('')}</tbody></table>
<h3>怎么判断</h3><ul>
<li>抖音、天猫淘宝：只读公开页面，约每 2 小时采样一次。采样时看到在播、且身份核验通过，记「已开播」。凌晨 0–6 点看到在播算前一天。</li>
<li>「采样中未见」不等于没播：两次采样之间的直播可能漏掉。天猫淘宝接口显示「房间和流都关」的规则还没校准，所以不算确认下播。</li>
<li>京东：读运营平台的分钟数据，今天有分钟数据记「已开播」。考核时段 08:00–24:00（960 分钟），满播率 = 时段内有数据的分钟 ÷ 960，当天结束后才能算，次日早上出。采集中断会少算，低满播率要人工确认。</li>
<li>「要关注」：抖音、天猫淘宝当天采样中未见；京东 8 点时还没在播（按 7–8 点开播的安排），或前一天没播到 24 点。</li>
</ul>
<h3>店铺名称从哪来</h3><p>抖音、天猫淘宝用监控里登记的账号和店铺名称；京东用 TCL 运营平台里的直播间名称（${esc(N['jd-15']?.asOf ? short(N['jd-15'].asOf) : '11-12')} 读取）。名称只放在这个页面里，没有放进代码仓库和项目文档。${namesOk ? '' : '（这次没有读到名称表，暂时显示编号。）'}</p>
<p>只读采样，没有接入处罚或正式考核。</p>
</details>
<footer>生成于 ${esc(now)}（北京时间）</footer>
</div>
<script type="application/json" id="rec">${recJson}</script>
<script>
{
  const doc = document.documentElement;
  doc.classList.add('js');
  let data = { rows: [] };
  try { data = JSON.parse(document.getElementById('rec').textContent); } catch (e) {}
  const $ = s => document.querySelector(s), $$ = s => Array.prototype.slice.call(document.querySelectorAll(s));
  const q = $('#q'), rows = $$('.st'), groups = $$('.grp'), segs = $$('[data-pf]'), attn = $('#attn'), msg = $('#msg'), fb = $('#fb'), empty = $('#empty'), cp = $('#cp'), cpx = $('#cpx');
  let pf = 'all', only = false;
  const norm = s => String(s || '').toLowerCase().replace(/\\s+/g, '');
  const shown = () => rows.filter(r => !r.hidden);
  const apply = () => {
    const t = norm(q.value);
    rows.forEach(r => { r.hidden = !((pf === 'all' || r.dataset.p === pf) && (!only || r.dataset.a === '1') && (!t || r.dataset.q.indexOf(t) >= 0)); });
    groups.forEach(g => { g.hidden = !g.querySelector('.st:not([hidden])'); });
    const n = shown().length;
    empty.hidden = n > 0;
    cp.textContent = n === rows.length ? '复制记录' : '复制 ' + n + ' 条';
    cp.disabled = cpx.disabled = n === 0;
    msg.textContent = ''; fb.hidden = true;
  };
  const reset = () => { q.value = ''; pf = 'all'; only = false; segs.forEach(b => b.setAttribute('aria-pressed', String(b.dataset.pf === 'all'))); attn.setAttribute('aria-pressed', 'false'); apply(); };
  q.addEventListener('input', apply);
  segs.forEach(b => b.addEventListener('click', () => { pf = b.dataset.pf; segs.forEach(x => x.setAttribute('aria-pressed', String(x === b))); apply(); }));
  attn.addEventListener('click', () => { only = !only; attn.setAttribute('aria-pressed', String(only)); apply(); });
  $('#clr').addEventListener('click', reset);
  $$('.lamp').forEach(a => a.addEventListener('click', () => { const d = document.getElementById(a.getAttribute('href').slice(1)); if (!d) return; if (d.hidden) reset(); d.open = true; }));
  const pick = () => { const ids = {}; shown().forEach(r => { ids[r.id] = 1; }); return data.rows.filter(x => ids[x.id]); };
  const text = list => {
    const out = [data.head, data.asOf];
    ['抖音', '天猫淘宝', '京东'].forEach(p => {
      const g = list.filter(x => x.p === p); if (!g.length) return;
      out.push('', p + '（' + g.length + ' 个，已开播 ' + g.filter(x => x.status === '已开播').length + '）');
      g.forEach((x, i) => out.push((i + 1) + '. ' + x.name + (x.role === '考核' ? '〔考核〕' : '') + '：' + x.text));
    });
    out.push('', '注：采样约每 2 小时一次，「采样中未见」不等于没播。');
    return out.join('\\n');
  };
  const cell = v => String(v == null ? '' : v).replace(/[\\t\\n]/g, ' ');
  const table = list => [['日期', '平台', '店铺', '类型', '结果', '看到在播', '本场开始', '8点在播', '今天累计分钟', '上一日满播率', '要关注'].join('\\t')]
    .concat(list.map(x => [x.date, x.p, x.name, x.role, x.status, x.seen, x.start, x.live8, x.minutes, x.prevRate, x.note].map(cell).join('\\t'))).join('\\n');
  const copy = (t, n, what) => {
    const done = () => { msg.textContent = '已复制 ' + n + ' 条' + what; fb.hidden = true; };
    const fail = () => { fb.value = t; fb.hidden = false; fb.focus(); fb.select(); try { fb.setSelectionRange(0, t.length); } catch (e) {} msg.textContent = '这里不能自动复制。下面的文字已全选，长按选择「拷贝」即可。'; };
    try { navigator.clipboard.writeText(t).then(done, fail); } catch (e) { fail(); }
  };
  cp.addEventListener('click', () => { const l = pick(); copy(text(l), l.length, '记录，可以直接粘贴到微信'); });
  cpx.addEventListener('click', () => { const l = pick(); copy(table(l), l.length, '，粘贴到表格会自动分列'); });
  apply();
}
</script>
</body>
</html>
`;
fs.mkdirSync('universal', { recursive: true });
fs.writeFileSync('universal/index.html', html);
console.log('RENDERED', JSON.stringify({ bytes: Buffer.byteLength(html), title, dek, rows: R.length, seen: seenAll, attn: attnAll, names: namesOk, ok: S.ok }));
