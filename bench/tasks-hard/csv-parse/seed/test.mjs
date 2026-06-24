import assert from 'node:assert/strict';
import { parseCsvLine } from './csv.mjs';

// PASS_TO_PASS — unquoted fields, including empties.
assert.deepEqual(parseCsvLine('a,b,c'), ['a', 'b', 'c']);
assert.deepEqual(parseCsvLine('a,,c'), ['a', '', 'c']);

// FAIL_TO_PASS — quoted fields with embedded commas and "" escaped quotes.
assert.deepEqual(parseCsvLine('a,"b,c",d'), ['a', 'b,c', 'd']);
assert.deepEqual(parseCsvLine('"x""y",z'), ['x"y', 'z']);
assert.deepEqual(parseCsvLine('"hello, world"'), ['hello, world']);

console.log('ok');
