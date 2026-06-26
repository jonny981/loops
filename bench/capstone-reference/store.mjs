// store — the storage engine. It DECIDES the load-bearing contracts the rest of the
// system must honour:
//   1. STABLE ids. Every `put` mints a fresh positive integer from a monotonic counter.
//      A removed id is NEVER reused. (The tempting bug: `size + 1`, which reuses a freed id.)
//   2. The counter is part of the state, so a snapshot/restore can resume the sequence.
//
// This reference exists to prove the tests + the held-out gate are well-posed; it is not
// shown to the engineers.

export function createStore(initial) {
  const map = new Map(initial?.entries ?? []);
  let counter = initial?.counter ?? 0;
  return {
    put(value) {
      const id = ++counter; // monotonic — never reuses a removed id
      map.set(id, value);
      return id;
    },
    get(id) {
      return map.get(id);
    },
    has(id) {
      return map.has(id);
    },
    set(id, value) {
      if (!map.has(id)) return false; // update in place, no new id
      map.set(id, value);
      return true;
    },
    remove(id) {
      return map.delete(id);
    },
    ids() {
      return [...map.keys()];
    },
    entries() {
      return [...map.entries()];
    },
    count() {
      return map.size;
    },
    counter() {
      return counter;
    },
  };
}
