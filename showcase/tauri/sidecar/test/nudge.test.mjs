// Nudge cards: same key replaces (dedup), expiry, activate/dismiss. Run: npm test
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'roamies-nudge-test-'));
process.env.ROAMIES_DATA_DIR = TMP; process.env.HOME = TMP; process.env.USERPROFILE = TMP;
process.on('exit', () => fs.rmSync(TMP, { recursive: true, force: true }));
const N = await import('../nudge.mjs');

N.Show('k', 'first', 's1');
N.Show('k', 'second', 's2');
assert.equal(N.Has('k'), true);
const rows = N.Rows();
assert.equal(rows.filter((r) => r.primary === 'second').length, 1);
assert.equal(rows.filter((r) => r.primary === 'first').length, 0);

let clicked = 0, dismissed = 0;
N.Show('x', 'p', 's', { click: () => clicked++, dismissed: () => dismissed++, ttl: 1000 });
N.Activate('nudge:x');
assert.equal(clicked, 1);
N.Show('x', 'p2', 's2', { dismissed: () => dismissed++ });
N.Dismiss('nudge:x');
assert.equal(dismissed, 1);

// quiet config parsing.
const cfg = N.quietConfig({ quietHours: '23:00-07:00' });
assert.equal(N.Quiet({ quietHours: '23:00-07:00' }, new Date(2026, 10, 22, 2, 0)), true);
assert.equal(N.InWindow('23:00-07:00', new Date(2026, 10, 22, 12, 0)), false);

console.log('nudge tests: passed');