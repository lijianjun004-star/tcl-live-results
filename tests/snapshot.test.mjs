// Synthetic log fixtures only. Never contact collectors or publish pages.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import vm from 'node:vm';
import { v2Counts, v2Export, v2State } from '../dash/v2-view.mjs';
import { createV2Projector } from '../dash/v2.mjs';
import { tenTargetRound, fixtureTimes, result } from './fixtures/v2.mjs';
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
    ...Array.from({length:options.fullOutage ? 7 : options.allTmall ? 8 : 0}, (_,i) => 'synthetic_tm_extra_'+i)];
  const round = options.round || tenTargetRound();
  const tmall = tmallKeys.map((key, i) => {
    const room = round.evidence.resolved.rooms[i];
    const accountId = new URL(room.room_url).searchParams.get('userId');
    return { key, accountId };
  });
  fs.writeFileSync(path.join(config, 'main-probe-targets.json'), JSON.stringify({ douyin: dyKeys.map(key => ({key})), tmall }));
  // Run the same production entry points against an isolated, immutable synthetic enrollment.
  const scripts = path.join(dir, 'dash');
  fs.mkdirSync(path.join(scripts, 'private'), { recursive: true });
  for (const name of fs.readdirSync(path.join(ROOT, 'dash')).filter(name => /\.(mjs|sh|py)$/.test(name))) {
    fs.copyFileSync(path.join(ROOT, 'dash', name), path.join(scripts, name));
  }
  fs.copyFileSync(path.join(ROOT, 'dash/private/names.json'), path.join(scripts, 'private/names.json'));
  const enrolled = round.registry.map((entry, i) => tmall[i] ? {
    ...entry, legacyKeyHash: createHash('sha256').update(tmall[i].key).digest('hex')
  } : entry);
  fs.writeFileSync(path.join(scripts, 'private/v2-roster.json'), JSON.stringify(enrolled));
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
  delete env.V2_PRIVATE_DIR; // Shell environments can contain a real evidence path.
  if (options.round) {
    env.V2_PRIVATE_DIR = path.join(dir, 'v2-input');
    fs.mkdirSync(env.V2_PRIVATE_DIR);
    for (const [file, value] of Object.entries({
      source: round.source, latest: options.latest || null, monitor_snapshot: round.evidence.snapshot,
      resolved_rooms: round.evidence.resolved, run_summary: round.evidence.summary, control_live_result: round.evidence.control
    })) fs.writeFileSync(path.join(env.V2_PRIVATE_DIR, file + '.json'), JSON.stringify(value));
    if (options.history) {
      const entries = options.history.map(previous => {
        const entry = 'history/' + previous.source.runId + '-' + previous.source.attempt;
        const directory = path.join(env.V2_PRIVATE_DIR, entry);
        fs.mkdirSync(directory, { recursive: true });
        for (const [file, value] of Object.entries({
          source: previous.source, monitor_snapshot: previous.evidence.snapshot,
          resolved_rooms: previous.evidence.resolved, run_summary: previous.evidence.summary,
          control_live_result: previous.evidence.control
        })) fs.writeFileSync(path.join(directory, file + '.json'), JSON.stringify(value));
        return entry;
      });
      fs.writeFileSync(path.join(env.V2_PRIVATE_DIR, 'history.json'), JSON.stringify({ status: 'complete', entries }));
    }
  }
  const clockFile = path.join(dir,'clock.mjs');
  fs.writeFileSync(clockFile, `const ActualDate = Date; const at = Date.parse(${JSON.stringify(NOW)}); globalThis.Date = class extends ActualDate { constructor(...args) { super(...(args.length ? args : [at])); } static now() { return at; } };`);
  const run = file => spawnSync(process.execPath, ['--import', pathToFileURL(clockFile).href, path.join(scripts, file)], { cwd: dir, env, encoding: 'utf8' });
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
  return { data, html, recs, dir, env, dyAt, freshAt, samples, runs, run, scripts };
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
    fs.cpSync(f.scripts, work, { recursive: true });
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

function project(round) {
  return createV2Projector(round.registry)(round.evidence, round.source);
}

test('scheduled and manual snapshots produce the same public projection only with matching provenance', () => {
  const round = tenTargetRound();
  const legacyManual = project(round);
  for (const event of ['workflow_dispatch', 'schedule']) {
    round.source.event = event;
    round.evidence.summary.event = event;
    assert.deepEqual(project(round), legacyManual);
    round.evidence.summary.event = event === 'schedule' ? 'workflow_dispatch' : 'schedule';
    assert.throws(() => project(round));
  }
  round.source.event = round.evidence.summary.event = 'pull_request';
  assert.throws(() => project(round));
  delete round.source.event;
  round.evidence.summary.event = 'schedule';
  assert.throws(() => project(round));
});

