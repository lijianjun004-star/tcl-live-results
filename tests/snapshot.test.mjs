// Synthetic log fixtures only. Never contact collectors or publish pages.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import vm from 'node:vm';
import { assessFreshness, assessRefresh, isCountable } from '../dash/freshness.mjs';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const DAY = '2026-11-16', PREV = '2026-11-15';
const NOW = '2026-11-16T12:00:00.000Z';
const row = (roomId, date = DAY, extra = {}) => ({ roomId, date, category: '测试品类', method: 'FROM_0800_SNAPSHOT', ratePercent: 50,
  totalDayMinutes: 480, soFarMinutes: 60, liveByWindowStart: true, reachedWindowEnd: false, lastMinuteBeijing: '20:00', ...extra });
const line = (tag, value, at) => `job\tstep\t${at} ${tag} ${JSON.stringify(value)}`;

function fixture(t, rows, options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'results-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const config = path.join(dir, 'config');
  fs.mkdirSync(config);
  const dyKeys = ['synthetic_dy_primary', ...Array.from({length:options.fullOutage ? 6 : 0}, (_,i) => 'synthetic_dy_extra_'+i)];
  const targets = { 'r316-douyin-rpa-targets.json': dyKeys.map(key => ({key})),
    'r326-douyin-targets-scoring-b.json': [], 'r329-douyin-targets-monitor-c.json': [], 'r329-douyin-targets-monitor-d.json': [] };
  for (const [name, items] of Object.entries(targets)) fs.writeFileSync(path.join(config, 'main-' + name), JSON.stringify({ targets: items }));
  const tmallKeys = ['synthetic_tm_primary', ...(options.tmallStopped ? ['synthetic_tm_skipped'] : []),
    ...Array.from({length:options.fullOutage ? 7 : 0}, (_,i) => 'synthetic_tm_extra_'+i)];
  fs.writeFileSync(path.join(config, 'main-probe-targets.json'), JSON.stringify({ douyin: dyKeys.map(key => ({key})), tmall: tmallKeys.map(key => ({key})) }));
  const freshAt = new Date(Date.parse(NOW) - 60000).toISOString();
  const oldAt = new Date(Date.parse(NOW) - 6 * 3600e3).toISOString();
  const dyAt = options.staleDouyin ? oldAt : freshAt;
  const daily = (key, date = DAY, at = freshAt, valid = true) => ({ key, date, latestDay: true, samples: 1, verifiedSamples: valid ? 1 : 0,
    status: valid ? 'BROADCAST_SEEN' : 'UNKNOWN', firstSeenAt: valid ? at : null, lastSeenAt: valid ? at : null });
  const jdAt = options.staleJD ? new Date(Date.parse(NOW) - 2 * 864e5).toISOString() : freshAt;
  fs.writeFileSync(path.join(dir, 'jd.log'), rows.map(r => line('R327_JD_DAY', r, jdAt)).concat(line('R327_JD_FULLDAY', { rooms: 2, dailyOk: 2 }, jdAt)).join('\n'));
  const dyVerified = !options.unverifiedDouyin;
  const dyLog = dyKeys.flatMap(key => [line('R316_RPA', { key, at: dyAt, profileHttp: 200, profileIdentityVerified: dyVerified, roomIdentityVerified: dyVerified, state: dyVerified ? 'LIVE' : 'UNKNOWN' }, dyAt),
    line('R325_DAILY', daily(key, DAY, dyAt, dyVerified), dyAt)]).join('\n');
  fs.writeFileSync(path.join(dir, 'dy.log'), dyLog);
  const tmallStopped = options.tmallStopped;
  const tmLines = [line('R329_TMALL', { key: 'synthetic_tm_primary', http: 200, identityVerified: !tmallStopped,
    state: tmallStopped ? 'UNKNOWN' : 'LIVE', reason: tmallStopped ? 'STOPPED_API_ACCESS_LIMIT' : 'LIVE' }, freshAt)];
  if (tmallStopped && !options.stopWithoutProof) tmLines.push(line('R329_TMALL_STOPPED','API_ACCESS_LIMIT',freshAt));
  if (tmallStopped && options.explicitNotRun) tmLines.push(line('R329_TMALL_NOT_RUN',{ key:'synthetic_tm_skipped',at:freshAt,state:'NOT_RUN',reason:'STOPPED_AFTER_ACCESS_LIMIT' },freshAt));
  for (const key of tmallKeys) tmLines.push(line('R325_DAILY', { ...daily(key, DAY, freshAt, !tmallStopped),
    ...(options.explicitNotRun ? { attemptedSamples: key === 'synthetic_tm_primary' ? 1 : 0, notRunSamples: key === 'synthetic_tm_skipped' ? 1 : 0 } : {}) }, freshAt));
  const tmLog = tmLines.join('\n');
  fs.writeFileSync(path.join(dir, 'tm.log'), tmLog);
  fs.mkdirSync(path.join(dir, 'runs'));
  fs.writeFileSync(path.join(dir, 'runs/dy-102.log'), dyLog);
  fs.writeFileSync(path.join(dir, 'runs/tm-103.log'), tmLog);
  if (options.emptyDouyin) fs.writeFileSync(path.join(dir,'dy.log'),'');
  const env = { ...process.env, MAIN_DIR: config, RUN_JD: '101', RUN_DY: '102', RUN_TM: '103', GITHUB_RUN_ID: '200',
    LATEST_JD_RUN: options.latestJDRun ? JSON.stringify(options.latestJDRun) : '' };
  const clockFile = path.join(dir,'clock.mjs');
  fs.writeFileSync(clockFile, `const ActualDate = Date; const at = Date.parse(${JSON.stringify(NOW)}); globalThis.Date = class extends ActualDate { constructor(...args) { super(...(args.length ? args : [at])); } static now() { return at; } };`);
  const run = file => spawnSync(process.execPath, ['--import', pathToFileURL(clockFile).href, path.join(ROOT, 'dash', file)], { cwd: dir, env, encoding: 'utf8' });
  const build = run('build.mjs');
  if (options.expectBuildFailure) return { build, dir };
  assert.equal(build.status, 0, build.stderr);
  const data = JSON.parse(fs.readFileSync(path.join(dir, 'out/jd.json'))).rows;
  const samplesResult = run('samples.mjs');
  assert.equal(samplesResult.status, 0, samplesResult.stderr);
  const samples = JSON.parse(fs.readFileSync(path.join(dir,'out/samples.json')));
  const runs = JSON.parse(fs.readFileSync(path.join(dir,'out/runs.json'))).rows;
  const render = run('render.mjs');
  assert.equal(render.status, 0, render.stderr);
  const html = fs.readFileSync(path.join(dir, 'universal/index.html'), 'utf8');
  const recs = JSON.parse(html.match(/<script type="application\/json" id="rec">([\s\S]*?)<\/script>/)[1]).rows;
  return { data, html, recs, dir, env, dyAt, freshAt, samples, runs };
}

