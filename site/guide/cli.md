# The CLI

Everything the library does is operable from the `loops` binary.

## Author and run

| Command | Purpose |
|---|---|
| `loops run <file>` | execute a `.loop.ts` definition (default TUI; `--no-tui` for plain lines, `--json` for NDJSON) |
| `loops validate <file>` | offline pre-flight: load and construct the job, catching syntax/import/export errors with fix-oriented messages — nothing runs |
| `loops describe <file>` | print the job's introspected shape (`--json` for machines) |
| `loops preflight` | one tiny live turn per engine lane, classified |
| `loops init` | scaffold a recipe |
| `loops helm` | the conversational harness: a driver model turns your messages into authored recipes, validations, and dispatched supervised runs |

Key `run` flags:

```bash
loops run build.loop.ts \
  --supervise            # register in ~/.loops/runs so other processes can observe/command it
  --run-id my-build      # assign the registry id up front
  --listen 8787          # open the HTTP listener (webhooks in, momentum out)
  --checkpoint .loops/cp.json --resume .loops/cp.json   # durable pause/resume
  --budget 2m            # token budget
  --on-limit auto        # limit policy: auto | wait | exit-resume | fail
  --ack prod-approval    # lift a named human gate on resume
```

## Observe

| Command | Purpose |
|---|---|
| `loops list` | every supervised run: state, iteration, age |
| `loops status <runId>` | live state: stage, gate, momentum, blocker, shape (`--recent N` for the event tail) |
| `loops tail <runId>` | stream the run's events live |
| `loops records <runId>` | the semantic decision stream (dispatches, completions, revisions), filterable |

## Command

| Command | Purpose |
|---|---|
| `loops control <runId> pause` | pause at the next safepoint — resumable, exit 75 |
| `loops control <runId> abort` | stop the run |
| `loops steer <runId> '<edits>'` | apply an atomic edit batch to the run's live plan |
| `loops listen` | the webhook gateway: one port fronting every supervised run |

Steer edits are JSON — the same vocabulary as the API:

```bash
loops steer my-build '[
  {"op":"add","name":"fix-9","template":"fix","params":{"issue":9},"priority":5},
  {"op":"cancel","name":"refactor","graceMs":300000},
  {"op":"rewire","name":"integrate","needs":["fix-9"]}
]'
```

Control commands only reach a **live** run: the CLI refuses targets that do not exist, already ended, or whose process is gone, and a resumed run never replays old commands.

## Exit codes

`0` pass · `1` fail · `2` exhausted · `75` paused (resumable — the printed guidance includes the exact resume command) · `130` aborted.
