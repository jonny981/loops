/**
 * Print the benchmark evidence in a plain comparison format.
 *
 * This does not run agents. It is the front door for readers who need to know
 * what Loops was compared against, what happened, and what can be claimed.
 *
 *   npm run bench:compare
 */
import { writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');

interface Evidence {
  id: string;
  question: string;
  comparison: string;
  result: string;
  plainRead: string;
  limit: string;
  reproduce: string[];
}

export const EVIDENCE: Evidence[] = [
  {
    id: 'rule-of-thumb',
    question: 'When should Loops help?',
    comparison: 'One-shot work versus work that crosses context boundaries.',
    result: 'One-shot tasks show no lift. Boundary-heavy tasks are where the lift appears.',
    plainRead:
      'Loops is not trying to make a single agent smarter in one prompt. It is trying to make separate fresh contexts inherit verified engineering reasons from git.',
    limit:
      'If the model can solve the task in one attempt, Loops mostly adds cost.',
    reproduce: ['open bench/RESULTS.md'],
  },
  {
    id: 'graph-contract',
    question: 'Can Loops carry an upstream decision across agent nodes?',
    comparison: 'Loops ON versus Loops OFF on the same hidden contract graph.',
    result: 'OFF 0/10, ON 9/10, lift +90pp.',
    plainRead:
      'The downstream agent needed an exact wire tag that lived only in an upstream commit body. Without grounded memory it never found it. With Loops it usually applied it.',
    limit:
      'This is a synthetic contract task. It proves the mechanism cleanly, not broad real-world frequency.',
    reproduce: [
      'BENCH_ENGINE=claude-cli BENCH_MODEL=haiku BENCH_GRAPH_TASK=graph-tasks/stable-store-contract BENCH_TRIALS=10 BENCH_OUT=bench/results-graph-contract.json npm run bench:graph',
      'npm run bench:report -- bench/results-graph-contract.json',
    ],
  },
  {
    id: 'vanilla-orchestrator',
    question: 'Is Loops better than a simple non-Loops orchestrator?',
    comparison: 'Raw CLI agents with no memory and raw CLI agents with the full git log pasted in.',
    result: 'No memory 0/10, naive git dump 10/10, Loops 9/10 on the small contract task.',
    plainRead:
      'On a tiny one-commit history, just pasting the git log is a very strong baseline. Loops does not beat it there. Loops makes the memory path automatic and bounded.',
    limit:
      'The decisive capability test is when the log is too large to paste, not this tiny-log case.',
    reproduce: [
      'BENCH_ENGINE=claude-cli BENCH_MODEL=haiku BENCH_MODE=nomem BENCH_TRIALS=10 npx tsx bench/baseline.ts',
      'BENCH_ENGINE=claude-cli BENCH_MODEL=haiku BENCH_MODE=gitdump BENCH_TRIALS=10 npx tsx bench/baseline.ts',
    ],
  },
  {
    id: 'noisy-log',
    question: 'What happens when the decision is buried in history?',
    comparison: 'Loops recent-N, Loops retrieval, and raw full-log dump.',
    result: 'Recent-N 0/6, retrieval 5/6, full-log dump 6/6.',
    plainRead:
      'Loops needs the right read mode. Recent commits fail when the key decision is old. Retrieval mostly recovers it. Full dump still wins while the log fits.',
    limit:
      'This shows the need for retrieval. It does not yet prove retrieval beats dumping everything.',
    reproduce: [
      'BENCH_ENGINE=claude-cli BENCH_MODEL=haiku BENCH_GRAPH_TASK=graph-tasks/stable-store-contract BENCH_NOISE=15 BENCH_GROUND=retrieve BENCH_TRIALS=6 npm run bench:graph',
      'BENCH_ENGINE=claude-cli BENCH_MODEL=haiku BENCH_MODE=gitdump BENCH_NOISE=15 BENCH_TRIALS=6 npx tsx bench/baseline.ts',
    ],
  },
  {
    id: 'swebench-retry',
    question: 'Does memory help retries build instead of regress?',
    comparison: 'SWE-bench Lite requests slice, memoryless retry versus grounded retry.',
    result: 'Resolve rate OFF 50%, ON 61% on the haiku slice. Convergence delta OFF -3, ON +2.',
    plainRead:
      'The important signal is direction: grounded retries built on prior attempts, while memoryless retries tended to regress.',
    limit:
      'Small, easy local slice. The percentage-point lift is noisy and not a stable headline.',
    reproduce: [
      'BENCH_ENGINE=claude-cli BENCH_MODEL=haiku BENCH_SWE_INSTANCES=<instances.json> BENCH_K=2 npx tsx bench/swebench.ts',
      'Use the official SWE-bench harness command printed by the runner.',
    ],
  },
  {
    id: 'sweep-consistency',
    question: 'Does Loops keep a batch consistent?',
    comparison: 'Independent profile-writing batch with and without Ledger grounding.',
    result: 'ON 18/18 conforming, OFF 3/18 conforming.',
    plainRead:
      'Grounding made every independent item follow the same house format. Without it the batch drifted.',
    limit:
      'The house marker is unguessable, so this tests conformance transfer more than general coding ability.',
    reproduce: ['BENCH_ENGINE=claude-cli BENCH_MODEL=haiku BENCH_SWEEPS=3 npx tsx bench/sweep.ts'],
  },
  {
    id: 'contextbench',
    question: 'Does prior issue experience transfer to related issues?',
    comparison: 'SWE-ContextBench off, summary, and raw dump arms.',
    result: 'No separation on the local n=8 slice.',
    plainRead:
      'This is not positive evidence yet. It only proves the capture path became non-empty and ready for a scale run.',
    limit:
      'Underpowered null. The benchmark needs the larger SWE-ContextBench run before it can support a claim.',
    reproduce: [
      'npm run bench:context:dry',
      'Follow bench/contextbench/RUNBOOK.md for the scale run.',
    ],
  },
  {
    id: 'mechanism-demo',
    question: 'Can someone see the mechanism without spending tokens?',
    comparison: 'Offline MockEngine mechanism check, not a model benchmark.',
    result: 'Ungrounded replay breaks strict deployed readers. Grounded replay does not.',
    plainRead:
      'This is a teaching aid. It shows why the memory matters, without pretending to measure agent performance.',
    limit:
      'Do not cite it as agent evidence.',
    reproduce: ['npm run bench:mechanism'],
  },
];

function wrap(text: string, width = 92): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let line = '';
  for (const word of words) {
    const next = line ? `${line} ${word}` : word;
    if (next.length > width && line) {
      lines.push(line);
      line = word;
    } else {
      line = next;
    }
  }
  if (line) lines.push(line);
  return lines;
}