test('preflight replay excludes old JD data from today and separates an unsuccessful latest attempt', t => {
  const rows = Array.from({length:7}, (_, i) => row(String(101+i), '2026-11-14'));
  const f = fixture(t, rows, {
    fullOutage: true, staleJD: true, unverifiedDouyin: true, tmallStopped: true,
    latestJDRun: { id: 104, at: '2026-11-16T11:55:00.000Z', conclusion: 'failure' }
  });
  assert.ok(f.data.every(r => r.todayDate === DAY && r.todayMissing && r.historyDate === '2026-11-14'));
  assert.equal(f.recs.length, 23);
  assert.ok(f.recs.every(r => /无法判断/.test(r.status)));
  assert.match(f.html, /<h1[^>]*>本日暂无可确认的开播数据<\/h1>/);
  assert.match(f.html, /最近历史 2026-11-14，记录 480 分钟（不计入当天）/);
  assert.equal(f.runs[0].latestRun.conclusion, 'failure');
  assert.equal(f.runs[1].atTo, f.dyAt);
  assert.equal(f.runs[1].verifiedAt, null);
  assert.equal(f.runs[2].atTo, f.freshAt);
  assert.equal(f.runs[2].verifiedAt, null);
  assert.match(f.html, /本版采用的采集尝试/);
  assert.match(f.html, /最近有效观测/);
  assert.match(f.html, /发布记录/);
  assert.match(f.html, /data-refresh-due="2026-11-16T12:03:00.000Z"/);
});

