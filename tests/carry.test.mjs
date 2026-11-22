// Display-only carry-over of an earlier verified live sample. Synthetic rounds only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createV2Projector, carryForward, CARRY_WINDOW_MS } from '../dash/v2.mjs';
import { v2Counts, v2Detail, v2Export, v2Rows, v2State, v2CardAttributes, v2Overview } from '../dash/v2-view.mjs';
import { tenTargetRound, result } from './fixtures/v2.mjs';

const project = round => createV2Projector(round.registry)(round.evidence, round.source);
const minutes = n => n * 60000;

// The fixture's newest round: T1 and T4 hit a challenge, T2 and T3 were paused with their group.
const newest = () => project(tenTargetRound());
const START = Date.parse(newest().source.startedAt);

// An earlier round shifted back in time. Only its public projection is used by carryForward.
function earlier(minutesBefore, change = round => result(round, 0, 'OK', 'live', { identity_verified: true }).live_id = '86000001') {
  const round = tenTargetRound();
  change(round);
  const model = project(round);
  const shift = iso => iso && new Date(Date.parse(iso) - minutes(minutesBefore)).toISOString();
  return {
    ...model,
    source: { ...model.source, runId: String(960000 + minutesBefore), startedAt: shift(model.source.startedAt), completedAt: shift(model.source.completedAt) },
    rows: model.rows.map(row => ({ ...row, recordedAt: shift(row.recordedAt), attemptedAt: shift(row.attemptedAt), verifiedAt: shift(row.verifiedAt) })),
  };
}

test('a challenged store keeps the newest earlier verified live sample within 180 minutes', () => {
  const current = newest();
  const before = earlier(60);
  const now = START + minutes(5);
  const carried = carryForward(current, [before], now);
  const t1 = carried.rows[0];
  assert.equal(t1.status, 'unknown');
  assert.equal(t1.reason, 'challenge');
  assert.deepEqual(t1.carried, { verifiedAt: before.rows[0].verifiedAt, runId: before.source.runId, attempt: 1 });
  assert.deepEqual(carried.counts, current.counts, 'the round record itself never changes');
  assert.ok(carried.rows.slice(1).every(row => !('carried' in row)));

  const [row] = v2Rows({ source: carried.source, rows: carried.rows }).slice(0, 1);
  const state = v2State(row, now);
  assert.equal(state.current, 'live');
  assert.equal(state.carried, true);
  assert.match(state.label, /^沿用 \d\d:\d\d 有效样本 · 采样时在播（最新一轮：人机验证）$/);
  assert.match(v2CardAttributes(row, now), /data-v2-result="live".*data-v2-carried/);
  assert.match(v2Detail(row, now), /沿用 .*运行 960060.*不计入考核样本/);
  assert.match(v2Export(row, now).text, /沿用 /);
  const counts = v2Counts(v2Rows({ source: carried.source, rows: carried.rows }), now);
  assert.equal(counts.live, 1);
  assert.equal(counts.carried, 1);
  assert.equal(counts.assessedValid, 0, 'a carried sample is not a new assessed sample');
  assert.match(v2Overview(carried.source, null, carried.counts, counts), /其中沿用 <b data-v2-count="carried">1<\/b>/);
});

test('the carried sample expires 180 minutes after it was verified', () => {
  const before = earlier(60);
  const verified = Date.parse(before.rows[0].verifiedAt);
  const carried = carryForward(newest(), [before], START);
  const [row] = v2Rows({ source: carried.source, rows: carried.rows });
  assert.equal(v2State(row, verified + CARRY_WINDOW_MS).current, 'live');
  const expired = v2State(row, verified + CARRY_WINDOW_MS + 1);
  assert.equal(expired.carried, false);
  assert.equal(expired.current, 'unknown');
  assert.equal(carryForward(newest(), [earlier(181)], START + minutes(1)).rows[0].carried, undefined);
});

test('an earlier blocked round is skipped, but a settled one ends the search', () => {
  const challenged = earlier(30, () => {});
  const live = earlier(90);
  assert.equal(carryForward(newest(), [live, challenged], START).rows[0].carried.runId, live.source.runId);
  const offline = earlier(30, round => result(round, 0, 'OFFLINE', 'offline',
    { identity_verified: true, offline_evidence: true, offline_rule_validated: true }));
  assert.equal(carryForward(newest(), [offline, live], START).rows[0].carried, undefined);
  const redirected = earlier(30, round => result(round, 0, 'REDIRECTED'));
  assert.equal(carryForward(newest(), [redirected, live], START).rows[0].carried, undefined);
  const unverified = earlier(30, round => result(round, 0, 'OK', 'live', { identity_verified: false }).live_id = '86000001');
  assert.equal(carryForward(newest(), [unverified], START).rows[0].carried, undefined);
});

test('only challenge, login and group pause rounds carry, and never from a newer round', () => {
  const live = earlier(60);
  const round = tenTargetRound();
  result(round, 0, 'NAV_TIMEOUT');
  assert.equal(carryForward(project(round), [live], START).rows[0].carried, undefined);
  const login = tenTargetRound();
  result(login, 0, 'LOGIN_REQUIRED');
  assert.ok(carryForward(project(login), [live], START).rows[0].carried);
  assert.ok(carryForward(newest(), [live], START).rows[1].carried === undefined, 'T2 was not live earlier');
  const sameTime = { ...live, source: { ...live.source, completedAt: newest().source.startedAt } };
  assert.equal(carryForward(newest(), [sameTime], START).rows[0].carried, undefined);
});

test('the view rejects a carried sample on a row that cannot carry', () => {
  const carried = carryForward(newest(), [earlier(60)], START);
  const rows = carried.rows.map((row, i) => i === 0 ? { ...row, reason: 'redirect' } : row);
  assert.throws(() => v2Rows({ source: carried.source, rows }), /V2_VIEW_CARRIED/);
  const extra = carried.rows.map((row, i) => i === 0 ? { ...row, carried: { ...row.carried, name: 'x' } } : row);
  assert.throws(() => v2Rows({ source: carried.source, rows: extra }), /V2_VIEW_CARRIED/);
  assert.equal(carryForward({ source: null, rows: [] }, [], START).source, null);
});
