// Scan the staged publication and the machine-readable exports. Never log a matched value.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const registry = JSON.parse(fs.readFileSync(path.join(process.env.MAIN_DIR || '/tmp/mainsrc', 'main-probe-targets.json'), 'utf8'));
const privateValues = new Set();
function add(value) {
  if (typeof value === 'string' || typeof value === 'number') {
    const text = String(value).trim();
    if (text.length >= 5) privateValues.add(text);
  }
}
for (const row of registry.douyin) {
  [row.key, row.displayDouyinId, row.roomId, row.profileUrl?.match(/\/user\/([^/?#]+)/)?.[1]].forEach(add);
}
for (const row of registry.tmall) [row.key, row.accountId, row.roomNumber].forEach(add);

const hiddenValueKey = /^(target_key|tripped_by|account_group|account_?id|user_?id|anchor_?id|broadcaster_?id|room_?(id|number|url)|live_?id|candidate_ids|shop_?id|vender_?id|thumbnail|report_file_id)$/i;
function readPrivateValues(value, key = '') {
  if (Array.isArray(value)) {
    for (const item of value) readPrivateValues(item, key);
  } else if (value !== null && typeof value === 'object') {
    for (const [field, item] of Object.entries(value)) readPrivateValues(item, field);
  } else if (hiddenValueKey.test(key)) {
    add(value);
    if (typeof value === 'string' && /^https?:\/\//i.test(value)) {
      const url = new URL(value);
      for (const id of url.pathname.match(/\d{5,}/g) || []) add(id);
      for (const [name, id] of url.searchParams) if (hiddenValueKey.test(name)) add(id);
    }
  }
}
const privateDir = process.env.V2_PRIVATE_DIR;
if (privateDir) {
  for (const name of ['monitor_snapshot','resolved_rooms','control_live_result','run_summary','drive_status']) {
    const file = path.join(privateDir, name + '.json');
    if (fs.existsSync(file)) readPrivateValues(JSON.parse(fs.readFileSync(file, 'utf8')));
  }
}
const names = JSON.parse(fs.readFileSync(fileURLToPath(new URL('./private/names.json', import.meta.url)), 'utf8')).names;
const patterns = [
  /MS4wLj[A-Za-z0-9_-]{6,}|douyin\.com\/user\/|live\.douyin\.com\/\d/i,
  /(?:[\w.-]+\.)?(?:taobao|tmall|jd|360buyimg|jdvod|alicdn)\.com\//i,
  /\b(?:anchor_name|target_key|account_group|room_url|live_id|cookie_mode|diagnostics|api_ret|refresh_token|access_token|client_secret|report_file_id|thumbnail|userId|accountId|shopId)\b/i,
  /RGV587_ERROR|FAIL_SYS_USER_VALIDATE|CAPTCHA_X5SEC|GROUP_CIRCUIT_OPEN|ali:group_\d/i,
  /(?:monitor_snapshot|resolved_rooms|run_summary|control_live_result|drive_status)\.json|TCL_V2_Evidence_|v2-state|thumb-.*?\.jpe?g|data:image\//i,
  /[?&](?:token|access_token|refresh_token|signature|x-goog-signature|x-amz-signature|key)=[^&\s"'<>]+/i,
  /\bBearer\s+[A-Za-z0-9_.~+/=-]+|(?:hook\.feishu\.cn|api\.day\.app)\//i
];
const machineData = new Set(['.json','.csv','.tsv']);
const textTypes = new Set([...machineData,'.html','.md']);
let scanned = 0;
const hits = new Map();
function hit(kind) { hits.set(kind, (hits.get(kind) || 0) + 1); }
// Rendered HTML attributes, nested JSON and query parameters can encode the same private value.
function decodedText(input) {
  const entities = { amp: '&', quot: '"', apos: "'", lt: '<', gt: '>', colon: ':', sol: '/', equals: '=' };
  let text = input;
  for (let layer = 0; layer < 3; layer++) {
    const decoded = text.replace(/&(amp|quot|apos|lt|gt|colon|sol|equals);/gi, (_, name) => entities[name.toLowerCase()])
      .replace(/&#(x[0-9a-f]+|\d+);/gi, (match, code) => {
        const point = /^x/i.test(code) ? parseInt(code.slice(1), 16) : Number(code);
        return point <= 0x10ffff ? String.fromCodePoint(point) : match;
      })
      .replace(/\\u([0-9a-f]{4})/gi, (_, code) => String.fromCharCode(parseInt(code, 16)))
      .replace(/\\\//g, '/')
      .replace(/(?:%[0-9a-f]{2})+/gi, bytes => Buffer.from(bytes.replaceAll('%', ''), 'hex').toString('utf8'));
    if (decoded === text) break;
    text = decoded;
  }
  return text;
}
function scan(file) {
  const stat = fs.lstatSync(file);
  if (stat.isDirectory()) {
    for (const name of fs.readdirSync(file)) scan(path.join(file, name));
    return;
  }
  scanned++;
  const ext = path.extname(file).toLowerCase();
  if (!stat.isFile() || !textTypes.has(ext)) { hit('unexpected_file'); return; }
  const text = fs.readFileSync(file, 'utf8');
  if (text.includes('\0')) hit('binary');
  const raw = path.basename(file) + '\n' + text;
  const haystack = raw + '\n' + decodedText(raw);
  if ([...privateValues].some(value => haystack.includes(value))) hit('private_value');
  if (patterns.some(re => re.test(haystack))) hit('private_field_or_url');
  if (machineData.has(ext) && Object.values(names).some(({name}) => haystack.includes(name))) hit('display_name_in_data');
}
for (const file of process.argv.slice(2)) scan(file);
if (!scanned) hit('no_files');
for (const [kind, count] of hits) console.error('LEAK', kind, count);
console.log('LEAK_CHECK identifiers=' + privateValues.size + ' files=' + scanned + ' hits=' + [...hits.values()].reduce((a, b) => a + b, 0));
process.exitCode = hits.size ? 2 : 0;
