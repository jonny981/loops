# build-service — an engineering team, defined as files

The recipe is [`../build-service.loop.ts`](../build-service.loop.ts). It composes four
specialist agents into a `dag` that builds a small service (a storage engine, an api over it,
a snapshot serializer, and a client that wires the stack). Run it:

```bash
loops run examples/build-service.loop.ts
```

## The idea

Each component is a Converge `loop` driven by one specialist, and a component is "done" only
when its deterministic test passes **and** an adversarial panel across three models fails to
refute it. A single agent grades its own homework; this team converges past an independent,
multi-model review it never applies to itself. The cross-cutting contracts — stable, never
reused ids and the exact `SSv1|` snapshot wire tag — are decided by `store` and carried to the
engineers downstream of it through grounding (the Ledger), not repeated in every brief.

## Layout

```
agents/    one markdown persona per specialist (store / api / serialize / client + reviewer)
skills/    shared methodologies folded into each agent's system (tdd, contract-first, adversarial-review)
briefs/    the per-component task each engineer receives
seed/      the starting workspace: package.json + the per-component tests the engineers converge on
```

`agents/` and `skills/` are markdown; the typed `AgentDef` wrappers live in the recipe. The
per-component tests in `seed/` check local correctness; the cross-cutting contracts (the exact
wire tag, id stability under churn) are enforced by a held-out integration gate the engineers
never see at build time.
