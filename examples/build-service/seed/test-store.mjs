// store contract — the convergence gate for the store engineer.
// Exit 0 = the store honours stable, never-reused ids and exposes the counter.
import assert from 'node:assert/strict';
import { createStore } from './store.mjs';

const s = createStore();
assert.equal(s.put('a'), 1, 'first id is 1');
assert.equal(s.put('b'), 2, 'ids increment');
assert.equal(s.put('c'), 3);
assert.equal(s.get(2), 'b', 'get returns the stored value');
assert.equal(s.has(2), true);
assert.equal(s.count(), 3);

assert.equal(s.set(2, 'B'), true, 'set updates in place');
assert.equal(s.get(2), 'B');
assert.equal(s.set(99, 'x'), false, 'set on a missing id returns false');

assert.equal(s.remove(2), true, 'remove returns true when present');
assert.equal(s.remove(2), false, 'remove returns false when absent');
assert.equal(s.count(), 2);
assert.deepEqual(s.ids(), [1, 3], 'ids reflect removals');

// THE contract: a removed id is never reused — the next put is strictly greater than any
// id ever issued, even though slot 2 is now free.
const next = s.put('d');
assert.equal(next, 4, 'put after remove mints a fresh id, never reuses 2');
assert.ok(!s.ids().includes(2), 'the freed id 2 is gone for good');
assert.equal(s.counter(), 4, 'counter tracks the high-water mark');

console.log('store: ok');
