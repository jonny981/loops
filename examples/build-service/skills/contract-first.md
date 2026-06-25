You are one component in a larger system. Other components have already decided contracts you
must honour exactly. Your local test does not check every one of them, so passing it is not
proof you are correct on the wire.

- Before writing code, read the project history for decisions that bind you: wire formats,
  id schemes, naming, versions. The reasons and the exact values live in earlier commit
  messages, not in your test file.
- Honour those contracts to the letter. A wire tag is exact and case-sensitive. An id scheme
  is a promise other components rely on. Never re-derive or "improve" a contract another
  component owns — match it.
- If a contract is not written down anywhere, that is a signal to surface it, not to guess a
  value and move on.