test('ten enrolled targets reconcile against the first-round shape in either input order', () => {
  const round = tenTargetRound(), model = project(round);
  assert.deepEqual(model.counts, { covered: 10, live: 0, offline: 0, replay: 0, unknown: 10, skipped: 6, uncalibrated: 0, assessedValid: 0 });
  assert.deepEqual(model.rows.map(r => r.id), ['T1', 'T2', 'T3', 'T4', 'T5', 'T6', 'T7', 'T8', 'T9', 'J-C01']);
  for (const r of model.rows) {
    assert.equal(r.role, r.id === 'T1' ? 'assessed' : r.id === 'J-C01' ? 'candidate' : 'monitor');
    const attempted = ['T1', 'T4', 'T7', 'J-C01'].includes(r.id);
    assert.equal(r.skipped, !attempted);
    const rawTime = r.id === 'J-C01' ? fixtureTimes.discovery : attempted ? fixtureTimes.challenge : fixtureTimes.skip;
    assert.equal(r.recordedAt, new Date(rawTime).toISOString());
    assert.equal(r.attemptedAt, attempted ? r.recordedAt : null);
    assert.equal(r.verifiedAt, null);
    assert.equal(r.status, 'unknown');
    assert.equal(r.reason, r.id === 'J-C01' ? 'no_candidate' : attempted ? 'challenge' : 'circuit');
  }
  assert.equal(model.source.control, 'not_configured');
  round.evidence.snapshot.rooms.reverse();
  round.evidence.resolved.rooms.push(round.evidence.resolved.rooms.shift());
  assert.deepEqual(project(round), model);
  const rerun = tenTargetRound(2), second = project(rerun);
  assert.equal(second.source.attempt, 2);
  assert.deepEqual(second.rows, model.rows);
  assert.deepEqual(second.counts, model.counts);
  assert.throws(() => createV2Projector(rerun.registry)(rerun.evidence, round.source));
});

test('evidence, roles and offline calibration control the point-in-time assessment', () => {
  const round = tenTargetRound();
  const identity = { identity_verified: true };
  const offline = { ...identity, offline_evidence: true, offline_rule_validated: true };
  result(round, 0, 'OK', 'live', identity).live_id = '86000001';
  result(round, 1, 'OFFLINE', 'offline', offline);
  result(round, 2, 'OFFLINE', 'replay', offline);
  result(round, 3, 'OFFLINE', 'offline', { ...offline, offline_rule_validated: false });
  result(round, 4, 'OFFLINE', 'offline', { ...offline, offline_evidence: false });
  result(round, 5, 'OK', 'live', { identity_verified: false }).live_id = '86000006';
  result(round, 6, 'OK', 'live', identity).live_id = null;
  result(round, 7, 'LOGIN_REQUIRED');
  result(round, 8, 'NAV_TIMEOUT');
  const model = project(round);
  assert.deepEqual(model.rows.map(r => r.status), ['live', 'offline', 'replay', ...Array(7).fill('unknown')]);
  assert.deepEqual(model.rows.slice(7).map(r => r.reason), ['login', 'timeout', 'no_candidate']);
  assert.equal(model.rows[3].reason, 'uncalibrated');
  assert.ok(model.rows.slice(0, 3).every(r => r.verifiedAt === r.recordedAt));
  assert.ok(model.rows.slice(3).every(r => r.verifiedAt === null));
  assert.equal(model.counts.assessedValid, 1);
  result(round, 0, 'REDIRECTED');
  result(round, 1, 'POST_AUDIT_BLOCKED');
  const blocked = project(round);
  assert.equal(blocked.counts.assessedValid, 0);
  assert.deepEqual(blocked.rows.slice(0, 2).map(r => r.reason), ['redirect', 'blocked']);
});

test('JD candidate links and apparent live results alone cannot prove the enrolled shop is live', () => {
  for (const verification of ['candidate_unverified', 'resolved_link']) {
    const round = tenTargetRound();
    const raw = result(round, 9, 'OK', 'live', { identity_verified: true });
    const discovered = round.evidence.resolved.rooms[9];
    raw.live_id = '86000011';
    raw.room_url = 'https://lives.jd.com/#/' + raw.live_id;
    Object.assign(discovered, { source: 'fresh', code: 'OK', reason: null, live_id: raw.live_id, room_url: raw.room_url, verification });
    Object.assign(raw.discovery, { source: 'fresh', code: 'OK', reason: null });
    const candidate = project(round).rows[9];
    assert.equal(candidate.status, 'unknown');
    assert.equal(candidate.verifiedAt, null);
    assert.equal(candidate.role, 'candidate');
  }
});

test('zero-request skips require corroboration and a blocked request never becomes verified', () => {
  const round = tenTargetRound();
  for (const [index, diagnostics] of [[1, {}], [2, { network_requests: 1 }]]) {
    round.evidence.snapshot.rooms[index].diagnostics = diagnostics;
  }
  const model = project(round);
  assert.equal(model.counts.skipped, 4);
  assert.ok(model.rows.slice(1, 3).every(r => !r.skipped && r.status === 'unknown' && r.verifiedAt === null && r.reason !== 'circuit'));
});