test('preflight replay Tmall legacy stop preserves real attempts and audits skipped placeholders', t => {
  const f = fixture(t, [row('101')], {tmallStopped:true});
  assert.equal(f.samples.ok.tmall, true);
  assert.deepEqual(f.samples.rows.filter(r=>r.platform==='tmall').map(r=>r.account), ['T1']);
  assert.deepEqual(f.samples.notRun.tmall, { T2: 1 });
  assert.match(f.html, /未执行 1 次（停止后记录，不计入访问）/);
});

test('preflight replay Tmall early-stop count rejects undocumented omissions', t => {
  const f = fixture(t, [row('101')], {tmallStopped:true,stopWithoutProof:true});
  assert.equal(f.samples.ok.tmall, false);
  assert.deepEqual(f.samples.rows.filter(r=>r.platform==='tmall'), []);
});

test('preflight replay Tmall explicit NOT_RUN receipt is recorded once and never drawn', t => {
  const f = fixture(t, [row('101')], {tmallStopped:true,explicitNotRun:true});
  assert.equal(f.samples.ok.tmall, true);
  assert.deepEqual(f.samples.notRun.tmall, { T2: 1 });
  assert.equal(f.samples.rows.filter(r=>r.platform==='tmall').length, 1);
});

test('first day with no previous record builds and renders without inventing a rate', t => {
  const f = fixture(t, [row('101')]);
  assert.equal(f.data[0].previousMissing, true);
  assert.equal(f.data[0].prevMinutes, null);
  assert.equal(f.data[0].prevRate, '—');
  assert.match(f.html, /没有上一日记录，不推算满播率或停播状态/);
  assert.doesNotMatch(f.html, /undefined%|null%|NaN%/);
});

test('a whole missing platform still blocks publication instead of publishing a partial dataset', t => {
  const f=fixture(t,[row('101'),row('101',PREV)],{emptyDouyin:true,expectBuildFailure:true});
  assert.notEqual(f.build.status,0);
  assert.match(f.build.stderr,/EMPTY_DATASET/);
  assert.equal(fs.existsSync(path.join(f.dir,'out/jd.json')),false);
});

test('room absent today remains visible as unknown, not zero minutes or offline', t => {
  const f = fixture(t, [row('101'), row('101', PREV), row('102', PREV)]);
  const missing = f.data.find(r => r.room === 'jd-102');
  const visible = f.recs.find(r => r.id === 'j102');
  assert.equal(missing.todayMissing, true);
  assert.equal(missing.minutesToday, null);
  assert.equal(visible.status, '当天数据缺失，无法判断');
  assert.equal(visible.minutes, null);
  assert.doesNotMatch(visible.text, /累计 0 分钟|停播/);
  assert.match(visible.text, /数据截至 时间无法确认/);
  assert.equal(visible.asOfIso, '');
});

test('an older day is not silently relabelled as yesterday', t => {
  const f = fixture(t, [row('101'), row('101', '2026-11-13')]);
  assert.equal(f.data[0].prevDate, PREV);
  assert.equal(f.data[0].previousMissing, true);
  assert.equal(f.data[0].prevRate, '—');
});

test('genuine zero remains zero and missing snapshot rates never become null percent', t => {
  const f = fixture(t, [row('101', DAY, { soFarMinutes: 0 }), row('101', PREV, { ratePercent: null })]);
  assert.equal(f.data[0].minutesToday, 0);
  assert.equal(f.recs.find(r => r.id === 'j101').status, '当天累计 0 分钟');
  assert.equal(f.data[0].prevRate, '—');
});

test('fresh timestamps on one platform cannot conceal stale timestamps on another', t => {
  const f = fixture(t, [row('101'), row('101', PREV)], { staleDouyin: true });
  const dy = f.html.match(/<section class="grp" data-p="douyin"[\s\S]*?<\/section>/)[0];
  const jd = f.html.match(/<section class="grp" data-p="jd"[\s\S]*?<\/section>/)[0];
  assert.match(dy, /data-age-state="STALE"/);
  assert.match(jd, /data-age-state="CURRENT"/);
  const old = f.recs.find(r => r.p === '抖音'), current = f.recs.find(r => r.p === '京东');
  assert.notEqual(old.asOfIso, current.asOfIso);
  assert.equal(old.status, '无法判断');
  assert.equal(current.status, '已开播');
  assert.match(old.text, /数据截至/);
});

