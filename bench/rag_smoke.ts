/**
 * Offline smoke for the vector-RAG selector: build a contract-task repo buried under
 * 300 noise commits, then check whether RAG surfaces the load-bearing foundation
 * commit in its top-8 for each node. No claude-cli — validates selection only.
 *
 *   RAG_PYTHON=/path/to/rag-venv/bin/python npx tsx bench/rag_smoke.ts
 */
import { cpSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execa } from 'execa';

import { addNoise } from './noise.ts';
import { ragSelect } from './rag.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const TASK_DIR = join(HERE, 'graph-tasks/stable-store-contract');
const NOISE = Number(process.env.BENCH_NOISE ?? 300);
const NOISE_SIZE = Number(process.env.BENCH_NOISE_SIZE ?? 3500);

interface Task {
  foundation_why: string;
  nodes: { name: string; prompt: string }[];
}
const task = JSON.parse(readFileSync(join(TASK_DIR, 'task.json'), 'utf8')) as Task;

async function main(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'rag-smoke-'));
  const git = (args: string[], input?: string) =>
    execa('git', args, { cwd: dir, input, stdin: input === undefined ? 'ignore' : undefined });
  cpSync(join(TASK_DIR, 'seed'), dir, { recursive: true });
  await git(['init', '-q']);
  await git(['config', 'user.email', 'x@x']);
  await git(['config', 'user.name', 'x']);
  await git(['add', '-A']);
  await git(['commit', '-q', '-F', '-'], task.foundation_why);
  const foundationSha = (await git(['rev-parse', 'HEAD'])).stdout.trim();
  await addNoise(dir, NOISE, NOISE_SIZE);

  console.log(`RAG selector smoke · ${NOISE} noise commits · foundation ${foundationSha.slice(0, 7)}`);
  console.log(`foundation subject: ${task.foundation_why.split('\n')[0]}\n`);
  for (const node of task.nodes) {
    const picked = await ragSelect(dir, node.prompt, 8);
    const rank = picked.findIndex((c) => c.sha === foundationSha);
    console.log(
      `${node.name.padEnd(10)} foundation in top-8? ${rank >= 0 ? `YES (rank ${rank + 1})` : 'NO'}` +
        `\n   picked: ${picked.map((c) => c.subject.slice(0, 38)).join(' | ')}`,
    );
  }
  rmSync(dir, { recursive: true, force: true });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
