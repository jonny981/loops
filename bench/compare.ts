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
      'Loops is not trying to make a single agent smarter in one prompt. It is trying to make separate fresh contexts inherit verified engineering reasons from git, including the path of decisions that got the repo here.',
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
      'The downstream agent needed an exact wire tag that lived only in an upstream commit body. Loops helped because its gated write layer created the reasoning thread, then its grounding layer let the next agent pull on it.',
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
      'On a tiny one-commit history, pasting the whole git log is a useful sanity check. It is not a credible operating mode for a repo with significant history. It also assumes the log already contains useful reasoning. Loops enforces that write side.',
    limit:
      'Full-log dump becomes context rot and cost on real project history. Treat it as a toy upper bound, not a product baseline.',
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
      'Loops needs the right read mode. Recent commits fail when the key decision is old. Retrieval mostly recovers it. Full dump still wins on 16 commits because 16 commits is not a real history.',
    limit:
      'This shows the need for retrieval. It also shows why the dump baseline has to be made dump-infeasible before it means anything for lived-in repos.',
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
  lines.push('# Loops: The First-Sight Proof');
  lines.push('');
  lines.push('An agent graph had to preserve one upstream decision: snapshots must start');
  lines.push('with the exact wire tag `SSv1|`. That decision lived only in a git commit');
  lines.push('body. It was not in the source files, not in the task prompt, and not in');
  lines.push('the downstream agent context.');
  lines.push('');
  lines.push('That commit was more than a remembered fact. It was the thread back through');
  lines.push('the journey: what was decided, why it was decided, and what later agents had');
  lines.push('to keep honouring.');
  lines.push('');
  lines.push('| Runner | What it could read | Result |');
  lines.push('|---|---|---|');
  lines.push('| Memoryless graph | files plus task prompt | 0/10 preserved the contract |');
  lines.push('| Loops Ledger | gated commit bodies plus grounding | 9/10 preserved the contract |');
  lines.push('| Raw git dump | full git log pasted into every prompt | 10/10 on a toy log, not a real-repo operating mode |');
  lines.push('');
  lines.push('Plain read: Loops is not magic memory and it is not just `git log`.');
  lines.push('It is the deterministic enforcement layer that makes agents write useful');
  lines.push('commit bodies when work converges, then the grounding layer that reads those');
  lines.push('verified reasons back into later fresh contexts. The value is not bare');
  lines.push('recall: a fresh agent can pull on one thread and reconstruct how and why the');
  lines.push('repository got here. Full-log dump is a sanity check on tiny histories, but');
  lines.push('on a repo with significant history it is context rot and cost. Loops exists');
  lines.push('for that lived-in repo case.');

  lines.push(section('Fast Read'));
  lines.push('- Core claim: agents should not remember chats. Repositories should remember verified work and why it exists.');
  lines.push('- Differentiator: Loops writes the reasoning journey through gated milestone commits, then reads it back.');
  lines.push('- Strongest signal: cross-node contract, OFF 0/10 versus ON 9/10.');
  lines.push('- Strongest sanity check: raw full git-log dump matches or beats Loops while the log is tiny.');
  lines.push('- Most honest SWE-bench signal: grounded retries build, memoryless retries regress.');
  lines.push('- Do not claim: Loops beats full-log dump on toy histories.');
  lines.push('- Do claim: full-log dump is not a serious operating mode for significant repos.');
  lines.push('- Source: the listed numbers come from bench/RESULTS.md. Changing engine or model creates a new result set.');

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
  lines.push('- Raw baselines: essential sanity checks, but full git-log dump is intentionally unrealistic on lived-in repos.');
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