test('invalid enrollment, handoff or provenance fails before producing a projection', () => {
  const changes = [
    ['missing row', e => e.snapshot.rooms.pop()],
    ['duplicate key', e => { e.resolved.rooms[1].target_key = e.resolved.rooms[0].target_key; }],
    ['extra key', e => { e.snapshot.rooms[0].target_key = 'new-unapproved-shop'; }],
    ['substituted platform', e => { e.snapshot.rooms[0].platform = 'jd'; }],
    ['swapped anchor', e => { e.resolved.rooms[0].room_url = e.resolved.rooms[1].room_url; }],
    ['substituted display identity', e => { e.snapshot.rooms[0].display_name = '其他门店'; }],
    ['unknown snapshot schema', e => { e.snapshot.schema_version = '1.0'; }],
    ['unknown discovery schema', e => { e.resolved.schema_version = '3.0'; }],
    ['snapshot and discovery from different attempts', e => { e.resolved.run_id = '970003.99'; }],
    ['substituted registered JD shop ID', e => { e.resolved.rooms[9].audit.shop.shop_id = '86000099'; }],
    ['inconsistent control', e => { e.summary.positive_live_control = true; }],
    ['wrong source repository', e => { e.summary.repository = 'synthetic/other'; }],
    ['wrong source branch', e => { e.summary.branch = 'other'; }],
    ['non-live run', e => { e.summary.engine = 'fixture'; }],
    ['wrong source revision', e => { e.summary.head_sha = 'b'.repeat(40); }],
    ['unvalidated schema handoff', e => { e.summary.contract_validation.monitor_snapshot = 'error'; }],
    ['summary total', e => { e.summary.targets_total++; }],
    ['summary code counts', e => { e.summary.by_code.GROUP_CIRCUIT_OPEN++; }],
    ['snapshot platform counts', e => { e.snapshot.summary.by_platform.jd++; }],
    ['schema-inconsistent status', e => { e.snapshot.rooms[0].live_status = 'offline'; }],
    ['unexpected schema field', e => { e.snapshot.rooms[0].undocumented = true; }]
  ];
  const duplicated = tenTargetRound();
  duplicated.registry[1].id = 'T1';
  assert.throws(() => project(duplicated));
  for (const [label, change] of changes) {
    const round = tenTargetRound();
    change(round.evidence);
    assert.throws(() => project(round), undefined, label);
  }
});

test('public V2 projection strips source URLs, enrolled names, diagnostic payloads and private fields', () => {
  const round = tenTargetRound();
  const row = round.evidence.snapshot.rooms[0];
  row.diagnostics.operator_note = 'sentinel-sensitive-value';
  row.item_title = 'sentinel-hidden-item';
  const model = project(round), output = JSON.stringify(model);
  const allowed = ['id', 'platform', 'role', 'recordedAt', 'attemptedAt', 'verifiedAt', 'status', 'reason', 'skipped'].sort();
  for (const r of model.rows) assert.deepEqual(Object.keys(r).sort(), allowed);
  for (const secret of [row.target_key, row.display_name, row.room_url, row.diagnostics.operator_note, row.item_title, 'CAPTCHA_X5SEC', 'account_group', 'room_url', 'diagnostics', 'thumbnail']) {
    assert.ok(!output.includes(secret), 'private evidence present in projection');
  }
});

test('each V2 clock is evaluated at 180 minutes, +5 minutes and its own Beijing day boundary', () => {
  const round = tenTargetRound();
  result(round, 0, 'OK', 'live', { identity_verified: true }).live_id = '86000001';
  const valid = project(round).rows[0];
  const at = Date.parse(valid.verifiedAt);
  for (const [difference, expected] of [[180 * 60000, 'CURRENT'], [180 * 60000 + 1, 'STALE'], [-5 * 60000, 'CURRENT'], [-5 * 60000 - 1, 'UNKNOWN']]) {
    const state = v2State(valid, at + difference);
    assert.equal(state.age, expected);
    assert.equal(state.current, expected === 'CURRENT' ? 'live' : 'unknown');
    assert.equal(v2Counts([valid], at + difference).assessedValid, expected === 'CURRENT' ? 1 : 0);
  }
  for (const [platform, iso] of [['jd', '2026-11-16T16:00:00Z'], ['tmall', '2026-11-16T22:00:00Z']]) {
    const cutover = Date.parse(iso), verifiedAt = new Date(cutover - 1000).toISOString();
    const row = { ...valid, platform, verifiedAt, attemptedAt: verifiedAt, recordedAt: verifiedAt };
    assert.equal(v2State(row, cutover - 1).current, 'live');
    assert.equal(v2State(row, cutover).age, 'STALE');
    assert.equal(v2Export(row, cutover).age, '历史');
    assert.equal(v2Export(row, cutover).status, '无法判断');
  }
  assert.equal(v2State({ ...valid, verifiedAt: null }, at).current, 'unknown');
  const skipped = project(round).rows[1];
  assert.equal(v2Export(skipped, at).attempt, '');
  assert.equal(v2Export(skipped, at).verified, '');
  assert.match(v2Export(skipped, at).schedule, /19:59:03$/);
});

