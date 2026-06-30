# Lessons

- 2026-06-29: When asked for a wow demo, make the user-facing consequence visible in the first screen. A hidden invariant proof is useful, but it does not create urgency unless the output shows the broken shipped state and the avoided failure.
- 2026-06-29: When a demo needs to feel large, show blast radius at the scale of the product claim. One failing replay explains the bug, but a fleet replay makes the compounding value legible.
- 2026-06-30: Avoid all-or-nothing demo numbers when they make the test feel staged. Use a mixed replay model and show the compatibility mix so the blast radius has a visible source.
- 2026-06-30: Do not call a mock mechanism demo "wow" or present it as product proof. Keep offline mechanism checks separate from live agent signal and repeated benchmarks.
- 2026-06-30: Live benchmark scripts should not have a provider default. Require `BENCH_ENGINE` so engine choice is explicit, flexible, and never silently spends the wrong account.
- 2026-06-30: Do not steer back to the issue-corpus approach after deciding to defer it. Use the existing comparison benchmarks first when the user asks how outsiders can compare Loops against other tools.
- 2026-06-30: Treat full-log dump as a toy-history sanity check, not a serious long-horizon baseline. On a repo with significant history it is context rot and cost; the proof should make that obvious.
- 2026-06-30: The Loops memory claim is not just reading `git log`; it is deterministic enforcement that creates rich commit bodies at convergence, then grounding that reads those verified reasons back.
- 2026-06-30: Frame Ledger as a trace of the agent journey, not only persisted facts. The value is that a fresh agent can pull on one thread and reconstruct what was decided, why, and how the repository reached its state.
