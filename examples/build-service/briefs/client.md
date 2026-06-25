Implement the client in `client.mjs` so that `node test-client.mjs` exits 0.

Export `createClient()` returning an object with: `api() -> api`, `snapshot() -> string`,
`restore(text) -> void`. Wire an `api` over a `store`, snapshot through the serializer, and on
restore rebuild the store and re-bind the api to it.

You sit downstream of every other component — read the project history and honour their
contracts together: the api surface, the exact snapshot wire tag, and id stability with
counter preservation across a round-trip. A snapshot then restore must return an identical
system: same records, same ids, the id sequence resuming where it left off.
