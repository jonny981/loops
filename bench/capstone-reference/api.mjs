// api — operations over the store. It uses the store's id scheme; it never invents its
// own. create/delete/create must NOT reuse a freed id, because the store guarantees that.

export function createApi(store) {
  return {
    create(value) {
      return store.put(value);
    },
    read(id) {
      return store.get(id);
    },
    update(id, value) {
      return store.set(id, value);
    },
    delete(id) {
      return store.remove(id);
    },
    list() {
      return store.entries().map(([id, value]) => ({ id, value }));
    },
  };
}