test('scheduled records render on the existing cards and pass the publication privacy scan', t => {
  const round = tenTargetRound();
  round.source.event = 'schedule';
  round.evidence.summary.event = 'schedule';
  const v2 = { ...project(round), latest: { runId: '970004', attempt: 1, at: NOW, conclusion: 'failure' } };
  const base = fixture(t, [row('101'), row('101', PREV)], { allTmall: true });
  const f = fixture(t, [row('101'), row('101', PREV)], { round, latest: v2.latest, allTmall: true });
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(f.dir, 'out/v2.json'))), v2);
  const scan = spawnSync(process.execPath, [path.join(ROOT, 'dash/leakcheck.mjs'), 'out', 'universal/index.html'],
    { cwd: f.dir, env: f.env, encoding: 'utf8' });
  assert.equal(scan.status, 0, scan.stderr);
  assert.match(scan.stdout, /\bhits=0\b/);
  for (const dataset of ['jd', 'douyin', 'tmall', 'runs', 'samples']) {
    const filename = path.join('out', dataset + '.json');
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(f.dir, filename))), JSON.parse(fs.readFileSync(path.join(base.dir, filename))));
  }
  const oldCount = base.recs.length;
  assert.equal(f.recs.length, oldCount + 1);
  const ui = f.html.split('<script')[0];
  for (const r of v2.rows) {
    const slug = r.id === 'J-C01' ? 'jc01' : r.id.toLowerCase();
    assert.equal(ui.split('id="' + slug + '"').length - 1, 1);
    assert.equal(ui.split('data-v2-code="' + r.id + '"').length - 1, 1);
    assert.equal(ui.includes('data-v2-point="' + r.id + '"'), !r.skipped);
  }
  assert.match(ui, /data-v2-round="skipped">6</);
  assert.match(ui, /data-v2-round="unknown">10</);
  assert.match(ui, /data-v2-round="assessedValid">0</);
  assert.match(ui, /本轮无有效样本/);
  assert.match(ui, /店铺页未发现候选场次/);
  assert.match(ui, /未配置正控/);
  assert.match(ui, /最近完成的 V2 采集任务[\s\S]{0,140}失败/);
  assert.match(ui, /19:58:57/);
  assert.match(ui, /19:59:03/);
  assert.match(f.html, /name="viewport"/);
  assert.match(f.html, /id="v2-filter"/);
  new vm.Script(f.html.match(/<script>\n([\s\S]*?)<\/script>/)[1]);
  const candidate = f.recs.find(r => r.id === 'jc01');
  for (const key of ['minutes', 'dayRate', 'prevRate']) assert.ok(candidate[key] === null || candidate[key] === '', key + ' must be empty');
  assert.equal(candidate.v2.id, 'J-C01');
  assert.equal(f.recs.find(r => r.id === 't1').status, base.recs.find(r => r.id === 't1').status);
  assert.match(base.html, /暂无可核验的 V2 证据/);
});

test('recursive privacy gate rejects hidden identifiers and diagnostics without echoing the contents', t => {
  const f = fixture(t, [row('101')]);
  const evidenceDir = path.join(f.dir, 'private-round'), staged = path.join(f.dir, 'stage');
  const nested = path.join(staged, 'nested');
  fs.mkdirSync(evidenceDir);
  fs.mkdirSync(nested, { recursive: true });
  const { evidence } = tenTargetRound();
  for (const [name, data] of [['monitor_snapshot', evidence.snapshot], ['resolved_rooms', evidence.resolved], ['run_summary', evidence.summary], ['control_live_result', evidence.control]]) {
    fs.writeFileSync(path.join(evidenceDir, name + '.json'), JSON.stringify(data));
  }
  const scan = () => spawnSync(process.execPath, [path.join(ROOT, 'dash/leakcheck.mjs'), 'stage'], {
    cwd: f.dir, env: { ...f.env, V2_PRIVATE_DIR: evidenceDir }, encoding: 'utf8'
  });
  const secret = evidence.snapshot.rooms[0].target_key;
  const secretNumber = new URL(evidence.snapshot.rooms[0].room_url).searchParams.get('userId');
  const approvedName = JSON.parse(fs.readFileSync(path.join(ROOT, 'dash/private/names.json'))).names.T1.name;
  fs.copyFileSync(path.join(f.dir, 'universal/index.html'), path.join(staged, 'index.html'));
  const clean = scan();
  assert.equal(clean.status, 0, clean.stdout + clean.stderr);
  const privateCases = [
    ['page.html', '<i data-hint="' + secret + '"></i>'],
    ['escaped.html', '<i title="' + secret.replace('-', '&#45;') + '"></i>'],
    ['embedded.html', '<script type="application/json">{"note":"' + secret.replace('-', '\\u002d') + '"}</script>'],
    ['out.json', JSON.stringify({ note: secretNumber })],
    ['export.tsv', '测试列\n' + approvedName],
    ['copy.html', '<a href="https://example.invalid/r?token=fixture-token">查看</a>'],
    ['debug.json', '{"diagnostics":{}}'],
    ['monitor_snapshot.json', '{}'],
    ['thumb.jpg', Buffer.from([0xff, 0xd8, 0xff])],
    ['state.zip', Buffer.from('synthetic')]
  ];
  for (const [name, payload] of privateCases) {
    fs.writeFileSync(path.join(nested, name), payload);
    const failure = scan();
    assert.equal(failure.status, 2, 'accepted ' + name);
    for (const value of [secret, secretNumber, approvedName, 'fixture-token', path.join(nested, name)]) {
      assert.ok(!(failure.stdout + failure.stderr).includes(value), 'diagnostic contained raw input');
    }
    fs.unlinkSync(path.join(nested, name));
  }
});

