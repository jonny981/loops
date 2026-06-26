// client — round-trips through the whole stack: an api over a store, snapshots via
// serialize, restores back into a fresh store. It must match the api surface AND carry
// the store's wire tag + id stability across a snapshot/restore.

import { createStore } from './store.mjs';
import { createApi } from './api.mjs';
import { snapshot, restore } from './serialize.mjs';

export function createClient() {
  let store = createStore();
  let api = createApi(store);
  return {
    api() {
      return api;
    },
    snapshot() {
      return snapshot(store);
    },
    restore(text) {
      store = restore(text, createStore);
      api = createApi(store);
    },
  };
}
