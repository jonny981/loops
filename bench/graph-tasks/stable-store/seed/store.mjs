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

export function all() {
  return items.map((it) => it.value);
}

export function _reset() {
  items = [];
  nextId = 1;
}