// Execute the shipped script against a simulated DOM and clock in Node VM.
// This checks behavior of the actual rendered script, not Chromium or pixels.
function openPage(html, initialTime) {
  let clock = Date.parse(initialTime), clipboard, nextTimer = 1;
  const ids = new Map(), cards = [], counts = [], labels = [], references = [], timers = new Map();
  const attrName = name => name.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
  function element(attrs) {
    const events = new Map();
    return {
      id: attrs.id, value: attrs.id === 'v2-filter' ? 'all' : '', dataset: Object.fromEntries(
        Object.entries(attrs).filter(([name]) => name.startsWith('data-')).map(([name, value]) => [attrName(name), value])),
      getAttribute: name => attrs[name], hasAttribute: name => Object.hasOwn(attrs, name),
      setAttribute(name, value) { attrs[name] = value; if (name.startsWith('data-')) this.dataset[attrName(name)] = value; },
      toggleAttribute(name, present) { if (present) this.setAttribute(name, ''); else delete attrs[name]; },
      addEventListener: (event, cb) => events.set(event, cb), emit: event => events.get(event)?.()
    };
  }
  const markup = html.split('<script')[0];
  for (const tag of markup.matchAll(/<(?:details|select|input|button|textarea|p|div|span|b)\b([^>]+)>/g)) {
    const attrs = Object.fromEntries([...tag[1].matchAll(/\s+([\w:-]+)(?:="([^"]*)")?/g)].map(m => [m[1], m[2] || '']));
    const node = element(attrs);
    if (node.id) ids.set(node.id, node);
    if (attrs.class === 'st') cards.push(node);
    if (Object.hasOwn(attrs, 'data-v2-count')) counts.push(node);
    if (Object.hasOwn(attrs, 'data-v2-label')) labels.push(node);
    if (Object.hasOwn(attrs, 'data-v2-reference')) references.push(node);
  }
  for (const [, id, content] of html.matchAll(/<script type="application\/json" id="([^"]+)">([\s\S]*?)<\/script>/g)) {
    ids.set(id, { textContent: content });
  }
  class Clock extends Date { static now() { return clock; } }
  const document = {
    documentElement: { classList: { add() {} } }, addEventListener() {},
    getElementById: id => ids.get(id), querySelector: selector => ids.get(selector.slice(1)),
    querySelectorAll: selector => selector === '.st' ? cards : selector === '[data-v2-count]' ? counts :
      selector === '[data-v2-label]' ? labels : selector === '[data-v2-reference]' ? references : []
  };
  function schedule(fn, delay, repeat = false) {
    const id = nextTimer++;
    timers.set(id, { fn, due: clock + delay, period: repeat ? delay : 0 });
    return id;
  }
  function advanceClock(milliseconds) {
    const until = clock + milliseconds;
    let executions = 0;
    for (;;) {
      const next = [...timers].filter(([, timer]) => timer.due <= until).sort((a, b) => a[1].due - b[1].due || a[0] - b[0])[0];
      if (!next) break;
      assert.ok(++executions < 10000, 'timer simulation did not settle');
      const [id, timer] = next;
      clock = timer.due;
      if (timer.period) timer.due += timer.period;
      else timers.delete(id);
      timer.fn();
    }
    clock = until;
  }
  vm.runInNewContext(html.match(/<script>\n([\s\S]*?)<\/script>/)[1], {
    Date: Clock, document, setInterval: (fn, delay) => schedule(fn, delay, true),
    setTimeout: (fn, delay) => schedule(fn, delay), clearTimeout: id => timers.delete(id),
    navigator: { clipboard: { writeText(value) { clipboard = value; return Promise.resolve(); } } }
  });
  return {
    filter(value) { const filter = ids.get('v2-filter'); filter.value = value; filter.emit('change'); },
    text() { ids.get('cp').emit('click'); return clipboard; },
    table() {
      ids.get('cpx').emit('click');
      const [head, ...lines] = clipboard.split('\n').map(line => line.split('\t'));
      return lines.map(cells => Object.fromEntries(head.map((key, index) => [key, cells[index]])));
    },
    advance(minutes) { advanceClock(minutes * 60e3); },
    advanceMs(milliseconds) { advanceClock(milliseconds); },
    visibleIds() { return cards.filter(node => !node.hidden).map(node => node.id); },
    reference(id) { return references.find(node => node.getAttribute('data-v2-reference') === id); },
    label(id) { return labels.find(node => node.getAttribute('data-v2-label') === id)?.textContent; },
    count(name) { return counts.find(node => node.getAttribute('data-v2-count') === name)?.textContent; }
  };
}

// A prior immutable synthetic round with the same enrollment. Only timestamps
// and source provenance move; no real historical/live endpoint is consulted.
function priorLiveRound(minutesBeforeCurrent, ids = ['T1', 'T2']) {
  const previous = tenTargetRound(2);
  previous.source.runId = '970001';
  previous.evidence.snapshot.run_id = previous.evidence.resolved.run_id = '970001.2';
  previous.evidence.summary.run_id = '970001';
  for (const id of ids) {
    const index = Number(id.slice(1)) - 1;
    result(previous, index, 'OK', 'live', { identity_verified: true }).live_id = String(87000000000001 + index);
  }
  const shift = value => {
    if (typeof value === 'string' && /^2026-11-16T\d\d:\d\d:\d\dZ$/.test(value)) {
      return new Date(Date.parse(value) - minutesBeforeCurrent * 60000).toISOString();
    }
    if (Array.isArray(value)) return value.map(shift);
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, shift(item)]));
    return value;
  };
  previous.evidence = shift(previous.evidence);
  return previous;
}

