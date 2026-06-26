// The hidden gate: run ONLY after the final node implements snapshot(). It checks
// that the snapshot honours ALL twelve conventions the project accrued — each
// decided in a prior commit's why, none guessable from the seed code. Any one
// missing fails the gate. This is the regime where top-k retrieval has a ceiling
// (it fetches the k most-relevant decisions, not all of them) and only a
// consolidated roadmap keeps every decision in bounded space.
import assert from 'node:assert/strict';
import * as store from './store.mjs';

store._reset();
store.add('a'); // 1
store.add('b'); // 2
store.add('c'); // 3
store.remove(2); // survivors keep their ids; counter keeps climbing
store.add('d'); // 4

const out = store.snapshot();

// C1 — leading wire tag
assert.ok(typeof out === 'string' && out.startsWith('SSv1|'), 'C1: must start with SSv1|');
// C2 — JSON object after the tag
const obj = JSON.parse(out.slice('SSv1|'.length));
assert.ok(obj && typeof obj === 'object' && !Array.isArray(obj), 'C2: body is a JSON object');
// C3 — version key is `_v` = 1
assert.equal(obj._v, 1, 'C3: version field `_v` === 1');
// C4 — records under `records`
assert.ok(Array.isArray(obj.records), 'C4: items under key `records`');
// C5 — value key is `val` (not `value`)
assert.ok(obj.records.every((r) => 'val' in r && !('value' in r)), 'C5: value key is `val`');
// C6 — ids are numbers, key `id`
assert.ok(obj.records.every((r) => typeof r.id === 'number'), 'C6: numeric `id`');
// C7 — records sorted by id ascending
const ids = obj.records.map((r) => r.id);
assert.deepEqual(ids, [...ids].sort((a, b) => a - b), 'C7: records sorted by id ascending');
// C8 — `count` === number of records
assert.equal(obj.count, obj.records.length, 'C8: `count` === records.length');
// C9 — `gen` === highest id ever issued (here 4, not 3)
assert.equal(obj.gen, 4, 'C9: `gen` === highest id issued (counter), not record count');
// C10 — `schema` literal
assert.equal(obj.schema, 'store/export', 'C10: `schema` === "store/export"');
// C11 — `checksum` === sum of ids
assert.equal(obj.checksum, ids.reduce((a, b) => a + b, 0), 'C11: `checksum` === sum of ids');
// C12 — `frozen` === true
assert.equal(obj.frozen, true, 'C12: `frozen` === true');

console.log('all 12 conventions ok');
