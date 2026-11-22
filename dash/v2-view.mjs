// Presentation of an already validated, public V2 model. The pure functions below
// are shared by the first paint, the open page's clock and both export formats.
import { assessFreshness, beijingDay } from './freshness.mjs';

const statuses = { live: '采样时在播', offline: '采样时未播', replay: '采样时为回放', unknown: '无法判断' };
const reasons = {
  confirmed: '身份与状态已核验', uncalibrated: '判定规则待校准', identity: '身份关系待核实',
  challenge: '人机验证', login: '需要登录', timeout: '访问超时', redirect: '页面跳转',
  blocked: '访问受限', no_candidate: '店铺页未发现候选场次', unrecognized: '证据不足',
  circuit: '本组暂停，本店未发出请求', time: '采样时间无法确认'
};
export const roles = { assessed: '可考核', monitor: '仅监控', candidate: '候选，待定' };

export function v2Time(value) {
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) return '';
  return new Date(ms + 8 * 3600000).toISOString().slice(0, 19).replace('T', ' ');
}

export function v2Recent(row, now) {
  const ref = row.recentLive;
  if (!ref || row.platform !== 'tmall' || row.status !== 'unknown' || !['challenge', 'circuit'].includes(row.reason)) {
    return { recentState: 'NONE', recentLabel: '' };
  }
  const at = Date.parse(ref.observedAt), latest = Date.parse(row.recordedAt);
  if (!Number.isFinite(at) || !Number.isFinite(latest) || !Number.isFinite(now) || at > now || at >= latest || latest > now ||
      latest - at > 180 * 60000 || !/^[1-9]\d{0,19}$/.test(ref.runId) || !Number.isSafeInteger(ref.attempt) || ref.attempt < 1) {
    return { recentState: 'NONE', recentLabel: '' };
  }
  const recentState = now - at <= 180 * 60000 ? 'AVAILABLE' : 'EXPIRED';
  const label = recentState === 'AVAILABLE' ? '最近确认在播 · 本轮未确认' : '历史在播记录已过期';
  return { recentState, recentLabel: label + '（' + v2Time(ref.observedAt) + '）' };
}

export function v2State(row, now) {
  const stamp = row.status === 'unknown' ? row.attemptedAt || row.recordedAt : row.verifiedAt;
  let age = assessFreshness(stamp, now).state;
  const shift = row.platform === 'jd' ? 0 : 6;
  if (age === 'CURRENT' && beijingDay(Date.parse(stamp), shift) !== beijingDay(now, shift)) age = 'STALE';
  const current = age === 'CURRENT' && !row.skipped ? row.status : 'unknown';
  const sample = row.skipped ? '跳过，状态未知' : age === 'UNKNOWN' ? '无法判断' : statuses[row.status];
  const label = age === 'STALE' ? '历史记录 · ' + sample : age === 'UNKNOWN' ? '时间未确认 · ' + sample : sample;
  return { current, age, sample, label, reason: reasons[row.reason], role: roles[row.role], ...v2Recent(row, now) };
}

export function v2Counts(rows, now) {
  const counts = { covered: rows.length, live: 0, offline: 0, replay: 0, unknown: 0, skipped: 0,
    uncalibrated: 0, assessedValid: 0, historical: 0, recentLive: 0 };
  for (const row of rows) {
    const state = v2State(row, now);
    counts[state.current]++;
    if (state.recentState === 'AVAILABLE') counts.recentLive++;
    if (state.age === 'STALE') counts.historical++;
    if (state.age !== 'CURRENT') continue;
    if (row.skipped) counts.skipped++;
    if (row.reason === 'uncalibrated') counts.uncalibrated++;
    if (state.current !== 'unknown' && row.role === 'assessed') counts.assessedValid++;
  }
  return counts;
}

function v2Event(row) {
  if (row.skipped) return { label: '调度登记', at: v2Time(row.recordedAt) };
  if (row.attemptedAt) return { label: '采样尝试', at: v2Time(row.attemptedAt) };
  return { label: '本轮登记', at: v2Time(row.recordedAt) };
}

export function v2Export(row, now) {
  const state = v2State(row, now);
  const event = v2Event(row);
  const verified = v2Time(row.verifiedAt);
  const words = ['V2 单轮观测', state.role, state.label, state.reason, event.label + ' ' + (event.at || '时间未确认')];
  if (verified) words.push('有效观测 ' + verified);
  const recentObserved = state.recentState !== 'NONE' ? v2Time(row.recentLive.observedAt) : '';
  const recentSource = recentObserved ? row.recentLive.runId + '.' + row.recentLive.attempt : '';
  const recentStatus = { AVAILABLE: '历史参考，本轮未确认', EXPIRED: '已过期，不代表当前状态', NONE: '' }[state.recentState];
  if (recentObserved) words.push(state.recentLabel + '，仅作历史参考，不代表当前在播，来源 ' + recentSource);
  if (row.role === 'assessed' && row.status === 'unknown') words.push('本轮无有效样本');
  return { status: statuses[state.current], sample: state.sample, age: { CURRENT: '本期', STALE: '历史', UNKNOWN: '时间未确认' }[state.age],
    role: state.role, reason: state.reason, schedule: row.skipped ? event.at : '', attempt: v2Time(row.attemptedAt), recorded: v2Time(row.recordedAt),
    verified, recentObserved, recentSource, recentStatus, text: words.join('，') };
}

