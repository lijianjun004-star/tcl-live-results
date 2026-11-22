// Project the upstream 2.0 handoffs into a finite public model. Never include upstream values in errors.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';

const roster = JSON.parse(fs.readFileSync(new URL('./private/v2-roster.json', import.meta.url), 'utf8'));
const publicIds = ['T1', 'T2', 'T3', 'T4', 'T5', 'T6', 'T7', 'T8', 'T9', 'J-C01'];
const hash = value => createHash('sha256').update(value, 'utf8').digest('hex');
const record = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const integer = v => Number.isSafeInteger(v) && v >= 0;
const bool = v => typeof v === 'boolean';
const oneOf = (...allowed) => value => allowed.includes(value);
const nullable = test => v => v === null || test(v);
const pattern = re => v => typeof v === 'string' && re.test(v);
const boundedText = limit => v => typeof v === 'string' && [...v].length <= limit;
const uniqueArray = test => v => Array.isArray(v) && new Set(v).size === v.length && v.every(test);
const limitedObject = v => record(v) && Object.keys(v).length <= 40;
const digest = pattern(/^[a-f0-9]{64}$/);
const key = pattern(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/);
const time = pattern(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,6})?(?:Z|\+00:00)$/);
const url = pattern(/^https:\/\/(?:lives\.jd\.com\/#\/[1-9]\d{4,17}|h5\.m\.taobao\.com\/taolive\/video\.html\?userId=\d{5,16})$/);
const platform = oneOf('jd', 'tmall', 'taobao');
const group = oneOf(null, 1, 2, 3);
const code = oneOf('OK', 'OFFLINE', 'REDIRECTED', 'LOGIN_REQUIRED', 'CAPTCHA_X5SEC',
  'GROUP_CIRCUIT_OPEN', 'NAV_TIMEOUT', 'POST_AUDIT_BLOCKED', 'SCHEMA_MISMATCH');
const reason = nullable(pattern(/^[a-z0-9_]{1,64}$/));
const liveStatus = oneOf('live', 'offline', 'replay', 'unknown');
const mode = oneOf('direct', 'shop_discover', 'sku_discover', 'anchor_entry', 'short_link');
const source = oneOf('static', 'fresh', 'cache', 'none');
const tally = allowed => v => record(v) && Object.entries(v).every(([k, n]) => allowed(k) && integer(n));

function insist(condition, type = 'CONTRACT') {
  if (!condition) throw new Error('V2_' + type);
}

// All fields in these two frozen schema 2.0 handoffs are required; additional fields are rejected.
// Only diagnostics and audit are intentionally open upstream. They never cross the projection boundary.
const shape = fields => value => record(value) && Object.keys(value).length === Object.keys(fields).length &&
  Object.entries(fields).every(([field, check]) => Object.hasOwn(value, field) && check(value[field]));
const discovery = shape({ code, reason, source, mode });
const snapshotRoom = shape({
  target_key: key, platform, display_name: nullable(boundedText(60)), account_group: group,
  live_id: nullable(pattern(/^[1-9]\d{4,23}$/)), room_url: nullable(url), code, reason,
  live_status: liveStatus, observed_at: time, elapsed_ms: integer, detect_ms: nullable(integer),
  online_count: nullable(integer), item_title: nullable(boundedText(100)),
  item_price: nullable(v => Number.isFinite(v) && v >= 0), keywords_hit: uniqueArray(boundedText(40)),
  thumbnail: nullable(pattern(/^thumbs\/[A-Za-z0-9][A-Za-z0-9_.-]{0,63}\.jpg$/)), discovery, diagnostics: limitedObject,
});
const resolvedRoom = shape({
  target_key: key, platform, account_group: group, discovery_mode: mode, code, reason, source,
  live_id: nullable(pattern(/^[1-9]\d{4,17}$/)), room_url: nullable(url), resolved_at: nullable(time),
  cache_age_seconds: nullable(integer),
  verification: oneOf('config', 'resolved_link', 'candidate_unverified', 'entry_page', 'none'), audit: limitedObject,
});
const snapshotTotals = shape({
  total: integer, live: integer, offline: integer, abnormal: integer, by_code: tally(code), by_platform: tally(platform),
  circuit_open_groups: uniqueArray(pattern(/^[a-z_]+:[a-z0-9_]+$/)), max_detect_ms: nullable(integer), median_detect_ms: nullable(integer),
});
const commonFile = { schema_version: oneOf('2.0'), generated_at: time, run_id: key };
const tenRooms = check => rows => Array.isArray(rows) && rows.length === publicIds.length && rows.every(check);
const snapshotFile = shape({ ...commonFile, rooms: tenRooms(snapshotRoom), summary: snapshotTotals,
  canary: shape({ target_key: nullable(key), passed: nullable(bool), code: nullable(code), live_status: nullable(liveStatus) }) });
const resolvedFile = shape({ ...commonFile, rooms: tenRooms(resolvedRoom) });

function validateConditionalFields(room, found) {
  if (room.code === 'OK') insist(room.live_status === 'live');
  else if (room.code === 'OFFLINE') insist(['offline', 'replay'].includes(room.live_status));
  else insist(room.live_status === 'unknown' && room.thumbnail === null);
  if (found.source === 'none') insist(found.room_url === null && found.live_id === null && found.verification === 'none' && found.code !== 'OK');
  else if (found.source === 'cache') insist(url(found.room_url) && integer(found.cache_age_seconds) && found.code !== 'OK');
  else insist(url(found.room_url) && found.cache_age_seconds === null && found.code === 'OK');
}

// Date.parse normalizes some nonexistent calendar dates. Reject rollover and accept only UTC.
function iso(value) {
  if (!time(value)) return null;
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) return null;
  const normalized = new Date(ms).toISOString();
  return normalized.slice(0, 19) === value.slice(0, 19) ? normalized : null;
}

function totals(rows, field) {
  const counts = {};
  for (const row of rows) counts[row[field]] = (counts[row[field]] || 0) + 1;
  return counts;
}
const equalCounts = (actual, expected) => record(actual) && Object.keys(actual).length === Object.keys(expected).length &&
  Object.entries(expected).every(([k, n]) => Object.hasOwn(actual, k) && actual[k] === n);

function validateSummary(snapshot, summary) {
  const codes = totals(snapshot.rooms, 'code');
  const platforms = totals(snapshot.rooms, 'platform');
  const stats = snapshot.summary;
  const n = snapshot.rooms.length;
  insist(stats.total === n && summary.targets_total === n &&
    equalCounts(stats.by_code, codes) && equalCounts(summary.by_code, codes) &&
    equalCounts(stats.by_platform, platforms) && equalCounts(summary.by_platform, platforms) &&
    stats.live === (codes.OK || 0) && stats.offline === (codes.OFFLINE || 0) &&
    stats.abnormal === n - stats.live - stats.offline, 'TOTALS');
  const times = snapshot.rooms.map(room => room.detect_ms).filter(ms => ms !== null).sort((a, b) => a - b);
  const median = times.length ? Math.floor((times[(times.length - 1) >> 1] + times[times.length >> 1]) / 2) : null;
  insist(stats.max_detect_ms === (times.at(-1) ?? null) && summary.max_detect_ms === stats.max_detect_ms &&
    stats.median_detect_ms === median && summary.median_detect_ms === median, 'TOTALS');
}

function controlStatus(snapshot, summary, control) {
  const c = snapshot.canary;
  insist(record(control) && iso(control.observed_from) && iso(control.observed_until) &&
    iso(control.observed_from) >= iso(summary.started_utc) && iso(control.observed_until) <= iso(summary.completed_utc) &&
    iso(control.observed_from) <= iso(control.observed_until) && control.target_key === c.target_key &&
    bool(control.positive_live_control) && summary.positive_live_control === control.positive_live_control, 'CONTROL');
  if (c.target_key === null) {
    insist(control.status === 'not_run_no_canary' && control.positive_live_control === false &&
      summary.verdict === 'no_canary' && c.passed === null && c.code === null && c.live_status === null &&
      control.room_id === null && control.code === null && control.live_status === 'unknown' &&
      control.page_loaded === null && control.room_id_matched === null && control.login_or_captcha_blocked === null, 'CONTROL');
    return 'not_configured';
  }
  const target = snapshot.rooms.find(r => r.target_key === c.target_key);
  const positive = control.status === 'observed' && control.room_id_matched === true &&
    control.page_loaded === true && control.login_or_captcha_blocked === false && control.live_status === 'live';
  const passed = positive && target?.code === 'OK';
  insist(target && ['observed', 'not_run_room_unresolved'].includes(control.status) && target.code === c.code &&
    control.code === c.code && target.live_status === c.live_status && positive === control.positive_live_control &&
    c.passed === passed && summary.verdict === (passed ? 'canary_passed' : 'canary_failed'), 'CONTROL');
  if (control.status === 'not_run_room_unresolved') return 'unresolved';
  return passed ? 'passed' : 'failed';
}

function deliveryStatus(notification) {
  if (notification?.kind !== 'bark') return notification?.kind ? 'not_bark' : 'unknown';
  if (['sent', 'no_changes'].includes(notification.status)) return notification.status;
  return ['rejected', 'config_error', 'transport_error'].includes(notification.status) ? 'failed' : 'unknown';
}

function archiveStatus(drive) {
  if (drive?.status === 'synced') return 'synced';
  return ['error', 'refused_scope'].includes(drive?.status) ? 'failed' : 'unknown';
}

function selectSource(snapshot, resolved, summary, control, drive, provenance) {
  const runId = String(provenance?.runId);
  const attempt = Number(provenance?.attempt);
  insist(/^[1-9]\d{0,19}$/.test(runId) && Number.isSafeInteger(attempt) && attempt > 0 &&
    String(attempt) === String(provenance.attempt) && pattern(/^[a-f0-9]{40}$/)(provenance.headSha), 'PROVENANCE');
  // Older private source files were written when only manual runs were eligible.
  const event = Object.hasOwn(provenance, 'event') ? provenance.event : 'workflow_dispatch';
  insist(record(summary) && summary.repository === 'lijianjun004-star/tcl-live-monitor' && summary.branch === 'main' &&
    ['workflow_dispatch', 'schedule'].includes(event) && summary.event === event &&
    summary.engine === 'live' && summary.head_sha === provenance.headSha &&
    summary.schema_version === '2.0' && summary.run_id === runId && summary.run_attempt === String(attempt) &&
    snapshot.run_id === runId + '.' + attempt && resolved.run_id === snapshot.run_id &&
    summary.contract_validation?.monitor_snapshot === 'ok' && summary.contract_validation?.resolved_rooms === 'ok' &&
    bool(summary.state_snapshot_advanced), 'PROVENANCE');
  const startedAt = iso(summary.started_utc), completedAt = iso(summary.completed_utc);
  const discoveredAt = iso(resolved.generated_at), capturedAt = iso(snapshot.generated_at);
  insist(startedAt && completedAt && discoveredAt && capturedAt && startedAt <= discoveredAt &&
    discoveredAt <= capturedAt && capturedAt <= completedAt, 'RUN_TIME');
  return { runId, attempt, startedAt, completedAt, control: controlStatus(snapshot, summary, control),
    notification: deliveryStatus(summary.notification), archive: archiveStatus(drive), stateAdvanced: summary.state_snapshot_advanced };
}

function bindRegistry(registry) {
  insist(Array.isArray(registry) && registry.length === publicIds.length, 'ROSTER');
  const byId = new Map(registry.map(r => [r.id, r]));
  insist(new Set(registry.map(r => r.keyHash)).size === publicIds.length &&
    new Set(registry.map(r => r.identityHash)).size === publicIds.length, 'ROSTER');
  return publicIds.map(id => {
    const r = byId.get(id);
    insist(r && [r.keyHash, r.nameHash, r.identityHash].every(digest), 'ROSTER');
    return { ...r, platform: id === 'J-C01' ? 'jd' : 'tmall',
      role: id === 'T1' ? 'assessed' : id === 'J-C01' ? 'candidate' : 'monitor' };
  });
}

function indexRooms(rooms) {
  const result = new Map(rooms.map(r => [hash(r.target_key), r]));
  insist(result.size === publicIds.length, 'ROSTER');
  return result;
}

function validateBinding(entry, room, found) {
  insist(room && found && room.target_key === found.target_key &&
    room.platform === entry.platform && found.platform === entry.platform &&
    typeof room.display_name === 'string' && hash(room.display_name) === entry.nameHash &&
    room.account_group === found.account_group, 'ROSTER');
  validateConditionalFields(room, found);
  const discovery = room.discovery;
  insist(discovery.code === found.code && discovery.reason === found.reason && discovery.source === found.source &&
    discovery.mode === found.discovery_mode && room.room_url === found.room_url, 'DISCOVERY');
  if (entry.platform === 'tmall') {
    insist(found.discovery_mode === 'anchor_entry' && found.source === 'static' && found.verification === 'config' &&
      found.reason === 'anchor_entry' && found.live_id === null && hash(found.room_url) === entry.identityHash, 'ROSTER');
  } else {
    // This roster binds the candidate by key and reviewed name. The official handoff omits the configured shop ID.
    insist(found.discovery_mode === 'shop_discover' && found.account_group === null, 'ROSTER');
    if (found.room_url !== null) insist(found.room_url === 'https://lives.jd.com/#/' + found.live_id && room.live_id === found.live_id, 'DISCOVERY');
    if (found.audit.shop?.shop_id != null) insist(hash(String(found.audit.shop.shop_id)) === entry.identityHash, 'ROSTER');
  }
}

const publicReason = new Map([
  ['LOGIN_REQUIRED', 'login'], ['CAPTCHA_X5SEC', 'challenge'], ['NAV_TIMEOUT', 'timeout'],
  ['REDIRECTED', 'redirect'], ['POST_AUDIT_BLOCKED', 'blocked'],
]);
function classify(room, found) {
  if (room.code !== 'OK' && room.code !== 'OFFLINE') {
    const shop = found.audit.shop;
    const noCandidate = room.platform === 'jd' && room.code === 'SCHEMA_MISMATCH' &&
      room.reason === 'no_live_candidate_in_guest_shop' && found.code === room.code &&
      found.reason === room.reason && found.source === 'none' && shop?.status === 'loaded' &&
      shop.main_http_status === 200 && Array.isArray(found.audit.candidate_ids) && !found.audit.candidate_ids.length;
    const identityMismatch = room.code === 'REDIRECTED' && room.reason === 'identity_mismatch';
    return { status: 'unknown', reason: noCandidate ? 'no_candidate' : identityMismatch ? 'identity' : publicReason.get(room.code) || 'unrecognized' };
  }
  // A discovered JD room still lacks independently reviewed shop-to-room ownership.
  const d = room.diagnostics;
  if (room.platform === 'jd' || d.identity_verified !== true) return { status: 'unknown', reason: 'identity' };
  if (d.network_requests === 0 || d.passive_observation?.navigation_attempted === false) return { status: 'unknown', reason: 'unrecognized' };
  if (room.code === 'OK' && !room.live_id) return { status: 'unknown', reason: 'unrecognized' };
  if (room.code === 'OFFLINE' && d.offline_evidence !== true) return { status: 'unknown', reason: 'unrecognized' };
  if (room.code === 'OFFLINE' && d.offline_rule_validated !== true) return { status: 'unknown', reason: 'uncalibrated' };
  return { status: room.live_status, reason: 'confirmed' };
}

function publicRow(entry, room, found, source, capturedAt) {
  const d = room.diagnostics;
  const monitorVisit = d.passive_observation?.navigation_attempted === true || d.network_requests > 0 ||
    d.network?.allowed > 0 || d.responses > 0 || d.passive_observation?.livedetail_v4?.responses > 0;
  const skipped = room.code === 'GROUP_CIRCUIT_OPEN' && room.reason === 'group_circuit_open' &&
    room.platform === 'tmall' && room.elapsed_ms === 0 && d.network_requests === 0 && !monitorVisit;
  const at = iso(room.observed_at);
  const recordedAt = at && at >= source.startedAt && at <= capturedAt ? at : null;
  let judgement = { status: 'unknown', reason: 'time' };
  if (recordedAt) judgement = skipped ? { status: 'unknown', reason: 'circuit' } : classify(room, found);
  // Discovery can visit the JD shop even when the monitoring handoff records zero requests.
  const shop = found.audit.shop;
  const discovered = room.platform === 'jd' && Number.isInteger(shop?.main_http_status) && shop.main_http_status > 0;
  const attempted = !skipped && (discovered || monitorVisit || (d.network_requests !== 0 && room.elapsed_ms > 0) || judgement.status !== 'unknown');
  return { id: entry.id, platform: entry.platform, role: entry.role, recordedAt,
    attemptedAt: attempted ? recordedAt : null, verifiedAt: judgement.status !== 'unknown' ? recordedAt : null,
    ...judgement, skipped };
}

export function createV2Projector(registry) {
  const entries = bindRegistry(registry);
  return function project({ snapshot, resolved, summary, control, drive }, provenance) {
    insist(snapshotFile(snapshot) && resolvedFile(resolved));
    const source = selectSource(snapshot, resolved, summary, control, drive, provenance);
    validateSummary(snapshot, summary);
    const rooms = indexRooms(snapshot.rooms), discoveries = indexRooms(resolved.rooms);
    const capturedAt = iso(snapshot.generated_at);
    const rows = entries.map(entry => {
      const room = rooms.get(entry.keyHash), found = discoveries.get(entry.keyHash);
      validateBinding(entry, room, found);
      return publicRow(entry, room, found, source, capturedAt);
    });
    const counts = { covered: rows.length, live: 0, offline: 0, replay: 0, unknown: 0, skipped: 0, uncalibrated: 0, assessedValid: 0 };
    for (const row of rows) {
      counts[row.status]++;
      if (row.skipped) counts.skipped++;
      if (row.reason === 'uncalibrated') counts.uncalibrated++;
      if (row.role === 'assessed' && row.verifiedAt) counts.assessedValid++;
    }
    return { source, rows, counts };
  };
}

export const projectV2 = createV2Projector(roster);

// This is a display reference, never a synthetic observation. Both inputs must
// have passed the same roster/provenance projection; raw fields never cross it.
// In particular, do not use a previous row's recentLive to create a new one.
export function attachRecentLive(current, history) {
  insist(Array.isArray(history) && history.length <= 12, 'HISTORY');
  const sources = new Set();
  for (const model of history) {
    const s = model?.source;
    insist(record(s) && /^[1-9]\d{0,19}$/.test(s.runId) && Number.isSafeInteger(s.attempt) && s.attempt > 0 &&
      Array.isArray(model.rows) && model.rows.length === current.rows.length, 'HISTORY');
    const sourceKey = s.runId + '.' + s.attempt;
    insist(!sources.has(sourceKey) && sourceKey !== current.source.runId + '.' + current.source.attempt, 'HISTORY');
    sources.add(sourceKey);
    insist(new Set(model.rows.map(r => r.id)).size === current.rows.length, 'HISTORY');
  }
  const rows = current.rows.map(row => {
    let recentLive = null;
    const latestAt = Date.parse(row.recordedAt);
    if (row.platform !== 'tmall' || row.status !== 'unknown' || !['challenge', 'circuit'].includes(row.reason) ||
        !Number.isFinite(latestAt)) return { ...row, recentLive };
    const observations = [];
    for (const model of history) {
      const prior = model.rows.find(r => r.id === row.id);
      insist(prior && prior.platform === row.platform && prior.role === row.role, 'HISTORY');
      const at = Date.parse(prior.recordedAt);
      // A malformed intermediate clock can conceal a newer OFFLINE. Do not
      // reach across this uncertainty to revive an older LIVE observation.
      if (!Number.isFinite(at)) return { ...row, recentLive };
      // Overlapping/out-of-order observations cannot promote an older source.
      if (at >= latestAt) return { ...row, recentLive };
      if (latestAt - at > 180 * 60000) continue;
      const definitive = ['live', 'offline', 'replay'].includes(prior.status) && prior.reason === 'confirmed' &&
        !prior.skipped && prior.verifiedAt === prior.recordedAt && prior.attemptedAt === prior.recordedAt;
      const conflict = ['identity', 'redirect', 'uncalibrated'].includes(prior.reason);
      if (definitive || conflict) observations.push({ at, prior, source: model.source, conflict });
    }
    observations.sort((a, b) => b.at - a.at || a.source.runId.localeCompare(b.source.runId) || a.source.attempt - b.source.attempt);
    const last = observations[0];
    // A trusted OFFLINE/replay/identity conflict is a barrier, including ties.
    if (last && last.prior.status === 'live' && !last.conflict &&
        observations.filter(o => o.at === last.at).every(o => o.prior.status === 'live' && !o.conflict)) {
      recentLive = { observedAt: last.prior.verifiedAt, runId: last.source.runId, attempt: last.source.attempt };
    }
    return { ...row, recentLive };
  });
  // Counts remain the source's original counts. History has no notification,
  // duration, scoring or current-state side effects.
  return { ...current, rows };
}

function readRound(dir) {
  const read = name => {
    try { return JSON.parse(fs.readFileSync(path.join(dir, name + '.json'), 'utf8')); }
    catch { throw new Error('V2_INPUT'); }
  };
  return projectV2({
    snapshot: read('monitor_snapshot'), resolved: read('resolved_rooms'), summary: read('run_summary'),
    control: read('control_live_result'), drive: fs.existsSync(path.join(dir, 'drive_status.json')) ? read('drive_status') : null,
  }, read('source'));
}

export function readV2(dir) {
  const current = readRound(dir);
  const file = path.join(dir, 'history.json');
  if (!fs.existsSync(file)) return current; // Older reader contract remains valid.
  try {
    const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
    insist(record(manifest) && ['complete', 'unavailable'].includes(manifest.status) &&
      Array.isArray(manifest.entries) && manifest.entries.length <= 12 &&
      new Set(manifest.entries).size === manifest.entries.length &&
      manifest.entries.every(p => typeof p === 'string' && /^history\/[1-9]\d{0,19}-[1-9]\d{0,5}$/.test(p)), 'HISTORY');
    if (manifest.status !== 'complete') return { ...current, historyStatus: 'unavailable' };
    const history = manifest.entries.map(entry => readRound(path.join(dir, entry)));
    return { ...attachRecentLive(current, history), historyStatus: 'complete' };
  } catch {
    // A missing/corrupt historical round may hide an OFFLINE. Do not reach
    // across that gap for older LIVE; the current round is still usable.
    return { ...current, historyStatus: 'unavailable' };
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const projected = readV2(process.argv[2]);
    if (process.argv[3]) fs.writeFileSync(process.argv[3], JSON.stringify(projected));
  } catch (error) {
    console.error(/^V2_[A-Z_]+$/.test(error.message) ? error.message : 'V2_INPUT');
    process.exitCode = 1;
  }
}