test('freshness treats absent/invalid/future timestamps as unknown, never a zero age', () => {
  const now = Date.parse('2026-11-16T12:00:00Z');
  for (const at of [null, '', 'invalid', '2026-11-17T12:00:00Z']) assert.equal(assessFreshness(at, now).state, 'UNKNOWN');
  assert.equal(assessFreshness('2026-11-16T09:00:00Z', now).state, 'CURRENT');
  assert.equal(assessFreshness('2026-11-16T08:59:59Z', now).state, 'STALE');
});

test('the open page expires old results and warns when the next scheduled refresh did not appear', t => {
  const f = fixture(t, [row('101'), row('101', PREV)]);
  const source = f.html.match(/<script>\n([\s\S]*?)<\/script>/)[1];
  new vm.Script(source); // Validate the complete emitted browser script, including table exports.
  const element = attributes => ({ attributes, textContent: '', getAttribute: n => attributes[n], setAttribute: (n,v) => { attributes[n]=v; },
    toggleAttribute(n,v) { if (v) attributes[n] = ''; else delete attributes[n]; } });
  const node = element({ 'data-source-time': f.freshAt });
  const plan = element({ 'data-refresh-due': f.html.match(/data-refresh-due="([^"]+)"/)[1] });
  const title = element({});
  const card = element({'data-a':'0'});
  const lamp = element({'data-room-lamp':'j101'});
  const attention = element({});
  const entries = { '[data-source-time]':[node], '[data-refresh-due]':[plan], '[data-current-total]':[title],
    '[data-room-lamp]':[lamp], '[data-attention-total]':[attention] };
  const summaryData = f.html.match(/<script type="application\/json" id="freshness-summary">([\s\S]*?)<\/script>/)[1];
  let timer;
  let now = Date.parse(f.freshAt) + 60000;
  class Clock extends Date { static now() { return now; } }
  const browser = { Date: Clock, document: { querySelectorAll: s => entries[s] || [], getElementById: id => id === 'freshness-summary' ? {textContent:summaryData} : id === 'j101' ? card : null, addEventListener() {} }, setInterval(fn) { timer=fn; } };
  vm.runInNewContext(source.split('\n{\n  const doc')[0], browser);
  assert.equal(node.attributes['data-age-state'], 'CURRENT');
  assert.equal(title.textContent, '3 个直播间已确认开播');
  assert.equal(plan.attributes['data-refresh-state'], 'PENDING');
  assert.equal(card.attributes['data-expired'], undefined);
  assert.equal(lamp.attributes['data-expired'], undefined);
  now += 183 * 60e3;
  timer();
  assert.equal(node.attributes['data-age-state'], 'STALE');
  assert.match(node.textContent, /需核对/);
  assert.equal(title.textContent, '本日暂无可确认的开播数据');
  assert.equal(plan.attributes['data-refresh-state'], 'OVERDUE');
  assert.equal(card.attributes['data-expired'], '');
  assert.equal(card.attributes['data-a'], '1');
  assert.equal(lamp.attributes['data-expired'], '');
  assert.match(lamp.attributes['aria-label'], /已过期.*无法判断/);
  assert.equal(attention.textContent, '3');
});

test('midnight separates JD calendar days while Douyin and Tmall continue until 06:00', () => {
  const at = '2026-11-16T15:59:00.000Z', midnight = Date.parse('2026-11-16T16:00:00.000Z');
  const record = { kind:'seen',date:DAY,at,blocked:false };
  assert.equal(isCountable({...record,platform:'jd'},midnight),false);
  assert.equal(isCountable({...record,platform:'douyin'},midnight),true);
  const six = Date.parse('2026-11-16T22:00:00.000Z');
  assert.equal(isCountable({...record,platform:'tmall',at:'2026-11-16T21:59:00Z'},six),false);
  assert.equal(assessRefresh('2026-11-16T12:03:00Z',Date.parse('2026-11-16T12:03:00Z')).state,'OVERDUE');
});

test('rendered datasets and page pass the existing identifier leak gate', t => {
  const f = fixture(t, [row('101'), row('101', PREV)]);
  const files = fs.readdirSync(path.join(f.dir,'out')).map(n => path.join('out',n));
  const checked = spawnSync(process.execPath, [path.join(ROOT,'dash/leakcheck.mjs'), ...files, 'universal/index.html'], { cwd:f.dir, env:f.env, encoding:'utf8' });
  assert.equal(checked.status, 0, checked.stdout + checked.stderr);
});

test('refresh shell builds with synthetic collector logs and stops when the timeline list cannot be read', { skip: process.platform === 'win32' }, t => {
  const f = fixture(t, [row('101')]);
  const bin = path.join(f.dir, 'bin');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'gh'), `#!/usr/bin/env bash
if [[ $1 == run && $2 == view ]]; then
  case "$3" in
    101) cat "$FIXTURES/jd.log"; exit ;;
    102) cat "$FIXTURES/dy.log"; exit ;;
    103) cat "$FIXTURES/tm.log"; exit ;;
  esac
fi
if [[ $1 == api ]]; then
  workflow=$(printf '%s' "$2" | cut -d / -f 6)
  case "$2" in
    *status=completed*) echo null; exit ;;
    *created=*)
      if [[ $FAIL_TIMELINE == 1 && $workflow == 417529171 ]]; then exit 7; fi ;;
    *contents/config/*)
      config=$(basename "$2" | cut -d '?' -f 1)
      base64 "$FIXTURES/config/main-$config"; exit ;;
  esac
  case "$workflow" in
    417538022) echo 101; exit ;;
    417529171) echo 102; exit ;;
    417885046) echo 103; exit ;;
  esac
fi
exit 8
`, { mode: 0o700 });
  function refresh(dirName, failTimeline) {
    const work = path.join(f.dir, dirName);
    fs.cpSync(path.join(ROOT, 'dash'), work, { recursive: true });
    const result = spawnSync('bash', ['refresh.sh'], { cwd: work, encoding: 'utf8', env: {
      ...f.env, PATH: bin + path.delimiter + path.dirname(process.execPath) + path.delimiter + process.env.PATH,
      FIXTURES: f.dir, FAIL_TIMELINE: failTimeline, MAIN_DIR: path.join(work, 'config'),
      NODE_OPTIONS: '--import=' + pathToFileURL(path.join(f.dir, 'clock.mjs')).href
    } });
    return { result, html: fs.existsSync(path.join(work, 'universal/index.html')) };
  }
  const good = refresh('refresh-good', '0');
  assert.equal(good.result.status, 0, good.result.stderr + good.result.stdout);
  assert.equal(good.html, true);
  const failed = refresh('refresh-failed', '1');
  assert.notEqual(failed.result.status, 0);
  assert.match(failed.result.stderr, /TIMELINE_RUN_LIST_FAILED/);
  assert.equal(failed.html, false);
});

