Implement the storage engine in `store.mjs` so that `node test-store.mjs` exits 0.

Export `createStore(initial)` returning an object with: `put(value) -> id`, `get(id)`,
`has(id)`, `set(id, value) -> bool`, `remove(id) -> bool`, `ids() -> id[]`,
`entries() -> [id, value][]`, `count() -> number`, `counter() -> number`. `initial` is
optional and has the shape `{ counter, entries }` (entries is an array of `[id, value]` pairs).

Ids come from a monotonic counter and are never reused after a remove. The counter is part of
the state so it can be snapshotted. In your commit message, record the id rule and the exact
snapshot wire tag `SSv1|` as binding project decisions — the serialize and client engineers
will rely on them.
