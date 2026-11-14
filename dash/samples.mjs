// Per-sample observations of the latest broadcast day (06:00 to 06:00 Beijing), for the sampling timeline.
// Inputs: runs/dy-<runId>.log and runs/tm-<runId>.log (GitHub Actions logs), config key order in $MAIN_DIR/main-*.json (fetched from main by refresh.sh).
// Classification mirrors probes/r322/observation-ledger.mjs on main:
//   seen     = ledger LIVE (profile + room identity) or own-room live badge on a verified profile
//   notseen  = verified sample (state != NOT_RUN and profile identity verified) that was not seen live
//   unknown  = not run or identity not verified
// Validation: per account, sample count, verified count and first/last seen must equal the ledger's own
// R325_DAILY line in the newest log of that platform. A platform that does not match gets ok:false (no timeline).
// Output: out/samples.json. Accounts are masked (#n, Tn); no real identifiers are written.
import fs from 'node:fs';
const M = (process.env.MAIN_DIR || '/tmp/mainsrc') + '/main-';   // config files fetched from main by refresh.sh
const strip = l => l.replace(/\x1b\[[0-9;]*m/g, '').replace(/^[^\t]*\t[^\t]*\t[^ ]*Z /, '');
const tsOf = l => (l.match(/\t[﻿]?(\d{4}-\d\d-\d\dT[\d:.]+Z) /) || [])[1] || null;
const keysOf = f => JSON.parse(fs.readFileSync(M + f.replace(/^config\//, ''), 'utf8')).targets.map(t => t.key);
const dyKeys = [...keysOf('config/r316-douyin-rpa-targets.json'), ...keysOf('config/r326-douyin-targets-scoring-b.json'), ...keysOf('config/r329-douyin-targets-monitor-c.json'), ...keysOf('config/r329-douyin-targets-monitor-d.json')];
const tmKeys = JSON.parse(fs.readFileSync(M + 'probe-targets.json', 'utf8')).tmall.map(t => t.key);
const label = { douyin: k => { const i = dyKeys.indexOf(k); if (i < 0) throw new Error('DY_KEY_UNMAPPED'); return '#' + (i + 1); },
  tmall: k => { const i = tmKeys.indexOf(k); if (i < 0) throw new Error('TM_KEY_UNMAPPED'); return 'T' + (i + 1); } };
const OWN = new Set(['OWNER_HEADER_LIVE_ANCHOR', 'REGISTERED_ROOM_LIVE_ANCHOR']);
const bjDay = iso => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(iso));
const bday = iso => bjDay(new Date(Date.parse(iso) - 6 * 3600e3).toISOString());
const hhmm = iso => new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(iso));
const pos = iso => { const d = new Date(Date.parse(iso) + 8 * 3600e3); const m = d.getUTCHours() * 60 + d.getUTCMinutes() + d.getUTCSeconds() / 60; return Math.round(((m - 360 + 1440) % 1440) / 1440 * 10000) / 10000; };

const files = fs.readdirSync('runs').filter(f => /^(dy|tm)-\d+\.log$/.test(f));
const obs = { douyin: [], tmall: [] }, daily = { douyin: null, tmall: null };
for (const f of files.sort((a, b) => Number(a.split(/[-.]/)[1]) - Number(b.split(/[-.]/)[1]))) {
  const platform = f.startsWith('dy') ? 'douyin' : 'tmall', run = Number(f.split(/[-.]/)[1]);
  const lines = fs.readFileSync('runs/' + f, 'utf8').split('\n');
  for (const raw of lines) {
    const l = strip(raw);
    if (platform === 'douyin' && l.startsWith('R316_RPA {')) {
      const r = JSON.parse(l.slice(9));
      const pid = r.profileIdentityVerified === true, rid = r.roomIdentityVerified === true || r.roomPageIdentityVerified === true;
      const seen = (r.state === 'LIVE' && pid && rid) || (r.state !== 'NOT_RUN' && pid && r.liveBadgeSeen === true && OWN.has(r.ownerAnchorScope));
      const verified = r.state !== 'NOT_RUN' && pid;
      obs.douyin.push({ key: r.key, at: new Date(r.at).toISOString(), run, kind: seen ? 'seen' : verified ? 'notseen' : 'unknown', api: null });
    }
    if (platform === 'tmall' && l.startsWith('R329_TMALL {')) {
      const r = JSON.parse(l.slice(11)), at = tsOf(raw);
      if (!at) throw new Error('TM_SAMPLE_TIME_MISSING');
      const verified = r.state !== 'NOT_RUN' && r.identityVerified === true;
      obs.tmall.push({ key: r.key, at: new Date(at).toISOString(), run, kind: verified && r.state === 'LIVE' ? 'seen' : verified ? 'notseen' : 'unknown', api: r.state });
    }
  }
  const d = Object.values(Object.fromEntries(lines.map(strip).filter(x => x.startsWith('R325_DAILY {')).map(x => JSON.parse(x.slice(11)))
    .filter(x => x && typeof x.key === 'string' && typeof x.samples === 'number').map(x => [x.key + '|' + x.date, x])));
  if (d.length) daily[platform] = { run, rows: d };   // files are sorted by run id, so the newest run wins
}

const out = { ok: {}, day: {}, asOf: {}, rows: [], mismatches: [] };
for (const platform of ['douyin', 'tmall']) {
  const dl = daily[platform];
  if (!dl) { out.ok[platform] = false; out.mismatches.push(platform + ': no R325_DAILY'); continue; }
  const day = dl.rows.find(r => r.latestDay)?.date;
  const mine = obs[platform].filter(o => bday(o.at) === day);
  let ok = Boolean(day) && mine.length > 0;
  for (const d of dl.rows.filter(r => r.date === day)) {
    const s = mine.filter(o => o.key === d.key).sort((a, b) => a.at.localeCompare(b.at));
    const seen = s.filter(o => o.kind === 'seen'), ver = s.filter(o => o.kind !== 'unknown');
    const near = (a, b) => (a === null && b === null) || (a && b && Math.abs(Date.parse(a) - Date.parse(b)) <= (platform === 'tmall' ? 120e3 : 0));
    const status = seen.length ? 'BROADCAST_SEEN' : ver.length ? 'NOT_SEEN_IN_SAMPLES' : 'UNKNOWN';
    const bad = [];
    if (s.length !== d.samples) bad.push('samples ' + s.length + '≠' + d.samples);
    if (ver.length !== d.verifiedSamples) bad.push('verified ' + ver.length + '≠' + d.verifiedSamples);
    if (status !== d.status) bad.push('status');
    if (!near(seen[0]?.at ?? null, d.firstSeenAt) || !near(seen.at(-1)?.at ?? null, d.lastSeenAt)) bad.push('seen window');
    if (bad.length) { ok = false; out.mismatches.push(platform + ' ' + label[platform](d.key) + ': ' + bad.join(', ')); }
  }
  out.ok[platform] = ok; out.day[platform] = day || null;
  out.asOf[platform] = mine.length ? hhmm(mine.map(o => o.at).sort().at(-1)) : null;
  if (ok) for (const o of mine) out.rows.push({ platform, account: label[platform](o.key), date: day, at: hhmm(o.at), pos: pos(o.at), kind: o.kind, api: o.api });
}
out.rows.sort((a, b) => a.platform.localeCompare(b.platform) || Number(a.account.replace(/\D/g, '')) - Number(b.account.replace(/\D/g, '')) || a.pos - b.pos);
fs.writeFileSync('out/samples.json', JSON.stringify(out, null, 1));
console.log('SAMPLES', JSON.stringify({ ok: out.ok, day: out.day, asOf: out.asOf, rows: out.rows.length, mismatches: out.mismatches }));
