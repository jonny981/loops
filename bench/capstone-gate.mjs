// Held-out integration gate — the quality bar NEITHER arm sees at build time. It assembles
// the produced components and enforces the cross-cutting contracts that the per-component
// tests deliberately leave out: the exact `SSv1|` wire tag, id stability under churn, and
// counter preservation across snapshot/restore. Exit 0 = the assembled system is correct.
//
// This is the asymmetry the capstone measures: a single agent grades itself against the
// visible per-component tests and calls it done; only an enforced, independent bar catches
// the contract drift those tests miss.
import assert from 'node:assert/strict';
import { createStore } from './store.mjs';
import { createApi } from './api.mjs';
import { snapshot, restore } from './serialize.mjs';
import { createClient } from './client.mjs';

// ── the wire tag (the contract carried only in the store's decision history) ──
{
  const s = createStore();
  s.put('a');
  const wire = snapshot(s);
  assert.equal(typeof wire, 'string', 'snapshot must be a string');
  assert.ok(wire.startsWith('SSv1|'), `snapshot must begin with the exact wire tag "SSv1|", got: ${wire.slice(0, 12)}`);
  // exact, not a near-miss: not SSv2|, not a lowercase variant
  assert.ok(!wire.startsWith('SSv2'), 'wire tag must be version 1, not SSv2');
  assert.ok(!/^ssv1\|/.test(wire), 'wire tag is case-sensitive: "SSv1|", not "ssv1|"');
}

// ── stable ids end to end + counter preserved across a restore ──
{
  const c = createClient();
  const api = c.api();
  assert.equal(api.create('x'), 1);
  assert.equal(api.create('y'), 2);
  assert.equal(api.create('z'), 3);
  assert.equal(api.delete(2), true);
  assert.deepEqual(api.list().map((r) => r.id).sort((a, b) => a - b), [1, 3], 'list reflects the delete');
  assert.equal(api.create('w'), 4, 'a freed id is never reused (4, not 2)');

  const wire = c.snapshot();
  const restored = createClient();
  restored.restore(wire);
  const back = restored.api();
  assert.equal(back.read(1), 'x', 'records survive restore');
  assert.equal(back.read(4), 'w');
  assert.equal(back.read(2), undefined, 'a deleted record stays deleted across restore');
  assert.equal(back.create('v'), 5, 'the counter survives restore — next id is 5, never a collision');
}

// ── id stability under churn: across a long interleaved sequence, no id is EVER reused ──
{
  const s = createStore();
  const issued = new Set();
  const live = [];
  for (let i = 0; i < 200; i++) {
    if (live.length > 0 && i % 3 === 0) {
      s.remove(live.shift());
    } else {
      const id = s.put(`v${i}`);
      assert.ok(!issued.has(id), `id ${id} was reused — ids must be globally unique for all time`);
      issued.add(id);
      live.push(id);
    }
  }
  // a snapshot/restore mid-churn must not reset the high-water mark
  const wire = snapshot(s);
  const back = restore(wire, createStore);
  const afterRestore = back.put('tail');
  assert.ok(!issued.has(afterRestore), `id ${afterRestore} collided after restore — the counter was not preserved`);
}

// ── edges: a malformed wire is rejected; missing ids behave, not throw ──
{
  assert.throws(() => restore('not-a-snapshot', createStore), 'restore must reject a payload without the wire tag');
  assert.throws(() => restore('SSv2|{}', createStore), 'restore must reject the wrong wire version');
  const api = createApi(createStore());
  assert.equal(api.read(999), undefined, 'reading a missing id returns undefined, not a throw');
  assert.equal(api.delete(999), false, 'deleting a missing id returns false, not a throw');
}

console.log('held-out integration gate: ok — assembled system honours every cross-cutting contract');
