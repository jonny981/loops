// A tiny in-memory store. `snapshot()` is NOT implemented here — a later step adds
// it, and must honour the snapshot conventions the project accrued across its
// history (each decided in a prior commit's why, not visible in this code).
let items = [];
let nextId = 1;

export function add(value) {
  const id = nextId++;
  items.push({ id, value });
  return id;
}

export function get(id) {
  const found = items.find((it) => it.id === id);
  return found ? found.value : undefined;
}

export function remove(id) {
  items = items.filter((it) => it.id !== id);
}

export function all() {
  return items.slice();
}

// Internal accessors the exporter can build on.
export function _items() {
  return items.slice();
}
export function _gen() {
  return nextId - 1; // highest id ever issued
}

export function _reset() {
  items = [];
  nextId = 1;
}
