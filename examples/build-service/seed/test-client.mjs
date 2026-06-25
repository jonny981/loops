// client contract — the convergence gate for the client engineer.
// Exit 0 = the client wires api + serialize into a working stack that round-trips. Like
// test-serialize, this checks self-consistency, not the on-the-wire tag (held-out gate).
import assert from 'node:assert/strict';
import { createClient } from './client.mjs';

const c = createClient();
const api = c.api();
api.create('x'); // 1
api.create('y'); // 2
api.create('z'); // 3
api.delete(2);

const wire = c.snapshot();
assert.equal(typeof wire, 'string', 'the client produces a snapshot string');

const restored = createClient();
restored.restore(wire);
const back = restored.api();
assert.equal(back.read(1), 'x', 'records survive a snapshot/restore through the client');
assert.equal(back.read(3), 'z');
assert.equal(back.read(2), undefined, 'a deleted record stays deleted');

// A create after restore continues the id sequence (the counter rode through the stack).
assert.equal(back.create('w'), 4, 'create after restore never reuses the freed id 2');

console.log('client: ok');