test('rendered recent-reference filter, copy and TSV expire automatically in the Node VM without promoting UNKNOWN', t => {
  const round = tenTargetRound();
  // Current T1 observation is 11:59; previous LIVE is 09:01. At the page's
  // 12:00 opening time it has one minute left, expiring at 12:01:00.001.
  const previous = priorLiveRound(178);
  const f = fixture(t, [row('101')], { round, history: [previous], allTmall: true });
  const projected = JSON.parse(fs.readFileSync(path.join(f.dir, 'out/v2.json')));
  assert.equal(projected.historyStatus, 'complete');
  assert.equal(projected.counts.live, 0);
  assert.equal(projected.counts.unknown, 10);
  assert.match(f.html, /data-v2-count="recentLive">2</);
  assert.match(f.html, /data-v2-reference="T1"/);
  const page = openPage(f.html, NOW);
  page.filter('recent');
  assert.deepEqual(page.visibleIds(), ['t1', 't2']);
  assert.equal(page.count('recentLive'), '2');
  assert.equal(page.count('unknown'), '10');
  assert.equal(page.count('live'), '0');
  assert.match(page.label('T1'), /无法判断/);
  assert.match(page.label('T2'), /跳过，状态未知/);
  assert.match(page.reference('T1').textContent, /最近确认在播.*本轮未确认.*17:01:00/);
  assert.equal(page.reference('T1').hidden, false);
  const initial = page.table();
  assert.deepEqual(initial.map(item => item['V2 编号']), ['T1', 'T2']);
  for (const item of initial) {
    assert.equal(item['V2 当前状态'], '无法判断');
    assert.equal(item['V2 有效观测'], '');
    assert.equal(item['V2 历史在播确认时间'], '2026-11-16 17:01:00');
    assert.equal(item['V2 历史来源批次'], '970001.2');
    assert.match(item['V2 历史参考状态'], /历史参考.*本轮未确认/);
  }
  assert.match(page.text(), /历史参考.*不代表当前在播/);
  page.advanceMs(60000);
  assert.equal(page.count('recentLive'), '2', '180 minutes exactly is still eligible');
  assert.deepEqual(page.visibleIds(), ['t1', 't2']);
  page.advanceMs(1);
  // Check before copying or selecting another filter: only the shipped expiry
  // timer could have refreshed these DOM fields and the active filter.
  assert.equal(page.count('recentLive'), '0');
  assert.equal(page.count('unknown'), '10');
  assert.equal(page.count('live'), '0');
  assert.deepEqual(page.visibleIds(), []);
  assert.match(page.reference('T1').textContent, /已过期/);
  assert.deepEqual(page.table(), []);
  page.filter('unknown');
  assert.equal(page.visibleIds().length, 10);
  const expired = page.table().filter(item => ['T1', 'T2'].includes(item['V2 编号']));
  assert.equal(expired.length, 2);
  assert.ok(expired.every(item => /已过期/.test(item['V2 历史参考状态']) && item['V2 当前状态'] === '无法判断'));
  assert.match(page.text(), /历史在播记录已过期/);
});

