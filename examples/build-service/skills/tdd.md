Work test-first. A failing test in `test-<component>.mjs` already defines done for you.

- Run the test before you change anything, so you see exactly what it expects.
- Implement the smallest change that turns it green. No speculative surface, no options nobody asked for.
- Run it again after every edit. Do not declare a component finished until `node test-<component>.mjs` exits 0.
- When the test passes, stop adding code. More is not better here.
