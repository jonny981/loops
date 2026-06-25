// Public smoke tests — basic functionality only. These do NOT check the id
// stability invariant (that lives in the hidden gate), so passing these does not
// mean the store is correct.
import assert from 'node:assert/strict';
import * as store from './store.mjs';

store._reset();
const a = store.add('apple');
const b = store.add('banana');
assert.equal(store.get(a), 'apple');
assert.equal(store.get(b), 'banana');
assert.deepEqual(store.all(), ['apple', 'banana']);

console.log('public ok');
