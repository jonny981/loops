import assert from 'node:assert/strict';
import { mergeIntervals } from './intervals.mjs';

// PASS_TO_PASS — already-sorted, clearly-overlapping input.
assert.deepEqual(mergeIntervals([[1, 3], [2, 6], [8, 10]]), [[1, 6], [8, 10]]);
assert.deepEqual(mergeIntervals([[1, 5]]), [[1, 5]]);

// FAIL_TO_PASS — unsorted input must be sorted first; touching intervals merge.
assert.deepEqual(mergeIntervals([[8, 10], [1, 3], [2, 6]]), [[1, 6], [8, 10]]);
assert.deepEqual(mergeIntervals([[1, 2], [2, 3]]), [[1, 3]]);
assert.deepEqual(mergeIntervals([[1, 4], [2, 3]]), [[1, 4]]);

console.log('ok');
