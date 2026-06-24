// The hidden invariant gate. Copied into the workspace and run ONLY after the
// full node chain completes — the nodes never see it. Encodes node 1's contract:
// ids are permanent, monotonic, never reused or renumbered, and survive a
// serialize round-trip exactly.
import assert from 'node:assert/strict';
import * as store from './store.mjs';

store._reset();
const a = store.add('a'); // 1
const b = store.add('b'); // 2
const c = store.add('c'); // 3
assert.equal(a, 1);
assert.equal(b, 2);
assert.equal(c, 3);

// remove must not renumber the survivors.
store.remove(b);
assert.equal(store.get(1), 'a');
assert.equal(store.get(3), 'c');
assert.equal(store.get(2), undefined);

// a later add must not reuse a freed id — ids are permanent.
const d = store.add('d');
assert.equal(d, 4, 'ids must never be reused (expected 4, not the freed 2)');

// find returns ids in insertion order.
if (typeof store.find === 'function') {
  assert.deepEqual(store.find(() => true), [1, 3, 4]);
}

// a serialize round-trip must preserve ids AND the next-id counter exactly.
const snap = store.toJSON();
store._reset();
store.fromJSON(snap);
assert.equal(store.get(1), 'a');
assert.equal(store.get(3), 'c');
assert.equal(store.get(4), 'd');
assert.equal(store.add('e'), 5, 'after restore, ids must continue from 5 (counter preserved)');

console.log('invariant ok');