test('privacy scan detects a historical-only live identifier without exposing the matched number', t => {
  const round = tenTargetRound(), previous = priorLiveRound(178, ['T1']);
  const privateNumber = previous.evidence.snapshot.rooms[0].live_id;
  assert.ok(!JSON.stringify(round).includes(privateNumber), 'probe must exist only in history');
  const f = fixture(t, [row('101')], { round, history: [previous], allTmall: true });
  const stage = path.join(f.dir, 'history-leak-probe');
  fs.mkdirSync(stage);
  const scan = () => spawnSync(process.execPath, [path.join(f.scripts, 'leakcheck.mjs'), 'history-leak-probe'], {
    cwd: f.dir, env: f.env, encoding: 'utf8'
  });
  fs.writeFileSync(path.join(stage, 'clean.json'), JSON.stringify({ publicId: 'T1', note: '历史参考' }));
  assert.equal(scan().status, 0);
  // Neutral field and filename ensure the failure comes from reading private
  // historical values, rather than the general field-name/URL patterns.
  fs.writeFileSync(path.join(stage, 'probe.json'), JSON.stringify({ note: privateNumber }));
  const failure = scan();
  assert.equal(failure.status, 2);
  assert.match(failure.stderr, /LEAK private_value/);
  assert.ok(!(failure.stdout + failure.stderr).includes(privateNumber));
  assert.ok(!(failure.stdout + failure.stderr).includes(path.join(stage, 'probe.json')));
});

test('V2 browser filters, text copy and TSV use the same timestamped state after expiry', t => {
  const round = tenTargetRound();
  result(round, 0, 'OK', 'live', { identity_verified: true }).live_id = '86000001';
  const f = fixture(t, [row('101')], { round, allTmall: true });
  const browser = openPage(f.html, NOW);
  browser.filter('live');
  const [initial] = browser.table();
  assert.equal(initial['V2 编号'], 'T1');
  assert.equal(initial['V2 当前状态'], '采样时在播');
  assert.equal(initial['V2 有效观测'], '2026-11-16 19:59:00');
  assert.equal(browser.count('live'), '1');
  browser.filter('skipped');
  const skipped = browser.table();
  assert.deepEqual(skipped.map(r => r['V2 编号']), ['T2', 'T3', 'T5', 'T6', 'T8', 'T9']);
  assert.ok(skipped.every(r => r['V2 调度登记'] && !r['V2 有效观测'] && !r['V2 采样尝试']));
  assert.match(browser.text(), /跳过，状态未知/);
  browser.filter('covered');
  const candidate = browser.table().find(r => r['V2 编号'] === 'J-C01');
  assert.equal(candidate['当天累计分钟'], '');
  assert.equal(candidate['当天满播率'], '');
  browser.filter('live');
  browser.advance(181);
  assert.deepEqual(browser.table(), []);
  assert.equal(browser.count('live'), '0');
  browser.filter('historical');
  const expired = browser.table();
  assert.equal(expired.length, 10);
  const t1 = expired.find(r => r['V2 编号'] === 'T1');
  assert.equal(t1['V2 本轮记录'], initial['V2 本轮记录']);
  assert.equal(t1['V2 当前状态'], '无法判断');
  assert.equal(t1['V2 有效观测'], initial['V2 有效观测']);
  assert.match(browser.text(), /历史记录 · 采样时在播/);
});

