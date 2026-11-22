// Schema-2.0 synthetic ten-target round. Never load the private enrollment or contact a shop.
import { createHash } from 'node:crypto';

const hash = value => createHash('sha256').update(value).digest('hex');
const ts = value => '2026-11-16T' + value + 'Z';
export const fixtureTimes = {
  start: ts('11:58:37'), discovery: ts('11:58:57'), challenge: ts('11:59:00'),
  skip: ts('11:59:03'), end: ts('11:59:04')
};

export function recount(evidence) {
  const { rooms, summary } = evidence.snapshot;
  const byCode = {}, byPlatform = {};
  for (const room of rooms) {
    byCode[room.code] = (byCode[room.code] || 0) + 1;
    byPlatform[room.platform] = (byPlatform[room.platform] || 0) + 1;
  }
  Object.assign(summary, {
    total: rooms.length, live: byCode.OK || 0, offline: byCode.OFFLINE || 0,
    abnormal: rooms.length - (byCode.OK || 0) - (byCode.OFFLINE || 0),
    by_code: byCode, by_platform: byPlatform
  });
  Object.assign(evidence.summary, {
    targets_total: rooms.length, by_code: { ...byCode }, by_platform: { ...byPlatform }
  });
}

export function tenTargetRound(attempt = 1) {
  const source = { runId: '970003', attempt, headSha: 'a'.repeat(40) };
  const base = { schema_version: '2.0', run_id: source.runId + '.' + attempt };
  const { start, discovery, challenge, skip, end } = fixtureTimes;
  const registry = [], rooms = [], discoveries = [];
  for (let i = 1; i <= 10; i++) {
    const jd = i === 10, blocked = !jd && i % 3 === 1;
    const id = jd ? 'J-C01' : 'T' + i;
    const key = 'fixture-key-' + id, name = '虚构门店' + i;
    const identity = String(8500000000 + i);
    const roomUrl = jd ? null : 'https://h5.m.taobao.com/taolive/video.html?userId=' + identity;
    registry.push({ id, keyHash: hash(key), nameHash: hash(name), identityHash: hash(roomUrl || identity) });
    const mode = jd ? 'shop_discover' : 'anchor_entry';
    const route = { code: jd ? 'SCHEMA_MISMATCH' : 'OK', reason: jd ? 'no_live_candidate_in_guest_shop' : 'anchor_entry', source: jd ? 'none' : 'static' };
    const common = { target_key: key, platform: jd ? 'jd' : 'tmall', account_group: jd ? null : Math.ceil(i / 3), live_id: null, room_url: roomUrl };
    discoveries.push({
      ...common, ...route, discovery_mode: mode, resolved_at: discovery, cache_age_seconds: null,
      verification: jd ? 'none' : 'config',
      audit: jd ? { calibrated: false, candidate_ids: [], shop: { entry: 'shop_m_jd', status: 'loaded', main_http_status: 200, vender_id_seen: null } } : { cookie_mode: 'guest' }
    });
    const diagnostics = blocked ? {
      http_status: 200, identity_verified: false, offline_evidence: false, offline_rule_validated: false,
      network: { allowed: 1 }, passive_observation: { navigation_attempted: true }
    } : { network_requests: 0 };
    rooms.push({
      ...common, display_name: name,
      code: jd ? route.code : blocked ? 'CAPTCHA_X5SEC' : 'GROUP_CIRCUIT_OPEN',
      reason: jd ? route.reason : blocked ? 'api_access_limit' : 'group_circuit_open',
      live_status: 'unknown', observed_at: jd ? discovery : blocked ? challenge : skip,
      elapsed_ms: blocked ? 100 : 0, detect_ms: null, online_count: null, item_title: null,
      item_price: null, keywords_hit: [], thumbnail: null, discovery: { ...route, mode }, diagnostics
    });
  }
  const groups = [1, 2, 3].map(i => 'ali:group_' + i);
  const breakers = Object.fromEntries(groups.map((group, i) => [group, {
    tripped_by: rooms[i * 3].target_key, code: 'CAPTCHA_X5SEC', layer: 'monitor', at: challenge
  }]));
  const evidence = {
    snapshot: { ...base, generated_at: skip, rooms, canary: { target_key: null, passed: null, code: null, live_status: null },
      summary: { circuit_open_groups: groups, max_detect_ms: null, median_detect_ms: null } },
    resolved: { ...base, generated_at: discovery, rooms: discoveries },
    summary: {
      schema_version: '2.0', repository: 'lijianjun004-star/tcl-live-monitor', branch: 'main', event: 'workflow_dispatch',
      engine: 'live', head_sha: source.headSha, run_id: source.runId, run_attempt: String(attempt),
      started_utc: start, completed_utc: end, positive_live_control: false, verdict: 'no_canary',
      contract_validation: { resolved_rooms: 'ok', monitor_snapshot: 'ok' }, state_snapshot_advanced: true,
      circuit_breaker: breakers, max_detect_ms: null, median_detect_ms: null
    },
    control: {
      observed_from: start, observed_until: skip, status: 'not_run_no_canary', positive_live_control: false,
      target_key: null, room_id: null, live_status: 'unknown', room_id_matched: null, page_loaded: null,
      login_or_captcha_blocked: null, code: null
    }
  };
  recount(evidence);
  return { registry, source, evidence };
}

// Switch one synthetic row's monitor result. Keep both handoff layers' totals consistent.
export function result(round, index, code, status = 'unknown', diagnostics = {}) {
  const room = round.evidence.snapshot.rooms[index];
  Object.assign(room, {
    code, live_status: status, reason: null, observed_at: fixtureTimes.challenge, elapsed_ms: 100,
    diagnostics: { passive_observation: { navigation_attempted: true }, ...diagnostics }
  });
  recount(round.evidence);
  return room;
}
