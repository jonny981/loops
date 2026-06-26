// serialize — snapshot/restore. The wire format MUST begin with the exact tag the store
// contract mandates: `SSv1|`. A deployed client identifies the format by that prefix and
// rejects anything else, so plain JSON (however self-consistent) is wrong on the wire.
//
// restore preserves BOTH the entries and the counter, so ids minted after a restore
// continue the sequence and never collide with a restored id.

const TAG = 'SSv1|';

export function snapshot(store) {
  return TAG + JSON.stringify({ counter: store.counter(), entries: store.entries() });
}

export function restore(text, createStore) {
  if (typeof text !== 'string' || !text.startsWith(TAG))
    throw new Error('bad snapshot: missing SSv1| wire tag');
  const { counter, entries } = JSON.parse(text.slice(TAG.length));
  return createStore({ counter, entries });
}
