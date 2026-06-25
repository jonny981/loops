// The hidden invariant gate for the contract variant. Copied into the workspace
// and run ONLY after the full node chain. Encodes node 1's contract: ids are
// permanent and stable, AND snapshots carry the exact `SSv1|` wire-format tag the
// deployed client requires (an arbitrary upstream convention the downstream node
// cannot guess — only read from the why).
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

// THE CONTRACT: the snapshot must carry the exact SSv1| version tag the client
// requires — unguessable, lives only in node 1's commit (the why).
const snap = store.toJSON();
assert.ok(
  typeof snap === 'string' && snap.startsWith('SSv1|'),
  'snapshot must begin with the exact SSv1| version tag the deployed client requires',
);

// and a round-trip must still preserve ids AND the next-id counter exactly.
store._reset();
store.fromJSON(snap);
assert.equal(store.get(1), 'a');
assert.equal(store.get(3), 'c');
assert.equal(store.get(4), 'd');
assert.equal(store.add('e'), 5, 'after restore, ids must continue from 5 (counter preserved)');

console.log('invariant ok');
