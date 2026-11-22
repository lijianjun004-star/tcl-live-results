import { createHash } from 'node:crypto';
import fs from 'node:fs';

const approvedRoster = JSON.parse(fs.readFileSync(new URL('./private/v2-roster.json', import.meta.url), 'utf8'));
const hash = s => createHash('sha256').update(s, 'utf8').digest('hex');

// Log keys refer to the legacy configuration. Bind each one to the fixed account
// in the reviewed roster so changing the collector's iteration order cannot relabel a card.
export function legacyTmallLabels(targets, registry = approvedRoster) {
  const approved = new Map(registry.filter(r => /^T[1-9]$/.test(r.id)).map(r => [r.legacyKeyHash ?? r.keyHash, r]));
  const labels = new Map();
  for (const target of targets) {
    const entry = typeof target?.key === 'string' && approved.get(hash(target.key));
    if (!entry || labels.has(target.key) || typeof target.accountId !== 'string' ||
        hash('https://h5.m.taobao.com/taolive/video.html?userId=' + target.accountId) !== entry.identityHash) {
      throw new Error('TM_ROSTER_MISMATCH');
    }
    labels.set(target.key, entry.id);
  }
  return key => {
    if (!labels.has(key)) throw new Error('TM_KEY_UNMAPPED');
    return labels.get(key);
  };
}
