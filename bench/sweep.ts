/**
 * Sweep A/B — does the Ledger keep a BATCH of independent tasks consistent?
 *
 * Converge loops retry one task to a gate (ab.ts/swebench.ts). A Sweep is the
 * other archetype: a long-running job where each iteration is a FRESH, independent
 * task — research OEM A, then OEM B, then OEM C — and the value of memory is not
 * "avoid my dead ends" but "transfer the house style: do it the way the earlier
 * items established." The metric is therefore CONSISTENCY/CONFORMANCE across the
 * batch, not a pass/fail gate.
 *
 * The task: write a profile doc for each of N items. A house style (an exact
 * format with an unguessable `profile:v2` marker) lives ONLY in a seed commit's
 * body — never in the working tree — so only grounding surfaces it. ON grounds
 * each item in the style commit + the accumulating prior docs; OFF sees only the
 * files and re-invents a structure each time. Conformance = the doc matches the
 * house style. The lift is ON's conformance over OFF's.
 *
 * NOT offline: drives real claude-cli. Fresh repo per sweep.
 *
 *   BENCH_SWEEPS=3 BENCH_MODEL=haiku npx tsx bench/sweep.ts
 */

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execa } from 'execa';

import { run, sequence, agentJob, commitJob, type Job } from '../src/api.ts';

const SWEEPS = Number(process.env.BENCH_SWEEPS ?? 3);
const MODEL = process.env.BENCH_MODEL || undefined;
const ENGINE = 'claude-cli';

type Arm = 'off' | 'on';

const ITEMS: { slug: string; name: string; blurb: string }[] = [
  { slug: 'helios-grid', name: 'Helios Grid', blurb: 'a solar string-inverter manufacturer' },
  { slug: 'vortex-mobility', name: 'Vortex Mobility', blurb: 'a public EV charging network operator' },
  { slug: 'cumulus-cells', name: 'Cumulus Cells', blurb: 'a residential battery storage startup' },
  { slug: 'a28-thermal', name: 'A28 Thermal', blurb: 'a heat-pump and HVAC controls vendor' },
  { slug: 'borealis-meters', name: 'Borealis Meters', blurb: 'a smart electricity meter maker' },
  { slug: 'tessell-wind', name: 'Tessell Wind', blurb: 'a small-scale wind turbine supplier' },
];

/** The house style — lives ONLY in the seed commit body, never in the work tree. */
const HOUSE_STYLE =
  `docs(style): house style for profile docs (profile:v2)\n\n` +
  `## Why\n` +
  `Every profile doc in this catalog follows ONE house format so the catalog is ` +
  `machine-parseable and consistent. The downstream importer depends on it. Match ` +
  `it exactly for every profile you write.\n\n` +
  `## The format (mandatory, exact)\n` +
  `- The FIRST line of the file must be exactly: <!-- profile:v2 -->\n` +
  `- Then these three sections, in THIS order, with these exact headings:\n` +
  `  ## Summary    — one short paragraph.\n` +
  `  ## Key facts  — a markdown table (rows of | a | b |).\n` +
  `  ## Risk       — one short paragraph on the main risk.\n` +
  `Do not add other top-level (##) sections, reorder them, or omit the marker. ` +
  `Untagged or restructured docs are rejected by the importer.`;

interface DocResult {
  position: number;
  marker: boolean;
  sections: boolean;
  table: boolean;
  conforming: boolean;
}

/** Score a profile doc against the house style. Objective, no fuzzy judge. */
function conformance(doc: string, position: number): DocResult {
  const marker = doc.split('\n')[0]?.trim() === '<!-- profile:v2 -->';
  const s = doc.indexOf('## Summary');
  const k = doc.indexOf('## Key facts');
  const r = doc.indexOf('## Risk');
  const sections = s >= 0 && k > s && r > k;
  const keyFacts = sections ? doc.slice(k, r) : '';
  const table = /\|.*\|/.test(keyFacts);
  return { position, marker, sections, table, conforming: marker && sections && table };
}

async function prepareRepo(): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), `loops-sweep-`));
  const git = (args: string[], input?: string) =>
    execa('git', args, { cwd: dir, input, stdin: input === undefined ? 'ignore' : undefined });
  await git(['init', '-q']);
  await git(['config', 'user.email', 'bench@loops.local']);
  await git(['config', 'user.name', 'loops bench']);
  // An innocuous index in the work tree; the house style is in the COMMIT BODY only.
  await execa('bash', ['-c', 'printf "# Profile catalog\\n" > catalog.md'], { cwd: dir });
  await git(['add', '-A']);
  await git(['commit', '-q', '-F', '-'], HOUSE_STYLE);
  return dir;
}

/** One sweep: a fresh independent doc-writing task per item, in order. */
function sweepJob(arm: Arm): Job {
  const steps: Job[] = [];
  for (const item of ITEMS) {
    steps.push(
      agentJob({
        label: item.slug,
        ground: arm === 'on', // ON sees the house style + prior docs; OFF re-invents
        prompt:
          `Write a profile document for ${item.name} (${item.blurb}) in the file ` +
          `${item.slug}.md. Invent plausible details.`,
        outcome: (text) => ({ status: 'pass', summary: text.slice(0, 120) }),
      }),
    );
    steps.push(commitJob({ subject: `docs(profile): ${item.slug}` }));
  }
  return sequence('sweep', ...steps);
}

async function runSweep(arm: Arm): Promise<DocResult[]> {
  const dir = await prepareRepo();
  try {
    await run(sweepJob(arm), {
      cwd: dir,
      engine: ENGINE,
      engineOptions: { permissionMode: 'bypassPermissions', defaultModel: MODEL },
    });
    return ITEMS.map((item, i) => {
      let doc = '';
      try {
        doc = readFileSync(join(dir, `${item.slug}.md`), 'utf8');
      } catch {
        /* the agent never wrote the file */
      }
      return conformance(doc, i);
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const rate = (xs: DocResult[], k: keyof DocResult) =>
  xs.length ? (xs.filter((x) => x[k]).length / xs.length) * 100 : 0;

async function main(): Promise<void> {
  console.log(
    `Sweep A/B — ${ITEMS.length} profile docs × ${SWEEPS} sweep(s), model ${MODEL ?? '(cli default)'}\n` +
      `house style (profile:v2 marker + Summary/Key facts table/Risk) lives ONLY in the seed commit`,
  );

  const results: Record<Arm, DocResult[]> = { off: [], on: [] };
  for (const arm of ['off', 'on'] as Arm[]) {
    for (let s = 0; s < SWEEPS; s++) {
      process.stdout.write(`  ${arm.toUpperCase().padEnd(3)} sweep ${s + 1}/${SWEEPS} … `);
      const docs = await runSweep(arm);
      results[arm].push(...docs);
      console.log(`${docs.filter((d) => d.conforming).length}/${docs.length} conform`);
    }
  }

  console.log('\n— conformance across the batch —');
  for (const arm of ['off', 'on'] as Arm[]) {
    const xs = results[arm];
    console.log(
      `${arm.toUpperCase()}  conforming ${rate(xs, 'conforming').toFixed(0)}%  ` +
        `(marker ${rate(xs, 'marker').toFixed(0)}% · sections ${rate(xs, 'sections').toFixed(0)}% · table ${rate(xs, 'table').toFixed(0)}%)  n=${xs.length}`,
    );
  }
  const off = rate(results.off, 'conforming');
  const on = rate(results.on, 'conforming');
  console.log(`\nON − OFF conformance: ${on >= off ? '+' : ''}${(on - off).toFixed(0)}pp`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
