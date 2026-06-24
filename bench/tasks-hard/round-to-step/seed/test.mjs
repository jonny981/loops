import assert from 'node:assert/strict';
import { roundToStep } from './round.mjs';

// PASS_TO_PASS — integer steps have no floating-point tail.
assert.equal(roundToStep(7, 5), 5);
assert.equal(roundToStep(8, 5), 10);

// FAIL_TO_PASS — the naive form leaks IEEE-754 error (e.g. 3 * 0.1 = 0.30000000000000004).
// The result must equal the clean decimal multiple of step.
assert.equal(roundToStep(0.3, 0.1), 0.3);
assert.equal(roundToStep(0.7, 0.1), 0.7);
assert.equal(roundToStep(1.1, 0.1), 1.1);
assert.equal(roundToStep(2.04, 0.01), 2.04);

console.log('ok');