export const v2BrowserFunctions = [
  'const statuses = ' + JSON.stringify(statuses) + ', reasons = ' + JSON.stringify(reasons) + ', roles = ' + JSON.stringify(roles) + ';',
  v2Time, v2Recent, v2State, v2Counts, v2Event, v2Export
].map(String).join('\n');

const fields = ['id', 'platform', 'role', 'recordedAt', 'attemptedAt', 'verifiedAt', 'status', 'reason', 'skipped'];
export function v2Rows(input) {
  if (!Array.isArray(input.rows)) throw new Error('V2_VIEW_ROWS');
  if (!input.source && input.rows.length === 0) return [];
  if (!input.source || input.rows.length !== 10) throw new Error('V2_VIEW_INCOMPLETE');
  const ids = new Set();
  return input.rows.map(raw => {
    const row = Object.fromEntries(fields.map(key => [key, raw[key]]));
    const jd = row.id === 'J-C01';
    if ((!jd && !/^T[1-9]$/.test(row.id)) || ids.has(row.id) || row.platform !== (jd ? 'jd' : 'tmall') ||
        row.role !== (jd ? 'candidate' : row.id === 'T1' ? 'assessed' : 'monitor') ||
        !Object.hasOwn(statuses, row.status) || !Object.hasOwn(reasons, row.reason) || typeof row.skipped !== 'boolean') {
      throw new Error('V2_VIEW_ROW');
    }
    for (const key of ['recordedAt', 'attemptedAt', 'verifiedAt']) {
      if (row[key] == null) row[key] = null;
      else if (typeof row[key] === 'string' && Number.isFinite(Date.parse(row[key]))) row[key] = new Date(row[key]).toISOString();
      else throw new Error('V2_VIEW_TIME');
    }
    if (raw.recentLive != null) {
      const ref = raw.recentLive;
      if (typeof ref.observedAt !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(ref.observedAt) ||
          !Number.isFinite(Date.parse(ref.observedAt)) || new Date(ref.observedAt).toISOString() !== ref.observedAt ||
          typeof ref.runId !== 'string' || !/^[1-9]\d{0,19}$/.test(ref.runId) ||
          !Number.isSafeInteger(ref.attempt) || ref.attempt < 1) throw new Error('V2_VIEW_REFERENCE');
      row.recentLive = { observedAt: ref.observedAt, runId: ref.runId, attempt: ref.attempt };
    }
    ids.add(row.id);
    return row;
  });
}

export function v2CardAttributes(row, now) {
  const state = v2State(row, now);
  return 'data-v2-code="' + row.id + '" data-v2-result="' + state.current + '" data-v2-age="' + state.age +
    '" data-v2-recent="' + state.recentState + '"' + (row.skipped ? ' data-v2-skip' : '') + (row.reason === 'uncalibrated' ? ' data-v2-uncalibrated' : '');
}

export function v2SummaryLine(row, now) {
  const state = v2State(row, now);
  const event = v2Event(row);
  return '<span class="v2-line"><b>V2 本次采样</b> <span data-v2-label="' + row.id + '">' + state.label +
    '</span><small>' + event.label + ' ' + (event.at || '时间未确认') + '</small></span>' +
    (row.recentLive ? '<span class="v2-recent" data-v2-reference="' + row.id + '"' +
      (state.recentState === 'NONE' ? ' hidden' : '') + '>' + state.recentLabel + '</span>' : '');
}

