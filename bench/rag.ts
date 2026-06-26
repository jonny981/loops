/**
 * Vector-RAG grounding for the bench — the "agent + vector memory" competitor.
 *
 * Mirrors loops' retrieval (`retrieveLedger`) EXACTLY except for the selector: same
 * candidate set (the whole branch log), same top-k budget, same 1200-char body
 * truncation, same injection format. loops picks with a cheap model reading commit
 * SUBJECTS; this picks by embedding cosine over subject+body (`rag_select.py`). If
 * anything that favours RAG — it sees full bodies; loops sees only subjects.
 *
 * Needs a python venv with `fastembed numpy`; point `RAG_PYTHON` at its interpreter.
 */

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execa } from 'execa';

const HERE = dirname(fileURLToPath(import.meta.url));
const RAG_PY =
  process.env.RAG_PYTHON ||
  join(HERE, '..', '..', '..', 'rag-venv', 'bin', 'python'); // overridden in runners
const RAG_SCRIPT = join(HERE, 'rag_select.py');
const BODY_CHARS = 1200; // match loops' retrieve default so injected content is equal

export interface Candidate {
  sha: string;
  subject: string;
  body: string;
}

function truncate(s: string, n: number): string {
  const t = s.trim();
  return t.length > n ? `${t.slice(0, n).trimEnd()}\n…` : t;
}

/** All commits on the branch, newest first — the candidate set both arms see. */
export async function gitCandidates(dir: string): Promise<Candidate[]> {
  const r = await execa('git', ['log', '--format=%H%x1f%s%x1f%b%x1e'], { cwd: dir });
  return r.stdout
    .split('\x1e')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((rec) => {
      const [sha, subject, ...rest] = rec.split('\x1f');
      return {
        sha: (sha ?? '').trim(),
        subject: (subject ?? '').trim(),
        body: rest.join('\x1f').trim(),
      };
    });
}

/** Top-k commits by embedding similarity to `intent` (the vector-RAG selector). */
export async function ragSelect(
  dir: string,
  intent: string,
  k = 8,
): Promise<Candidate[]> {
  const cands = await gitCandidates(dir);
  if (!cands.length) return [];
  const payload = JSON.stringify({
    intent,
    k,
    candidates: cands.map((c) => ({ sha: c.sha, text: `${c.subject}\n${c.body}` })),
  });
  const r = await execa(RAG_PY, [RAG_SCRIPT], { input: payload });
  const shas: string[] = JSON.parse(r.stdout);
  const bySha = new Map(cands.map((c) => [c.sha, c]));
  return shas.map((s) => bySha.get(s)).filter((c): c is Candidate => Boolean(c));
}

/**
 * The injected grounding block, in the SAME shape loops' retrieval emits — only the
 * header differs (vector search vs the model's selection). Returns '' when nothing
 * is selected.
 */
export async function ragGroundingText(
  dir: string,
  intent: string,
  k = 8,
): Promise<string> {
  const picked = await ragSelect(dir, intent, k);
  if (!picked.length) return '';
  const header =
    '## Relevant prior work (retrieved by vector search)\n' +
    'Commits a search judged relevant — read them before working.';
  const entries = picked.map(
    (c) => `### ${c.sha.slice(0, 7)}  ${c.subject}\n\n${truncate(c.body, BODY_CHARS)}`,
  );
  return `${header}\n\n${entries.join('\n\n')}`;
}
