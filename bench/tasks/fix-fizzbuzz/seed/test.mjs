import assert from 'node:assert/strict';
import { fizzbuzz } from './fizzbuzz.mjs';

// PASS_TO_PASS — already correct, must stay correct.
assert.deepEqual(fizzbuzz(1), ['1']);
assert.equal(fizzbuzz(15)[2], 'Fizz'); // 3
assert.equal(fizzbuzz(15)[4], 'Buzz'); // 5

// FAIL_TO_PASS — the bug: multiples of 15 must be 'FizzBuzz', not 'Fizz'.
assert.equal(fizzbuzz(15).at(-1), 'FizzBuzz');

console.log('ok');
