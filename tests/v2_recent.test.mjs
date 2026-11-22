// Independent regression tests: synthetic schema-2.0 evidence only.
// No collector, shop, notification service or production publication is invoked.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createV2Projector, attachRecentLive } from '../dash/v2.mjs';
import { v2State, v2Counts, v2Export, v2Rows } from '../dash/v2-view.mjs';
import { tenTargetRound, fixtureTimes, result } from './fixtures/v2.mjs';

const MINUTE = 60000;
const START = Date.parse('2026-11-23T00:00:00.000Z');
const at = minutes => START + minutes * MINUTE;
const iso = milliseconds => new Date(milliseconds).toISOString();
const row = (model, id = 'T1') => model.rows.find(item => item.id === id);

function shiftTimes(value, delta) {
  if (typeof value === 'string' && /^2026-11-16T\d\d:\d\d:\d\dZ$/.test(value)) {
    return iso(Date.parse(value) + delta);
  }
  if (Array.isArray(value)) return value.map(item => shiftTimes(item, delta));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, shiftTimes(item, delta)]));
  }
  return value;
}

// The requested timestamp is the actual T1 observation time, not completion time.
// Every model enters through the existing strict projector and synthetic roster.
function rawRound(minutes, states = {}, runId = '970003', attempt = 1, change = () => {}) {
  const fixture = tenTargetRound(attempt);
  fixture.source.runId = runId;
  fixture.evidence.snapshot.run_id = runId + '.' + attempt;
  fixture.evidence.resolved.run_id = runId + '.' + attempt;
  fixture.evidence.summary.run_id = runId;
  for (const [id, state] of Object.entries(states)) {
    const index = id === 'J-C01' ? 9 : Number(id.slice(1)) - 1;
    let raw;
    if (state === 'live' || state === 'identity') {
      raw = result(fixture, index, 'OK', 'live', { identity_verified: state === 'live' });
      raw.live_id = String(86000001 + index);
    } else if (['offline', 'replay', 'uncalibrated'].includes(state)) {
      result(fixture, index, 'OFFLINE', state === 'replay' ? 'replay' : 'offline', {
        identity_verified: true, offline_evidence: true, offline_rule_validated: state !== 'uncalibrated'
      });
    } else {
      const code = { challenge: 'CAPTCHA_X5SEC', timeout: 'NAV_TIMEOUT', login: 'LOGIN_REQUIRED',
        redirect: 'REDIRECTED', blocked: 'POST_AUDIT_BLOCKED', unrecognized: 'SCHEMA_MISMATCH' }[state];
      assert.ok(code, 'the fixture must name an explicit, supported synthetic state');
      result(fixture, index, code);
    }
  }
  fixture.evidence = shiftTimes(fixture.evidence, at(minutes) - Date.parse(fixtureTimes.challenge));
  change(fixture);
  return fixture;
}

function round(...args) {
  const fixture = rawRound(...args);
  return createV2Projector(fixture.registry)(fixture.evidence, fixture.source);
}

function expectedSnapshot(model, id = 'T1') {
  return { observedAt: row(model, id).verifiedAt, runId: model.source.runId, attempt: model.source.attempt };
}

test('historical live references attach per shop without changing current observations or round totals', () => {
  const previous = round(0, { T1: 'live', T2: 'live', T4: 'live' }, '970001', 2);
  const current = round(169, {}, '970009');
  const beforeCurrent = structuredClone(current), beforePrevious = structuredClone(previous);
  const merged = attachRecentLive(current, [previous]);

  assert.deepEqual(merged.counts, current.counts);
  assert.deepEqual(merged.source, current.source);
  for (const target of current.rows) {
    const actual = row(merged, target.id);
    const { recentLive, ...observation } = actual;
    assert.deepEqual(observation, target, target.id + ' must retain its actual observation');
    assert.deepEqual(recentLive, ['T1', 'T2', 'T4'].includes(target.id) ? expectedSnapshot(previous, target.id) : null);
  }
  assert.equal(row(merged).status, 'unknown');
  assert.equal(row(merged).verifiedAt, null);
  assert.equal(row(merged, 'T2').skipped, true);
  assert.equal(row(merged, 'T2').attemptedAt, null);
  assert.deepEqual(current, beforeCurrent, 'merge must not mutate current evidence');
  assert.deepEqual(previous, beforePrevious, 'merge must not mutate historical evidence');
});