test('publisher reports PUBLISHED only after successful refresh, deployment and a returned URL', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(),'publish-status-test-'));
  t.after(() => fs.rmSync(dir,{recursive:true,force:true}));
  const workflow = fs.readFileSync(path.join(ROOT,'.github/workflows/publish.yml'),'utf8');
  const step = workflow.split('      - name: Record actual publication outcome\n')[1];
  assert.match(step,/if: always\(\)/);
  const script = step.split('        run: |\n')[1].split('\n').map(l => l.replace(/^          /,'')).join('\n');
  for (const [refresh,deploy,url,published] of [
    ['success','success','https://example.invalid/results/',true],
    ['failure','skipped','',false], ['success','failure','',false],
    ['success','success','',false], ['skipped','skipped','',false]
  ]) {
    const result=spawnSync('bash',['-euo','pipefail','-c',script],{encoding:'utf8',env:{...process.env,
      REFRESH_OUTCOME:refresh,DEPLOY_OUTCOME:deploy,PUBLISHED_URL:url,COLLECTOR_RUN_ID:'12345',DISPATCHER_RUN_ID:'67890',GITHUB_STEP_SUMMARY:path.join(dir,'summary.md')}});
    assert.equal(result.status,0,result.stderr);
    assert.match(result.stdout,new RegExp('"status":"'+(published?'PUBLISHED':'NOT_PUBLISHED')+'"'));
    if (published) assert.match(result.stdout,/"collectorRunId":"12345","dispatcherRunId":"67890"/);
  }
  const summary=fs.readFileSync(path.join(dir,'summary.md'),'utf8');
  assert.match(summary,/actions\/runs\/12345/);
  assert.match(summary,/actions\/runs\/67890/);
});
