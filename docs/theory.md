# Theory notes — iterate, depend, judge

The README's claims, with their receipts. Everything here is checkable; nothing here is required to use the library.

## The theorem

The [structured program theorem](https://en.wikipedia.org/wiki/Structured_program_theorem) — Böhm & Jacopini, *"Flow Diagrams, Turing Machines and Languages with Only Two Formation Rules"*, Communications of the ACM 9(5), 1966 — shows that any computable control flow can be built from three structures: sequence, selection, and iteration. The theorem proved the reduction *possible*; the argument that it was *necessary* came two years later, in Dijkstra's [*"Go To Statement Considered Harmful"*](https://en.wikipedia.org/wiki/Considered_harmful) (CACM, 1968): people reason poorly about processes evolving in time, so a program's text must map cleanly onto its behaviour — which arbitrary jumps destroy. The theorem is the license; the letter is the motive. Together they are the charter under structured programming.

Two honest footnotes, for the careful reader:

- The original proof introduces auxiliary boolean variables to carry the reduction. `loops` has that state (`ctx.state`, and the workspace itself), so the analogy holds with the caveat included rather than despite it.
- The popular one-line statement is the standard reading, refined after the paper; Harel's *"On Folk Theorems"* (CACM 23(7), 1980) traces its lineage. We cite the standard reading and link the discussion.

The mapping onto `loops`: the graph carries sequence (`needs`) and selection (`when`); the loop carries iteration (`until`). One adjustment is required, and it is the library's whole point: in the theorem, selection and iteration both consume predicates the machine evaluates for free. In agent work the predicate — is it done, is it safe, is it what was asked — is the contested question, so the predicate becomes a **gate**: commands that must exit zero, judges in their own context, juries that must agree, people who must approve. Judgment is not a fourth structure. It is the predicate made honest.

## Structured cycles, not back-edges

Graph agent frameworks put cycles *in* the graph: an edge loops back over shared state, and iteration is wherever the edges happen to go — bounds, exit conditions, and stall handling are yours to add. That is the flowchart move the theorem argued out of programming: a back-edge is `goto`.

`loops` makes the opposite choice. The graph is acyclic, always. Iteration lives in one named construct — `loop()` — which arrives with its gate (`until`), its caps (`max`, `maxReviewRestarts`), its meter (`budget`), and its stall detector (`noProgress`). Cycles are `while`, not `goto`: declared, bounded, and inspectable.

Be precise about the kind of win this is: not capability. A graph with back-edges is Turing complete; so was `goto`. The structured program theorem never gave programmers new power — it gave them programs that people and tools could reason about, and that was enough to retire flowcharts. The claim here is the same one, re-run: the same computations, but the shape of the run is knowable before it starts.

## Turing completeness

Yes — on three levels, and the asymmetry is the design.

1. **Trivially.** A `Job` is an arbitrary async function. Every workflow library embedded in a real language is Turing complete this way; it says nothing.
2. **At the combinator level, genuinely.** `max` is optional, so `loop({ until })` is a true while-loop. `ctx.state` is unbounded shared state. A loop whose body only increments and decrements two counters, gated by `predicate` tests for zero, is a two-counter machine — and two-counter machines are Turing complete. The orchestration language clears the bar on its own.
3. **Asymmetrically, on purpose.** The graph layer adds no unbounded behaviour of its own: it is acyclic, kickbacks are bounded by `maxKickbacks`, and it terminates whenever its nodes do. That is why the graph is analyzable — `loops validate` prints a pipeline's shape before a token is spent, and `assertGraph` pins it in a test — in ways arbitrary control flow provably cannot be. All unbounded computation is quarantined in the loop, the one construct fitted with brakes.

Turing complete where it must be, decidable where it can be.

## Halting, and why the brakes exist

Completeness has a price: "will this pipeline terminate?" is undecidable in general — that is the halting problem, and no framework escapes it. `loops` does not pretend to. `max`, `budget`, and `noProgress` are three independent hard stops precisely because a proof of termination cannot exist. The brakes are the engineering answer to a mathematical impossibility, not caution for its own sake.