test('attachment uses the original shop observation and includes exactly 180 minutes, not 180 minutes plus 1 ms', () => {
  const previous = round(0, { T1: 'live' }, '970001');
  for (const [minutes, expected] of [[169, true], [180, true], [180 + 1 / MINUTE, false]]) {
    const merged = attachRecentLive(round(minutes, {}, '970009'), [previous]);
    assert.equal(Boolean(row(merged).recentLive), expected, String(minutes));
  }
  // T2 was registered three seconds after T1 in the fixture. Using the run's
  // start/completion timestamp instead of that shop's timestamp fails this check.
  const skipped = attachRecentLive(round(180, {}, '970009'), [round(0, { T2: 'live' }, '970002')]);
  assert.equal(row(skipped, 'T2').recentLive, null);
});

test('the newest eligible real observation wins regardless of history or row ordering', () => {
  const older = round(0, { T1: 'live' }, '970001', 1);
  const newer = round(60, { T1: 'live' }, '970002', 3);
  const current = round(169, {}, '970009');
  for (const history of [[older, newer], [newer, older]]) {
    const copies = structuredClone(history);
    copies[0].rows.reverse();
    assert.deepEqual(row(attachRecentLive(current, copies)).recentLive, expectedSnapshot(newer));
  }
});

test('only challenge or circuit may expose a recent reference; confirmed and unrelated failures may not', () => {
  const previous = round(0, { T1: 'live' }, '970001');
  for (const state of ['live', 'offline', 'replay', 'identity', 'redirect', 'timeout', 'login', 'blocked', 'uncalibrated', 'unrecognized']) {
    const merged = attachRecentLive(round(60, { T1: state }, '970009'), [previous]);
    assert.equal(row(merged).recentLive, null, state);
  }
});

test('apparent live evidence that failed identity projection cannot seed a recent reference', () => {
  const history = round(0, { T1: 'identity' }, '970001');
  assert.equal(row(history).status, 'unknown');
  assert.equal(row(history).verifiedAt, null);
  assert.equal(row(attachRecentLive(round(60, {}, '970009'), [history])).recentLive, null);
});

test('confirmed offline, replay, identity and redirect events block resurrection of an older live observation', () => {
  const live = round(0, { T1: 'live' }, '970001');
  const current = round(120, {}, '970009');
  for (const state of ['offline', 'replay', 'identity', 'redirect']) {
    const barrier = round(60, { T1: state }, '970002');
    for (const history of [[live, barrier], [barrier, live]]) {
      assert.equal(row(attachRecentLive(current, history)).recentLive, null, state);
    }
  }
});

test('a new verified live observation after a barrier is eligible on its own timestamp and provenance', () => {
  const oldest = round(0, { T1: 'live' }, '970001');
  const barrier = round(60, { T1: 'offline' }, '970002');
  const reopened = round(90, { T1: 'live' }, '970003', 2);
  assert.deepEqual(row(attachRecentLive(round(120, {}, '970009'), [reopened, oldest, barrier])).recentLive,
    expectedSnapshot(reopened));
});

test('conflicting observations at the same timestamp fail closed instead of choosing an input order', () => {
  const oldest = round(0, { T1: 'live' }, '970001');
  const live = round(60, { T1: 'live' }, '970002');
  const current = round(120, {}, '970009');
  for (const state of ['offline', 'replay', 'identity', 'redirect']) {
    const conflict = round(60, { T1: state }, '970003');
    for (const history of [[oldest, live, conflict], [conflict, live, oldest]]) {
      assert.equal(row(attachRecentLive(current, history)).recentLive, null, state);
    }
  }
});

test('duplicate immutable historical sources are rejected without changing the current observation', () => {
  const history = round(0, { T1: 'live' }, '970001', 2);
  const current = round(60, {}, '970009');
  const original = structuredClone(current);
  assert.throws(() => attachRecentLive(current, [history, structuredClone(history)]), /V2_HISTORY/);
  assert.deepEqual(current, original);
});

test('future and equal-time history fails closed instead of exposing an older reference across a chronology conflict', () => {
  const current = round(60, {}, '970009');
  for (const minutes of [60, 61, 240]) {
    assert.equal(row(attachRecentLive(current, [round(minutes, { T1: 'live' }, '970001')])).recentLive, null);
  }
  const older = round(0, { T1: 'live' }, '970002');
  const futureBarrier = round(61, { T1: 'offline' }, '970003');
  assert.equal(row(attachRecentLive(current, [futureBarrier, older])).recentLive, null);
});

test('invalid per-shop sampling time cannot seed or receive a recent reference', () => {
  const invalidate = fixture => {
    fixture.evidence.snapshot.rooms[0].observed_at = '2026-11-22T00:00:00.000Z';
  };
  const badHistorical = round(0, { T1: 'live' }, '970001', 1, invalidate);
  const badCurrent = round(60, {}, '970009', 1, invalidate);
  assert.equal(row(badHistorical).recordedAt, null);
  assert.equal(row(badCurrent).recordedAt, null);
  assert.equal(row(attachRecentLive(round(60, {}, '970009'), [badHistorical])).recentLive, null);
  assert.equal(row(attachRecentLive(badCurrent, [round(0, { T1: 'live' }, '970001')])).recentLive, null);
});

