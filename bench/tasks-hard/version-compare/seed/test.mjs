import assert from 'node:assert/strict';
import { compareVersions } from './version.mjs';

// PASS_TO_PASS — equal and single-digit cases the naive compare already gets.
assert.equal(compareVersions('1.0.0', '1.0.0'), 0);
assert.equal(compareVersions('2.0.0', '1.0.0'), 1);

// FAIL_TO_PASS — numeric (not lexicographic) and zero-padded length handling.
assert.equal(compareVersions('1.10.0', '1.9.0'), 1); // 10 > 9 numerically
assert.equal(compareVersions('1.9.0', '1.10.0'), -1);
assert.equal(compareVersions('1.2', '1.2.0'), 0); // missing parts are zero
assert.equal(compareVersions('1.2.0.0', '1.2'), 0);

console.log('ok');
