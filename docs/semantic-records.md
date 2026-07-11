# Semantic run records

Supervised runs write two streams under `~/.loops/runs/<runId>/`:

- `events.jsonl` is the detailed runtime event stream. It is diagnostic and has
  no compatibility contract.
- `semantic.jsonl` is the stable run and decision stream. Every new record
  conforms to the semantic run record v1 schema.

The workspace remains the state. Semantic records describe what happened; they
do not drive replay, scheduling, or resume behavior.

## Contract

The source of truth is the strict Zod schema exported from
`@loops-adk/core`. The equivalent Draft 2020-12 artifact ships at
`@loops-adk/core/schemas/semantic-run-record-v1.schema.json` and is checked in
at [`schemas/semantic-run-record-v1.schema.json`](../schemas/semantic-run-record-v1.schema.json).

Every v1 record has this envelope:

| field | type | rule |
| --- | --- | --- |
| `schemaVersion` | `1` | Required and immutable for v1. |
| `kind` | string enum | Selects one strict record shape. |
| `ts` | non-negative integer | Epoch milliseconds. |
| `path` | string array | Position in the loop or DAG tree. Root is `[]`. |
| `runId` | string | Optional so ingress records may exist before dispatch assigns a run. Supervised runtime records include it. |
| `metadata` | JSON object | Optional extension point for data that does not change a kind's meaning. |

The kinds are:

| family | kinds |
| --- | --- |
| execution | `dispatch`, `completion`, `lifecycle-transition` |
| convergence | `gate-verdict` |
| review | `surfacing`, `revision-emitted`, `revision-routed`, `advisor-consult` |
| evidence and measurement | `proof`, `benchmark-outcome`, `cost-snapshot`, `preflight-classification` |
| bounded non-execution | `refusal`, `capability-gap` |
| coordination | `handoff`, `trigger-invocation` |

The runtime projects facts it already owns: dispatches, completions, gate
verdicts and evidence, review routing, advisor consultations, proof, pauses,
checkpoint restores, and run start or finish. Benchmark, refusal, capability
gap, handoff, trigger, cost, and preflight shapes are contracts for their owning
layers. Defining them does not add a scheduler, queue, trigger engine, or new
job type.

## Validate and query

```ts
import {
  SEMANTIC_RUN_RECORD_KINDS,
  parseSemanticRunRecord,
  readSemanticRecords,
  safeParseSemanticRunRecord,
} from '@loops-adk/core';

const records = readSemanticRecords(runId) ?? [];
const gateVerdicts = records.filter((record) => record.kind === 'gate-verdict');

const result = safeParseSemanticRunRecord(candidate);
if (!result.success) throw result.error;

const record = parseSemanticRunRecord(candidate);
console.log(record.schemaVersion, SEMANTIC_RUN_RECORD_KINDS);
```

`loops records <runId> --json` emits the validated stream as JSONL. `--kind`
accepts every schema kind plus `revision`, a query alias for both revision
kinds.

## Versioning and migration

V1 is strict. Unknown fields, kinds, enum values, and schema versions fail v1
validation. A change to a record's meaning or shape, including a new optional
field or kind, requires a new schema version. Producers may add JSON-safe
annotations under `metadata` without changing the v1 contract.

`readSemanticRecords` supports archives written by 0.7.0. It recognises only
the six unversioned kinds that release wrote: `dispatch`, `completion`,
`surfacing`, `revision-emitted`, `revision-routed`, and `proof`. The reader adds
`schemaVersion: 1` and the enclosing registry run id in memory, validates the
result, and leaves the archive unchanged. Unversioned records of any other kind
are rejected.

Versioned records never pass through the legacy adapter. A v1 record is
validated as written, and a future-version record is not interpreted as v1.
The reader skips invalid or torn JSONL lines so a damaged observation stream
cannot break the supervised run or its other records.

Run `npm run schema:write` after intentionally changing the Zod source for a
new contract. `npm run schema:check` and `prepack` fail when the checked-in JSON
artifact differs from the runtime schema.