test('an intermediate round with untrusted per-shop time is a gap, not permission to revive older LIVE', () => {
  const older = round(0, { T1: 'live' }, '970001');
  const badIntermediate = round(60, { T1: 'offline' }, '970002', 1, fixture => {
    fixture.evidence.snapshot.rooms[0].observed_at = '2026-11-22T00:00:00.000Z';
  });
  assert.equal(row(badIntermediate).reason, 'time');
  assert.equal(row(badIntermediate).recordedAt, null);
  for (const history of [[older, badIntermediate], [badIntermediate, older]]) {
    assert.equal(row(attachRecentLive(round(120, {}, '970009'), history)).recentLive, null);
  }
});

test('nested display references never renew or replace the original evidence', () => {
  const live = round(0, { T1: 'live' }, '970001');
  const first = attachRecentLive(round(60, {}, '970002'), [live]);
  const second = round(120, {}, '970003');
  assert.ok(row(first).recentLive);
  assert.equal(row(attachRecentLive(second, [first])).recentLive, null, 'unknown history is not a live observation');
  assert.deepEqual(row(attachRecentLive(second, [first, live])).recentLive, expectedSnapshot(live));
  const expired = attachRecentLive(round(181, {}, '970004'), [live, first]);
  assert.equal(row(expired).recentLive, null, 'newer challenge rounds cannot restart the 180-minute clock');
  assert.equal(row(attachRecentLive(first, [])).recentLive, null, 'reattachment must clear unsupported old presentation data');
});

test('opening the page and crossing the TTL expires a reference while current status stays unknown', () => {
  const live = round(0, { T1: 'live' }, '970001');
  const merged = attachRecentLive(round(169, {}, '970009'), [live]);
  const target = row(merged);
  for (const [now, expected] of [[at(169), 'AVAILABLE'], [at(180), 'AVAILABLE'], [at(180) + 1, 'EXPIRED'], [at(360), 'EXPIRED']]) {
    const state = v2State(target, now);
    assert.equal(state.current, 'unknown');
    assert.equal(state.recentState, expected, iso(now));
    assert.ok(typeof state.recentLabel === 'string' && state.recentLabel.length > 0);
  }
  assert.equal(v2State(row(merged, 'T9'), at(169)).recentState, 'NONE');
});

test('future snapshots are never shown as an available reference even inside the normal five-minute skew allowance', () => {
  const live = round(0, { T1: 'live' }, '970001');
  const target = row(attachRecentLive(round(60, {}, '970009'), [live]));
  for (const now of [at(0) - 1, at(0) - 4 * MINUTE]) {
    assert.notEqual(v2State(target, now).recentState, 'AVAILABLE');
  }
});

test('history counters stay separate from current live counts and valid assessment samples', () => {
  const live = round(0, { T1: 'live', T2: 'live' }, '970001');
  const merged = attachRecentLive(round(169, {}, '970009'), [live]);
  const counts = v2Counts(merged.rows, at(169) + 3000);
  assert.equal(counts.recentLive, 2);
  assert.equal(counts.live, 0);
  assert.equal(counts.unknown, 10);
  assert.equal(counts.assessedValid, 0);
  assert.equal(counts.offline, 0);
  assert.equal(counts.replay, 0);
  assert.equal(v2Counts(merged.rows, at(180) + 1).recentLive, 0);
});

test('exports explain the historical nature and preserve the original source attempt and observed time', () => {
  const live = round(0, { T1: 'live' }, '970001', 3);
  const target = row(attachRecentLive(round(169, {}, '970009'), [live]));
  const available = v2Export(target, at(169));
  assert.equal(available.status, '无法判断');
  assert.equal(available.verified, '');
  assert.match(available.recentObserved, /2026-11-23 08:00:00/);
  assert.match(available.recentSource, /970001/);
  assert.match(available.recentSource, /3/);
  assert.ok(available.recentStatus.length > 0);
  assert.match(available.text, /历史参考/);
  assert.match(available.text, /(?:不|未).{0,4}代表当前/);
  const expired = v2Export(target, at(180) + 1);
  assert.equal(expired.status, '无法判断');
  assert.match(expired.recentStatus, /过期|超时|超过/);
  assert.match(expired.text, /过期|超时|超过/);
  const none = v2Export(round(169).rows[0], at(169));
  assert.equal(none.recentObserved, '');
  assert.equal(none.recentSource, '');
});

