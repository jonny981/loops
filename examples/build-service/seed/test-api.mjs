// api contract — the convergence gate for the api engineer.
// Exit 0 = the api delegates to the store's id scheme (no id reuse) and exposes CRUD + list.
import assert from 'node:assert/strict';
import { createStore } from './store.mjs';
import { createApi } from './api.mjs';

const api = createApi(createStore());
const a = api.create('alpha');
const b = api.create('beta');
assert.equal(a, 1);
assert.equal(b, 2);
assert.equal(api.read(b), 'beta');

assert.equal(api.update(b, 'BETA'), true);
assert.equal(api.read(b), 'BETA');
assert.equal(api.update(404, 'x'), false, 'update on a missing id returns false');

assert.equal(api.delete(a), true);
assert.equal(api.read(a), undefined, 'a deleted record reads as undefined');

// The api must use the store's stable ids — a create after a delete does not reuse id 1.
const c = api.create('gamma');
assert.equal(c, 3, 'create after delete mints a fresh id, never reuses 1');

assert.deepEqual(
  api.list().sort((x, y) => x.id - y.id),
  [
    { id: 2, value: 'BETA' },
    { id: 3, value: 'gamma' },
  ],
  'list returns the live records as {id, value}',
);

console.log('api: ok');
