---
name: supervise-loop-run
description: Use when an agent needs to observe, monitor, or supervise a running loops job from another process: discover live runs, read a run's state and shape, stream its events, inspect the decisions it made (dispatch/completion/surfacing/revision), or decide whether to intervene. Load this when watching a long run or supervising several at once. Requires the run to have been started with `--supervise`.
---

# Supervising a loop run

A run started with `loops run <file> --supervise` registers itself under `~/.loops/runs/<runId>/` and writes its live state, raw events (`events.jsonl`), and semantic decisions (`semantic.jsonl`) there as it goes. Another process reads those files with no daemon and no socket: the filesystem is the channel. Every command below is read-only; supervising never touches the run.

```bash
loops run build.loop.ts --supervise   # in one terminal (or backgrounded)
```

## The loop: list → status → tail → records → decide

**`loops list`** (alias `ls`) discovers runs. Each line is the runId, state (`running` / `dead` / a terminal status like `pass`/`fail`/`paused`), current iteration, age, and title. A run whose process is gone is marked `dead`.

**`loops status <runId>`** prints a point-in-time snapshot: terminal-or-live state, the loop's shape, the last gate verdict (which gate, met, confidence, reason), the last outcome, and token usage. Use this to answer where a run stands and whether it is healthy.

**`loops tail <runId>`** streams the raw event log live (Ctrl-C to stop). It ends on its own when the run reaches a terminal status or its process disappears. Use this to watch a turn unfold.

**`loops records <runId>`** is the **primary agent API**: the semantic decision stream, one line per meaningful thing the run decided. This is what an agent reads to reason about a run, not the raw `--json` event firehose. Five kinds:

| kind | meaning |
| --- | --- |
| `dispatch` | a job or dag-node started |
| `completion` | a job / loop / dag finished (carries the outcome status + summary) |
| `surfacing` | a review or kickback raised feedback (carries severity + reason) |
| `revision-emitted` | an outcome asked for another pass |
| `revision-routed` | that revision was routed to a target (accepted/rejected) |

Filter it down for a machine-readable slice:

```bash
loops records <runId> --json                                  # everything, as JSONL
loops records <runId> --kind completion                       # just what finished
loops records <runId> --kind revision                         # both revision kinds (emitted + routed)
loops records <runId> --path ship/implementation --json       # only this subtree of the loop tree
loops records <runId> --kind surfacing --since 2026-07-01T09:00:00Z
loops records <runId> --last 20                               # the most recent 20 matching records
```

`--path` is a slash-separated prefix over the record's position in the loop tree. `--kind revision` is the convenience union of `revision-emitted` and `revision-routed`.

## Deciding what to do next

Read `records` (and `status` for tokens/gate) to choose an action, since loops does not act for you:

- **Converged**: a top-level `completion` with `status: pass`. Done; nothing to do.
- **Stuck in review**: repeated `surfacing` / `revision-routed` on the same node with a `block`/`should-fix` severity and the iteration climbing toward its cap. The gate is doing its job or the worker cannot satisfy it; inspect the reason and decide whether to let it run, abort, or (if you drive the run) route different feedback.
- **Dead**: `list` shows `dead`, or `status` says the process is gone with no terminal outcome. The run crashed or was killed; investigate its last `completion`/event.
- **Budget-bound**: `status` shows tokens near the run's budget; expect a `paused` outcome next.

## Build your own supervisor

The read side is on the public surface, so an agent supervising a fleet (killing the ones that drift, watching the ones mid-revision) reads the same files programmatically:

```ts
import { listRuns, readRunStatus, runEventsPath, runSemanticRecordsPath } from '@loops-adk/core';
```

`listRuns()` and `readRunStatus(runId)` mirror `list`/`status`; `runEventsPath`/`runSemanticRecordsPath` locate the two JSONL streams to read directly. `semanticRecordsFromEvent(event)` derives the semantic records from a raw event if you tail the event stream yourself.

To author or shape the run you are supervising, see `skills/author-loop/SKILL.md`; to compose the agent team inside it, see `skills/design-agent-team/SKILL.md`.
