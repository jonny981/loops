/**
 * The human gate — a deliberate pause only a person can lift. `humanGate(config)`
 * returns a `Job`: acknowledged ⇒ `pass`; not ⇒ it emits a `human:gate` event
 * and returns `paused`, which the composites (`loop()`, `dag()`, and
 * `tournament()`) propagate to the root, so the run stops (exit code 75) with
 * a surfaced prompt and a resume hint. This is the runtime half of
 * `AgentDef.humanGates` — an `AgentHumanGate` is structurally a
 * `HumanGateConfig`, so `humanGate(def.humanGates[0])` works.
 *
 * The acknowledgement lives in `ctx.state` — the ONLY thing a checkpoint
 * persists (`persist.ts` snapshots `{ts, state}`). Resume re-executes the whole
 * job from the top ("the workspace is the state"), so the gate is idempotent:
 * on the resumed pass the seeded ack makes it return `pass`. Everything before
 * the gate re-runs unless the recipe guards it (`when` conditions / state
 * markers); that is the library's documented resume model, not a gap.
 */

import type { Job, JobContext, Outcome } from './types.ts';
import { setMeta } from './describe.ts';
import { LoopError } from './errors.ts';
import { fnJob } from './job.ts';

export interface HumanGateConfig {
  /**
   * Stable gate name, such as `prod-approval`; the ack key derives from it.
   * Must be a slug (letter/digit first, then `A-Za-z0-9._:-`) — the name is
   * pasted into a shell as `--ack <name>` in the printed resume command.
   */
  name: string;
  /**
   * Surfaced when the gate pauses (the `human:gate` event, the paused
   * outcome's summary). Default: `description`, else a generic line.
   */
  prompt?: string;
  description?: string;
  /** Carried over from `AgentHumanGate`; metadata only (a dag node's `when` is the runtime gate). */
  when?: string;
  /**
   * Custom acknowledgement check (e.g. a marker file exists); replaces the
   * default `ctx.state[humanGateKey(name)] === true` lookup. A custom ack
   * bypasses the state/checkpoint mechanism — it owns its own durability.
   */
  ack?: (ctx: JobContext) => boolean | Promise<boolean>;
}

// The safe-slug charset for gate names. The name flows into the `--ack <name>`
// hint the user pastes into a shell, so anything outside this set (`;`, `$(`,
// backticks…) is an injection vector once gate definitions arrive as data
// rather than code. Enforced at the writer (`humanGateKey`, below) and
// re-checked at the reader (`pausedHumanGate`): the `{humanGate, prompt}`
// outcome-data contract is public, so a name can arrive in raw outcome data —
// e.g. from a custom `outcome` mapper parsing model text — without ever
// passing through the constructor.
const GATE_NAME = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;

/**
 * The `ctx.state` key a gate's acknowledgement lives under — the same key the
 * CLI's `--ack <name>` seeds. Kept as one function so the gate and the ack
 * path can never drift apart.
 */
export function humanGateKey(name: string): string {
  if (!name?.trim())
    throw new LoopError({
      code: 'CONFIG',
      message: 'humanGate requires a non-blank gate name',
    });
  if (!GATE_NAME.test(name))
    throw new LoopError({
      code: 'CONFIG',
      message:
        `humanGate name "${name}" must be a slug (letter/digit first, then ` +
        'letters, digits, ".", "_", ":" or "-") — it is pasted into a shell ' +
        'as --ack <name>',
    });
  return `humanGate:${name}`;
}

/**
 * A gate only a person can lift. Acknowledged ⇒ `pass`. Not acknowledged ⇒
 * emits `human:gate` and returns `paused` with `data: { humanGate, prompt }` —
 * the contract the CLI reads to append `--ack <name>` to the resume hint.
 *
 * Acknowledgement: `config.ack` when given, else
 * `ctx.state[humanGateKey(name)] === true` — seeded by `--ack <name>`, a
 * `state` seed, or an earlier job writing the key; a pause's checkpoint
 * carries it across the process boundary.
 */
export function humanGate(config: HumanGateConfig): Job {
  const name = config.name;
  const key = humanGateKey(name); // validates the name at construction
  const prompt =
    config.prompt ??
    config.description ??
    `human gate "${name}" requires acknowledgement`;

  // fnJob supplies the job:start/job:end envelope and the user-code guard:
  // a throwing custom `ack` becomes a `fail` outcome (with an error event),
  // never a crash.
  const job = fnJob(`human-gate "${name}"`, async (ctx) => {
    const acked = config.ack ? await config.ack(ctx) : ctx.state[key] === true;
    if (acked)
      return { status: 'pass', summary: `human gate "${name}" acknowledged` };
    ctx.emit({
      kind: 'human:gate',
      ts: Date.now(),
      path: [...ctx.path],
      name,
      prompt,
      resumeCommand: ctx.resumeCommand,
    });
    return {
      status: 'paused',
      summary: prompt,
      data: { humanGate: name, prompt },
    };
  });

  // Override fnJob's `fn` meta so `loops describe` renders `human-gate "name"`.
  return setMeta(job, { kind: 'human-gate', name });
}

/**
 * The reader half of the gate's `{ humanGate, prompt }` outcome-data contract
 * (the writer is `humanGate()` above; co-located so they can never drift).
 * `loop()` finishes with the gate's own outcome intact, but `dag()` replaces
 * `data` with its node-results map, so the contract may sit at any nesting
 * depth — this follows paused sub-outcomes down to the gate. Returns the gate
 * name, or `undefined` when the pause is not a human gate (a limit pause).
 *
 * Only a `GATE_NAME` slug is returned: the name is pasted into a shell as
 * `--ack <name>` in the printed resume hint, and outcome data is a public
 * contract that need not have passed the constructor's validation — a
 * non-slug name falls back to the generic guidance instead of the hint.
 */
export function pausedHumanGate(outcome: Outcome): string | undefined {
  return findGateName(outcome);
}

/** The recursive walk, on `unknown`: nested values are outcome-shaped by
 *  convention (a dag's node-results map), not by type — narrow, don't cast. */
function findGateName(value: unknown): string | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const { status, data } = value as { status?: unknown; data?: unknown };
  if (status !== 'paused') return undefined;
  if (!data || typeof data !== 'object') return undefined;
  const gate = (data as { humanGate?: unknown }).humanGate;
  if (typeof gate === 'string' && GATE_NAME.test(gate)) return gate;
  for (const nested of Object.values(data)) {
    const name = findGateName(nested);
    if (name) return name;
  }
  return undefined;
}