function section(title: string): string {
  return `\n## ${title}\n`;
}

function bullet(label: string, text: string): string {
  const [first, ...rest] = wrap(text);
  return [`- ${label}: ${first}`, ...rest.map((line) => `  ${line}`)].join('\n');
}

export function renderComparison(items: Evidence[] = EVIDENCE): string {
  const lines: string[] = [];
  lines.push('# Loops Evidence Map');
  lines.push('');
  lines.push('Plain claim: Loops helps when software work crosses context boundaries.');
  lines.push('It is a tax on easy one-shot tasks. It becomes useful when a later fresh');
  lines.push('agent context needs a verified reason that is not obvious from the files.');
  lines.push('');
  lines.push('Read this as a comparison guide, not a leaderboard.');
  lines.push('The listed numbers come from bench/RESULTS.md. Changing engine or model');
  lines.push('creates a new result set, even when the benchmark shape is the same.');

  lines.push(section('Fast Read'));
  lines.push('- Strongest signal: cross-node contract, OFF 0/10 versus ON 9/10.');
  lines.push('- Strongest baseline: raw full git-log dump matches or beats Loops while the log fits.');
  lines.push('- Most honest SWE-bench signal: grounded retries build, memoryless retries regress.');
  lines.push('- Do not claim: Loops improves one-shot tasks or beats full-log dump on tiny histories.');

  lines.push(section('Comparison Table'));
  lines.push('| ID | Compared With | Result | Plain Read |');
  lines.push('|---|---|---|---|');
  for (const item of items) {
    lines.push(
      `| ${item.id} | ${item.comparison} | ${item.result} | ${item.plainRead} |`,
    );
  }

  lines.push(section('What Each Row Means'));
  for (const item of items) {
    lines.push(`### ${item.id}`);
    lines.push(bullet('Question', item.question));
    lines.push(bullet('Comparison', item.comparison));
    lines.push(bullet('Result', item.result));
    lines.push(bullet('Plain read', item.plainRead));
    lines.push(bullet('Limit', item.limit));
    lines.push('- Reproduce:');
    for (const cmd of item.reproduce) lines.push(`  - \`${cmd}\``);
    lines.push('');
  }

  lines.push(section('Claim Boundaries'));
  lines.push('- Mechanism demo: useful for intuition, not agent evidence.');
  lines.push('- Local graph: clean memory mechanism, synthetic task.');
  lines.push('- Raw baselines: essential comparator, especially full git-log dump.');
  lines.push('- SWE-bench: real bugs and official scoring, but the local slice is small.');
  lines.push('- SWE-ContextBench: acquisition path only until a larger scored run separates arms.');
  lines.push('');
  lines.push('If a reader asks "compared to what?", the answer should be in the row above.');
  lines.push('');
  return `${lines.join('\n')}\n`;
}

function outputPath(): string | undefined {
  const out = process.env.BENCH_COMPARE_OUT;
  if (!out) return undefined;
  return isAbsolute(out) ? out : join(ROOT, out);
}

function main(): void {
  const rendered = renderComparison();
  const out = outputPath();
  if (out) {
    writeFileSync(out, rendered);
    console.log(`wrote ${out}`);
  } else {
    process.stdout.write(rendered);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