export function v2Detail(row, now) {
  const state = v2State(row, now);
  const attempted = v2Time(row.attemptedAt);
  const verified = v2Time(row.verifiedAt);
  const point = !row.skipped && attempted && assessFreshness(row.attemptedAt, now).state !== 'UNKNOWN' ?
    '<ol class="v2-timeline"><li data-v2-point="' + row.id + '"><time datetime="' + row.attemptedAt + '">' + attempted +
      '</time> · ' + state.sample + '</li></ol>' : '';
  const ref = row.recentLive;
  const historical = ref ? '<p class="v2-reference-detail">历史在播确认时间 ' + v2Time(ref.observedAt) +
    ' · <a href="https://github.com/lijianjun004-star/tcl-live-monitor/actions/runs/' + ref.runId + '/attempts/' + ref.attempt +
    '">查看原始采集</a></p><p class="fine">仅作历史参考。本轮状态仍未知，不计入当前在播、直播时长或考核；有效期从原始采样时间计算。</p>' : '';
  return '<section class="v2-detail"><h3>V2 单轮观测</h3><p>' + state.role + ' · ' + state.reason + '</p>' + point +
    '<p>有效观测时间 ' + (verified || '—') + (row.role === 'assessed' ? (row.status === 'unknown' ? ' · 本轮无有效样本' : ' · 本轮有效样本 1 次') : '') + '</p>' + historical + '</section>';
}

const tallyLabels = { covered: '覆盖', live: '在播', offline: '未播', replay: '回放', unknown: '未知',
  skipped: '其中跳过', uncalibrated: '规则待校准', assessedValid: '有效考核样本', historical: '历史记录', recentLive: '近期在播参考' };
export function v2Overview(source, latest, round, current, historyStatus) {
  const completion = { success: '成功', failure: '失败', cancelled: '取消', timed_out: '超时', action_required: '需处理',
    neutral: '中性', skipped: '跳过', stale: '过期', startup_failure: '启动失败' };
  const notify = { sent: '接口已接受，手机送达待确认', no_changes: '无变更', failed: '失败', unknown: '未知', not_bark: '本轮未采用 Bark' };
  const archive = { synced: '已同步', failed: '失败', unknown: '未知' };
  const latestAt = v2Time(latest?.at);
  const health = '<p class="fine">最近完成的 V2 采集任务 · ' + (latestAt ? latestAt + ' · ' + (completion[latest.conclusion] || '未知') : '暂无运行信息') + '</p>';
  const heading = '<section class="v2-overview" aria-labelledby="v2-title"><h2 id="v2-title">V2 单轮观测</h2>';
  if (!source) return heading + '<p>暂无可核验的 V2 证据。</p>' + health + '</section>';
  const metric = (kind, values, keys) => keys.map(key => {
    if (!Number.isSafeInteger(values?.[key]) || values[key] < 0) throw new Error('V2_VIEW_COUNT');
    return '<span>' + tallyLabels[key] + ' <b data-v2-' + kind + '="' + key + '">' + values[key] + '</b></span>';
  }).join('');
  const control = { not_configured: '未配置正控', passed: '正控通过', failed: '正控失败', unresolved: '正控未确认' };
  const run = /^[1-9]\d{0,17}$/.test(source.runId) && Number.isSafeInteger(source.attempt) && source.attempt > 0 ?
    '<a href="https://github.com/lijianjun004-star/tcl-live-monitor/actions/runs/' + source.runId + '/attempts/' + source.attempt + '">第 ' + source.attempt + ' 次尝试</a>' : '';
  const fallback = latest && (source.runId !== latest.runId || source.attempt !== latest.attempt) ?
    '<p class="fine">最近完成的任务与所选证据不同，本版沿用下方采集时间对应的记录。</p>' : '';
  const reference = historyStatus === 'unavailable' ?
    '<div class="v2-recent-total">近期在播参考暂不可用<small>历史记录未能完整核验，本轮结果保留。</small></div>' :
    '<div class="v2-recent-total">' + metric('count', current, ['recentLive']) +
    ' <small>近 180 分钟曾确认在播，本轮遇验证或同组暂停，当前仍待复核。</small></div>';
  return heading + fallback + '<p class="fine">本轮采集 ' + (v2Time(source.startedAt) || '时间未确认') + ' 至 ' +
    (v2Time(source.completedAt) || '时间未确认') + (run ? ' · ' + run : '') + '</p>' +
    '<h3>本轮记录</h3><div class="v2-tally">' + metric('round', round, ['covered','live','offline','replay','unknown','skipped','uncalibrated','assessedValid']) + '</div>' +
    '<h3>当前状态</h3><div class="v2-tally">' + metric('count', current, ['live','offline','replay','unknown','historical']) + '</div>' +
    reference +
    '<p class="fine">跳过计入未知。每个样本只说明采样时的状态。超过 3 小时或跨统计日后，该店当前状态记为未知。</p>' +
    '<details><summary>采集运行情况</summary>' + health + '<p class="fine">所选证据 · ' + (control[source.control] || control.unresolved) +
    ' · ' + (source.stateAdvanced === true ? '已推进恢复快照' : source.stateAdvanced === false ? '未推进恢复快照' : '恢复快照状态未知') +
    '</p><p class="fine">Bark 通知 · ' + (notify[source.notification] || notify.unknown) +
    '　Drive 归档 · ' + (archive[source.archive] || archive.unknown) + '</p></details></section>';
}