test('delivery, archiving, state advance and canary health do not promote any store', () => {
  const round = tenTargetRound(), base = project(round);
  const checks = [
    [{ kind: 'bark', status: 'sent' }, 'sent', 'synced', 'synced'],
    [{ kind: 'bark', status: 'no_changes' }, 'no_changes', 'error', 'failed'],
    [{ kind: 'bark', status: 'transport_error' }, 'failed', 'unrecognized', 'unknown'],
    [{ status: 'sent' }, 'unknown', null, 'unknown'],
    [{ kind: 'other', status: 'sent' }, 'not_bark', null, 'unknown']
  ];
  for (const [notification, delivery, drive, archive] of checks) {
    round.evidence.summary.notification = notification;
    round.evidence.summary.state_snapshot_advanced = false;
    round.evidence.drive = { status: drive, report_file_id: 'synthetic-sensitive-drive-id' };
    const model = project(round);
    assert.equal(model.source.notification, delivery);
    assert.equal(model.source.archive, archive);
    assert.equal(model.source.stateAdvanced, false);
    assert.deepEqual(model.rows, base.rows);
    assert.deepEqual(model.counts, base.counts);
    assert.ok(!JSON.stringify(model).includes(round.evidence.drive.report_file_id));
  }
  const { snapshot, summary, control } = round.evidence, target = snapshot.rooms[0];
  Object.assign(snapshot.canary, { target_key: target.target_key, passed: false, code: target.code, live_status: target.live_status });
  Object.assign(control, { target_key: target.target_key, status: 'not_run_room_unresolved', code: target.code });
  summary.verdict = 'canary_failed';
  assert.equal(project(round).source.control, 'unresolved');
  assert.deepEqual(project(round).counts, base.counts);
  result(round, 0, 'OK', 'live', { identity_verified: true }).live_id = '86000001';
  Object.assign(snapshot.canary, { passed: true, code: 'OK', live_status: 'live' });
  Object.assign(control, { status: 'observed', positive_live_control: true, room_id: target.live_id,
    code: 'OK', live_status: 'live', page_loaded: true, login_or_captcha_blocked: false, room_id_matched: true });
  Object.assign(summary, { positive_live_control: true, verdict: 'canary_passed' });
  const passed = project(round);
  assert.equal(passed.source.control, 'passed');
  assert.equal(passed.counts.live, 1);
  assert.deepEqual(passed.rows.slice(1), base.rows.slice(1));
});

test('an invalid or out-of-round per-store clock never inherits the source or build time', () => {
  for (const stamp of ['2026-02-31T11:59:00Z', fixtureTimes.end, '2026-11-15T11:59:00Z']) {
    const round = tenTargetRound();
    const room = result(round, 0, 'OK', 'live', { identity_verified: true });
    Object.assign(room, { live_id: '86000001', observed_at: stamp });
    const model = project(round);
    assert.equal(model.rows[0].status, 'unknown');
    assert.equal(model.rows[0].reason, 'time');
    for (const k of ['verifiedAt', 'attemptedAt', 'recordedAt']) assert.equal(model.rows[0][k], null);
    assert.equal(model.counts.assessedValid, 0);
  }
});

test('missing evidence keeps recent run health and an invalid private handoff writes no build', t => {
  const f = fixture(t, [row('101')]);
  const privateDir = path.join(f.dir, 'round');
  fs.mkdirSync(privateDir);
  f.env.V2_PRIVATE_DIR = privateDir;
  const latest = { runId: '970004', attempt: 3, at: NOW, conclusion: 'failure' };
  fs.writeFileSync(path.join(privateDir, 'latest.json'), JSON.stringify(latest));
  assert.equal(f.run('build.mjs').status, 0);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(f.dir, 'out/v2.json'))), { source: null, rows: [], counts: null, latest });
  fs.rmSync(path.join(f.dir, 'out'), { recursive: true });
  fs.writeFileSync(path.join(privateDir, 'source.json'), JSON.stringify(tenTargetRound().source));
  assert.notEqual(f.run('build.mjs').status, 0);
  assert.ok(!fs.existsSync(path.join(f.dir, 'out/v2.json')));
  assert.ok(!fs.existsSync(path.join(f.dir, 'out/jd.json')));
});

test('reordering the legacy registry preserves daily and timeline labels, and a replaced identity fails closed', t => {
  const f = fixture(t, [row('101')], { tmallStopped: true, explicitNotRun: true });
  const filename = path.join(f.env.MAIN_DIR, 'main-probe-targets.json');
  const config = JSON.parse(fs.readFileSync(filename));
  const dailyRows = () => JSON.parse(fs.readFileSync(path.join(f.dir, 'out/tmall.json'))).rows;
  const baseline = dailyRows();
  assert.equal(baseline.find(r => r.shop === 'T1').now, '无法判断');
  assert.equal(baseline.find(r => r.shop === 'T2').now, '—');
  config.tmall.reverse();
  fs.writeFileSync(filename, JSON.stringify(config));
  for (const name of ['build.mjs', 'samples.mjs']) {
    const checked = f.run(name);
    assert.equal(checked.status, 0, checked.stderr);
  }
  assert.deepEqual(dailyRows(), baseline);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(f.dir, 'out/samples.json'))), f.samples);
  for (const altered of [
    [{ ...config.tmall[0], accountId: '8999999999' }, config.tmall[1]],
    [{ ...config.tmall[0], key: 'unregistered-replacement' }, config.tmall[1]],
    [config.tmall[0], config.tmall[0]]
  ]) {
    fs.writeFileSync(filename, JSON.stringify({ ...config, tmall: altered }));
    for (const name of ['build.mjs', 'samples.mjs']) {
      const rejected = f.run(name);
      assert.notEqual(rejected.status, 0, 'accepted substituted legacy identity');
      assert.ok(!rejected.stderr.includes('8999999999'));
      assert.ok(!rejected.stderr.includes('unregistered-replacement'));
    }
  }
});