function writeRawRound(directory, fixture) {
  fs.mkdirSync(directory, { recursive: true });
  const files = { monitor_snapshot: fixture.evidence.snapshot, resolved_rooms: fixture.evidence.resolved,
    run_summary: fixture.evidence.summary, control_live_result: fixture.evidence.control, source: fixture.source };
  for (const [name, data] of Object.entries(files)) fs.writeFileSync(path.join(directory, name + '.json'), JSON.stringify(data));
}

async function isolatedReader(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'v2-history-reader-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const script = path.join(root, 'dash', 'v2.mjs');
  fs.mkdirSync(path.join(root, 'dash', 'private'), { recursive: true });
  fs.copyFileSync(fileURLToPath(new URL('../dash/v2.mjs', import.meta.url)), script);
  const current = rawRound(120, {}, '970009');
  const older = rawRound(0, { T1: 'live' }, '970001');
  fs.writeFileSync(path.join(root, 'dash', 'private', 'v2-roster.json'), JSON.stringify(current.registry));
  const directory = path.join(root, 'evidence');
  writeRawRound(directory, current);
  writeRawRound(path.join(directory, 'history', '970001-1'), older);
  fs.writeFileSync(path.join(directory, 'history.json'), JSON.stringify({ status: 'complete', entries: ['history/970001-1'] }));
  const { readV2 } = await import(pathToFileURL(script).href);
  return { directory, current: round(120, {}, '970009'), older: round(0, { T1: 'live' }, '970001'), readV2 };
}

test('directory reader loads verified history and preserves the current projection', async t => {
  const fixture = await isolatedReader(t);
  const model = fixture.readV2(fixture.directory);
  assert.equal(model.historyStatus, 'complete');
  assert.deepEqual(model.source, fixture.current.source);
  assert.deepEqual(model.counts, fixture.current.counts);
  assert.deepEqual(row(model).recentLive, expectedSnapshot(fixture.older));
  assert.equal(row(model).status, 'unknown');
});

test('unreadable, missing, corrupt or out-of-scope history never suppresses the valid newest projection', async t => {
  const cases = [
    ['broken manifest JSON', directory => fs.writeFileSync(path.join(directory, 'history.json'), '{')],
    ['manifest path escapes history', directory => fs.writeFileSync(path.join(directory, 'history.json'), JSON.stringify({ status: 'complete', entries: ['../outside'] }))],
    ['manifest repeats an artifact', directory => fs.writeFileSync(path.join(directory, 'history.json'), JSON.stringify({ status: 'complete', entries: ['history/970001-1', 'history/970001-1'] }))],
    ['missing historical provenance', directory => fs.rmSync(path.join(directory, 'history', '970001-1', 'source.json'))],
    ['all historical files unavailable', directory => fs.rmSync(path.join(directory, 'history'), { recursive: true })],
    ['corrupt historical snapshot', directory => fs.writeFileSync(path.join(directory, 'history', '970001-1', 'monitor_snapshot.json'), '{}')],
    ['fetcher marks history unavailable', directory => fs.writeFileSync(path.join(directory, 'history.json'), JSON.stringify({ status: 'unavailable', entries: [] }))]
  ];
  for (const [label, breakHistory] of cases) {
    await t.test(label, async child => {
      const fixture = await isolatedReader(child);
      breakHistory(fixture.directory);
      const model = fixture.readV2(fixture.directory);
      assert.equal(model.historyStatus, 'unavailable');
      assert.deepEqual(model.source, fixture.current.source);
      assert.deepEqual(model.counts, fixture.current.counts);
      assert.deepEqual(model.rows, fixture.current.rows);
      assert.equal(v2Counts(model.rows, at(120) + 3000).recentLive, 0);
    });
  }
});

test('public row parsing preserves only the finite, validated reference fields', () => {
  const merged = attachRecentLive(round(60, {}, '970009'), [round(0, { T1: 'live' }, '970001', 2)]);
  const expected = row(merged).recentLive;
  row(merged).recentLive = { ...expected, rawUrl: 'sentinel-private-url', thumbnail: 'sentinel-private-thumbnail' };
  row(merged).diagnostics = { note: 'sentinel-private-note' };
  const parsed = v2Rows(merged);
  assert.deepEqual(parsed.find(item => item.id === 'T1').recentLive, expected);
  assert.ok(!JSON.stringify(parsed).includes('sentinel-private'));
  for (const change of [
    reference => { reference.observedAt = '2026-11-23T00:00:00'; },
    reference => { reference.observedAt = '2026-02-30T00:00:00.000Z'; },
    reference => { reference.runId = '970001/unsafe'; },
    reference => { reference.runId = 970001; },
    reference => { reference.attempt = 0; },
    reference => { reference.attempt = 1.5; }
  ]) {
    const invalid = structuredClone(merged);
    change(row(invalid).recentLive);
    assert.throws(() => v2Rows(invalid), /V2_VIEW_REFERENCE/);
  }
});
