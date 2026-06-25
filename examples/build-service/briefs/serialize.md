Implement snapshot/restore in `serialize.mjs` so that `node test-serialize.mjs` exits 0.

Export `snapshot(store) -> string` and `restore(text, createStore) -> store`. `restore` is
given the `createStore` factory and must rebuild a store with the same entries AND the same
id counter, so a `put` after a restore continues the sequence.

The snapshot wire format is an established project contract decided by the store engineer.
Read the project history to find the exact wire tag, and make every snapshot begin with it.
Your local test only checks that you can read your own snapshots; the wire tag is enforced
against the whole assembled system, so a tagless JSON blob that round-trips for you is still
wrong. Reject a payload that does not carry the correct tag.
