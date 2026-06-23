/**
 * Drive the Amps `/oem-research` pipeline for ONE OEM through loops.js, reusing
 * the real `oem-research-agent` / `oem-research-reflection-agent` definitions as
 * the brains. loops.js is the orchestrator: it fans out the research streams as
 * single-agent leaves (no nested dispatch), synthesises, then gates on the
 * reflection audit.
 *
 * Env:
 *   OEM        OEM name (required)
 *   REPO_ROOT  monorepo checkout the workers run in (loads .claude/*). Default cwd.
 *   OUT_DIR    where stream/record files go (default wiki/oems). Relative to REPO_ROOT.
 *   LIGHT=1    pilot mode: 2 knowledge-only streams, short timeouts (no heavy RE).
 *
 * Run (pilot):
 *   OEM=FoxESS LIGHT=1 OUT_DIR=.pilot-out REPO_ROOT=$PWD/../.. \
 *     node bin/loops.mjs run recipes/oem/oem-research.loop.ts \
 *     --no-tui --permission-mode bypassPermissions --record /tmp/oem.jsonl
 */

import { resolve } from 'node:path';

import { defineJob, sequence, parallel, gateJob } from '../../src/api.ts';
import type { Outcome } from '../../src/api.ts';
import { agentJobFromDef } from './from-def.ts';

const REPO = process.env.REPO_ROOT ?? process.cwd();
const OEM = process.env.OEM ?? 'ExampleOEM';
const OUT = process.env.OUT_DIR ?? 'wiki/oems';
const LIGHT = process.env.LIGHT === '1';
// Override the model the agent defs pin (e.g. for a fast pilot). When unset,
// each leaf uses the model from its own definition file.
const MODEL = process.env.MODEL || undefined;
const modelOverride = MODEL ? { model: MODEL } : {};

const RESEARCH = resolve(REPO, '.claude/agents/oem-research-agent.md');
const REFLECTION = resolve(
  REPO,
  '.claude/agents/oem-research-reflection-agent.md',
);

const FULL_STREAMS = [
  ['1.1', 'baseline'],
  ['1.2', 'portal-re'],
  ['1.3', 'public-sources'],
  ['1.4', 'mobile-re'],
  ['1.5', 'security-audit'],
  ['1.6', 'commercial'],
  ['1.7', 'access-probe'],
] as const;

const STREAMS = LIGHT
  ? ([
      ['1.1', 'baseline'],
      ['1.3', 'public-sources'],
    ] as const)
  : FULL_STREAMS;

const timeoutMs = LIGHT ? 180_000 : 1_200_000;

const streamPrompt = ([id, name]: readonly [string, string]) =>
  LIGHT
    ? `OEM: ${OEM}. You are running ONLY research stream ${id} (${name}) in LIGHT pilot mode. ` +
      `Produce a concise 5-bullet ${name} summary for ${OEM} from your own knowledge (no web needed). ` +
      `Write it to ${OUT}/${OEM}/research/${name}.md (create dirs). Report one sentence on what you wrote. ` +
      `Do NOT dispatch sub-agents — run this stream inline.`
    : `OEM: ${OEM}. Run ONLY research stream ${id} (${name}) of the playbook for ${OEM}. ` +
      `Write this stream's output under ${OUT}/${OEM}/research/. ` +
      `Do NOT dispatch sub-agents — run this stream inline.`;

// Reflection runs the real reflection agent (it reads the record itself) and
// ends with a machine-readable verdict line that we gate on. A `fail` stops the
// sequence — the convergence gate the pipeline already enforces.
const reflectionGate = gateJob(
  'reflection',
  // gateJob lifts a Condition; here we wrap an agent worker as a predicate via
  // a tiny inline condition that runs the reflection job and reads its verdict.
  async (ctx) => {
    const job = agentJobFromDef(
      REFLECTION,
      `Audit the ${OEM} research record under ${OUT}/${OEM}/. Read the files that exist. ` +
        `Be strict. End your reply with exactly one line: "VERDICT: PASS" or "VERDICT: CONCERNS".`,
      { label: `${OEM}:reflection`, cwd: REPO, timeoutMs, ...modelOverride },
    );
    const outcome: Outcome = await job(ctx);
    const text =
      typeof outcome.data === 'string' ? outcome.data : (outcome.summary ?? '');
    const met = /VERDICT:\s*PASS/i.test(text);
    return {
      met,
      reason: met ? 'reflection PASS' : 'reflection CONCERNS (or no verdict)',
    };
  },
);

export default defineJob(
  sequence(
    `research-${OEM}`,
    parallel(
      `streams-${OEM}`,
      STREAMS.map(([id, name]) =>
        agentJobFromDef(RESEARCH, streamPrompt([id, name]), {
          label: `${OEM}:${name}`,
          cwd: REPO,
          timeoutMs,
          ...modelOverride,
        }),
      ),
      LIGHT ? 2 : 3,
    ),
    agentJobFromDef(
      RESEARCH,
      `OEM: ${OEM}. The research streams are written under ${OUT}/${OEM}/research/. ` +
        `Read them and write a concise synthesis to ${OUT}/${OEM}/${OEM}.md. ` +
        `Report a one-paragraph synthesis summary. Do NOT dispatch sub-agents.`,
      { label: `${OEM}:synthesise`, cwd: REPO, timeoutMs, ...modelOverride },
    ),
    reflectionGate,
  ),
);
