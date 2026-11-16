// Synthetic log fixtures only. Never contact collectors or publish pages.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import vm from 'node:vm';
import { assessFreshness } from '../dash/freshness.mjs';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const DAY = '2026-11-16', PREV = '2026-11-15';
const row = (roomId, date = DAY, extra = {}) => ({ roomId, date, category: '测试品类', method: 'FROM_0800_SNAPSHOT', ratePercent: 50,
  totalDayMinutes: 480, soFarMinutes: 60, liveByWindowStart: true, reachedWindowEnd: false, lastMinuteBeijing: '20:00', ...extra });
const line = (tag, value, at) => `job\tstep\t${at} ${tag} ${JSON.stringify(value)}`;

function fixture(t, rows, options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'results-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const config = path.join(dir, 'config');
  fs.mkdirSync(config);
  const targets = { 'r316-douyin-rpa-targets.json': [{ key: 'synthetic_dy_primary' }],
    'r326-douyin-targets-scoring-b.json': [], 'r329-douyin-targets-monitor-c.json': [], 'r329-douyin-targets-monitor-d.json': [] };
  for (const [name, items] of Object.entries(targets)) fs.writeFileSync(path.join(config, 'main-' + name), JSON.stringify({ targets: items }));
  fs.writeFileSync(path.join(config, 'main-probe-targets.json'), JSON.stringify({ douyin: [{ key: 'synthetic_dy_primary' }], tmall: [{ key: 'synthetic_tm_primary' }] }));
  const freshAt = new Date(Date.now() - 60000).toISOString();
  const oldAt = new Date(Date.now() - 6 * 3600e3).toISOString();
  const dyAt = options.staleDouyin ? oldAt : freshAt;
  const daily = key => ({ key, date: DAY, samples: 1, verifiedSamples: 1, status: 'BROADCAST_SEEN', firstSeenAt: freshAt, lastSeenAt: freshAt });
  fs.writeFileSync(path.join(dir, 'jd.log'), rows.map(r => line('R327_JD_DAY', r, freshAt)).concat(line('R327_JD_FULLDAY', { rooms: 2, dailyOk: 2 }, freshAt)).join('\n'));
  fs.writeFileSync(path.join(dir, 'dy.log'), [line('R316_RPA', { key: 'synthetic_dy_primary', at: dyAt, profileHttp: 200, profileIdentityVerified: true, state: 'LIVE' }, dyAt), line('R325_DAILY', daily('synthetic_dy_primary'), dyAt)].join('\n'));
  fs.writeFileSync(path.join(dir, 'tm.log'), [line('R329_TMALL', { key: 'synthetic_tm_primary', http: 200, identityVerified: true, state: 'LIVE' }, freshAt), line('R325_DAILY', daily('synthetic_tm_primary'), freshAt)].join('\n'));
  if (options.emptyDouyin) fs.writeFileSync(path.join(dir,'dy.log'),'');
  const env = { ...process.env, MAIN_DIR: config, RUN_JD: '101', RUN_DY: '102', RUN_TM: '103' };
  const run = file => spawnSync(process.execPath, [path.join(ROOT, 'dash', file)], { cwd: dir, env, encoding: 'utf8' });
  const build = run('build.mjs');
  if (options.expectBuildFailure) return { build, dir };
  assert.equal(build.status, 0, build.stderr);
  const data = JSON.parse(fs.readFileSync(path.join(dir, 'out/jd.json'))).rows;
  fs.writeFileSync(path.join(dir, 'out/samples.json'), JSON.stringify({ ok: { douyin: false, tmall: false }, rows: [] }));
  const render = run('render.mjs');
  assert.equal(render.status, 0, render.stderr);
  const html = fs.readFileSync(path.join(dir, 'universal/index.html'), 'utf8');
  const recs = JSON.parse(html.match(/<script type="application\/json" id="rec">([\s\S]*?)<\/script>/)[1]).rows;
  return { data, html, recs, dir, env, dyAt, freshAt };
}

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
  assert.match(old.text, /数据截至/);
});

test('freshness treats absent/invalid/future timestamps as unknown, never a zero age', () => {
  const now = Date.parse('2026-11-16T12:00:00Z');
  for (const at of [null, '', 'invalid', '2026-11-17T12:00:00Z']) assert.equal(assessFreshness(at, now).state, 'UNKNOWN');
  assert.equal(assessFreshness('2026-11-16T09:00:00Z', now).state, 'CURRENT');
  assert.equal(assessFreshness('2026-11-16T08:59:59Z', now).state, 'STALE');
});

test('page updates stale ages after time passes without changing recorded broadcast states', t => {
  const f = fixture(t, [row('101'), row('101', PREV)]);
  const source = f.html.match(/<script>\n([\s\S]*?)<\/script>/)[1];
  new vm.Script(source); // Validate the complete emitted browser script, including table exports.
  const attributes = { 'data-source-time': f.freshAt }, node = { textContent: '', getAttribute: n => attributes[n], setAttribute: (n,v) => { attributes[n]=v; } };
  let timer;
  let now = Date.parse(f.freshAt) + 60000;
  class Clock extends Date { static now() { return now; } }
  const browser = { Date: Clock, document: { querySelectorAll: () => [node], addEventListener() {} }, setInterval(fn) { timer=fn; } };
  vm.runInNewContext(source.split('\n{\n  const doc')[0], browser);
  assert.equal(attributes['data-age-state'], 'CURRENT');
  now += 4 * 3600e3;
  timer();
  assert.equal(attributes['data-age-state'], 'STALE');
  assert.match(node.textContent, /需核对/);
});

test('rendered datasets and page pass the existing identifier leak gate', t => {
  const f = fixture(t, [row('101'), row('101', PREV)]);
  const files = fs.readdirSync(path.join(f.dir,'out')).map(n => path.join('out',n));
  const checked = spawnSync(process.execPath, [path.join(ROOT,'dash/leakcheck.mjs'), ...files, 'universal/index.html'], { cwd:f.dir, env:f.env, encoding:'utf8' });
  assert.equal(checked.status, 0, checked.stdout + checked.stderr);
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
