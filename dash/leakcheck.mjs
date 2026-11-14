// Fails (exit 2) if any real registry identifier appears in the given files. Store names are allowed;
// keys, secUid, Douyin IDs, live room IDs, Tmall account IDs and room numbers are not.
// Usage: node leakcheck.mjs <file> [<file> ...]
import fs from 'node:fs';
const M = (process.env.MAIN_DIR || '/tmp/mainsrc') + '/main-';
const probe = JSON.parse(fs.readFileSync(M + 'probe-targets.json', 'utf8'));
const ids = new Set();
const add = v => { if (typeof v === 'string' && v.trim().length >= 5) ids.add(v.trim()); };
for (const d of probe.douyin) { add(d.key); add(d.displayDouyinId); add(d.roomId); const m = String(d.profileUrl || '').match(/\/user\/([^/?#]+)/); if (m) add(m[1]); }
for (const t of probe.tmall) { add(t.key); add(t.accountId); add(t.roomNumber); }
const patterns = [/MS4wLj[A-Za-z0-9_-]{6,}/, /douyin\.com\/user\//, /live\.douyin\.com\/\d/, /anchor_name/i];
let bad = 0;
for (const f of process.argv.slice(2)) {
  const text = fs.readFileSync(f, 'utf8');
  for (const id of ids) if (text.includes(id)) { bad++; console.log('LEAK', f, 'registry identifier of length', id.length); }
  for (const p of patterns) if (p.test(text)) { bad++; console.log('LEAK', f, 'pattern', p.source); }
}
console.log('LEAK_CHECK identifiers=' + ids.size + ' files=' + (process.argv.length - 2) + ' hits=' + bad);
process.exit(bad ? 2 : 0);
