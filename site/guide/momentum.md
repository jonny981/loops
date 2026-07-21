# Momentum

**Momentum is the rate at which gated work crystallizes from the frontier into the immutable past.** It is not activity. A graph can be furiously busy — spinning, retrying, re-litigating — and have zero momentum. A unit of momentum is a completion that survived its gate: a dag node landing `pass` (fresh work — not a checkpoint restore, not a skipped `when`), or a loop converging. It cannot be faked, because every counted unit is an auditable event welded to real work.

## The state taxonomy

| State | Frontier | Crystallization | Meaning |
|---|---|---|---|
| `alive` | active | flowing | work is passing the gates and landing |
| `idle` | quiet | zero, legitimately | potential energy — a polling loop watching the world |
| `stalled` | active | zero | the pathological case: motion without momentum (the `noProgress` detector tripped) |
| `done` | empty | — | the run ended; nothing more is coming without a steer |

A loop stops when it has no momentum. `done` is the only honest stop — and it is a *dynamic* condition: not "is the list empty" but "is anything still crystallizing, and is anyone still steering".

## Reading it

Every supervised run reports momentum:

```bash
$ loops status <runId>
...
  momentum: alive — 5 crystallized (2.4/h), 2 steers
```

Programmatically, `momentumFromEvents` folds any event stream (or a tail of one) into a report, and `MomentumTracker` is the same fold fed incrementally — one definition of momentum for every consumer:

```ts
import { momentumFromEvents } from '@loops-adk/core';

const report = momentumFromEvents(events, { status: 'running' });
// { state: 'alive', crystallized: 5, steers: 2, stalls: 0,
//   lastCrystallizedAt: 1718000000000, ratePerHour: 2.4 }
```

The numbers stay honest by construction: checkpoint restores, skipped nodes, and refused steers never count, and a rate is only reported over a meaningful span (≥ one minute) — never extrapolated from a seconds-wide burst.

## Over HTTP

A run with a [listener](/guide/webhooks) serves its momentum on the same port that ingests force, so the system emitting webhooks can see whether they landed:

```bash
$ curl -H "Authorization: Bearer $TOKEN" http://127.0.0.1:8787/momentum
{"runId":"sprint-4f2a1c","momentum":{"state":"alive","crystallized":5,...}}
```

The gateway (`loops listen`) serves the same read for every supervised run at `GET /runs/<runId>/momentum`.

## Steering is force

Left alone, a plan's momentum decays monotonically to zero as the frontier drains — the run completes. A steer refills the future, and the system lives on. The mechanical model is a stick spinning a wheel: **contact is intermittent, and the system is autonomous between contacts.** A steer is a discrete impulse applied at a safepoint; between impulses the graph runs entirely on the plan it has. Steering is cheap, occasional, and recorded — never a hand resting on the wheel.
