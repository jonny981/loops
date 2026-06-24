import assert from 'node:assert/strict';
import { dedupe } from './dedupe.mjs';

// PASS_TO_PASS — already-sorted / empty inputs are unaffected.
assert.deepEqual(dedupe([]), []);
assert.deepEqual(dedupe([1, 2, 3]), [1, 2, 3]);

// FAIL_TO_PASS — dedupe must keep first-occurrence order, not sort.
assert.deepEqual(dedupe([3, 1, 2, 1, 3]), [3, 1, 2]);
assert.deepEqual(dedupe(['b', 'a', 'b']), ['b', 'a']);

console.log('ok');
