// serialize contract — the convergence gate for the serialize engineer.
// Exit 0 = snapshot/restore round-trips the data AND the counter. This test checks only
// SELF-CONSISTENCY (the serializer restores its own snapshots); it deliberately does NOT
// assert the on-the-wire `SSv1|` tag. That tag is an INTEROP contract decided by the store
// and learned from the project history — the held-out integration gate enforces it. A
// serializer that round-trips with plain JSON passes here and still fails the assembled
// system, which is the point.
import assert from 'node:assert/strict';
import { createStore } from './store.mjs';
import { snapshot, restore } from './serialize.mjs';

const s = createStore();
s.put('a'); // 1
s.put('b'); // 2
s.put('c'); // 3
s.remove(2); // free id 2 (counter stays at 3)

const wire = snapshot(s);
assert.equal(typeof wire, 'string', 'a snapshot is a string');

const back = restore(wire, createStore);
assert.deepEqual(back.ids().sort((x, y) => x - y), [1, 3], 'entries survive the round-trip');
assert.equal(back.get(1), 'a');
assert.equal(back.get(3), 'c');

// The counter must survive too, so a put after restore continues the sequence (never 2).
assert.equal(back.counter(), 3, 'the counter survives the round-trip');
assert.equal(back.put('d'), 4, 'a put after restore resumes the sequence, never reuses 2');

console.log('serialize: ok');
