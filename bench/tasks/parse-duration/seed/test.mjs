import assert from 'node:assert/strict';
import { parseDuration } from './duration.mjs';

// PASS_TO_PASS — hours and seconds are already correct.
assert.equal(parseDuration('1h'), 3600000);
assert.equal(parseDuration('45s'), 45000);

// FAIL_TO_PASS — minutes are mis-scaled (treated as seconds).
assert.equal(parseDuration('2m'), 120000);
assert.equal(parseDuration('1h30m'), 5400000);

console.log('ok');
