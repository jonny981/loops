Implement the operation layer in `api.mjs` so that `node test-api.mjs` exits 0.

Export `createApi(store)` returning an object with: `create(value) -> id`, `read(id)`,
`update(id, value) -> bool`, `delete(id) -> bool`, `list() -> { id, value }[]`.

Delegate to the store the store engineer already built (`store.mjs`) — read its decisions in
the project history. Use its id scheme rather than inventing your own: a `create` after a
`delete` must mint a fresh id, never recycle the freed one. A read or delete of a missing id
returns undefined / false, not an exception.
