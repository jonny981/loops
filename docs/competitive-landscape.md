# Competitive landscape

Where loops sits relative to the agent-memory and agent-orchestration field. Snapshot
as of mid-2026; star counts, versions, and (especially) cross-vendor benchmark numbers
drift and are contested, so treat figures as directional and check primary sources
before quoting. Inline links are primary where possible.

## The honest framing

loops has **no head-to-head measurement against any library here.** Every loops number
is its own ON−OFF ablation (see `measured-metrics.md`). This is an architectural
comparison plus competitors' published numbers, not a contest, because **no recognized
agentic-memory benchmark exists** and no competitor has run through loops' harness.

loops straddles two markets and resembles a third:
- **Agent memory** (Mem0, Letta, Zep, cognee) — but loops' memory is git, zero-infra.
- **Agent orchestration** (LangGraph, Temporal, Mastra, CrewAI) — but loops is a tiny
  source primitive with an honest convergence gate, not a server.
- **Git-as-memory** (GCC, DiffMem, and now Letta) — loops' true neighborhood.

## Memory-layer competitors

| Library | Memory model | Infra | Conflict / supersession | Headline numbers (all conversational) | Maturity |
|---|---|---|---|---|---|
| **Mem0** ([gh](https://github.com/mem0ai/mem0)) | LLM fact-extraction over a vector store; multi-signal retrieval | OpenAI LLM+embedder required; vector DB; Docker server for self-host | 2025 paper: ADD/UPDATE/DELETE/NOOP. **Current default (2026): ADD-only, accumulate** | LoCoMo 66–68 J (paper) / 91.6–92.5 (vendor page). Defensible claim is **efficiency** (~10× fewer tokens), not accuracy: its own full-context baseline (73) beats it (68) | $24M Series A, ~59.5k★, v2.0.8. **AWS Agent SDK exclusive memory provider** |
| **Letta** (MemGPT) ([gh](https://github.com/letta-ai/letta)) | Core/archival memory blocks, agent-self-edited; **2026: git-backed "Context Repositories"** ([blog](https://www.letta.com/blog/context-repositories/)) | Heaviest: server + Postgres+pgvector + embedder, REST :8283 | Block overwrite; MemFS uses **git merge + LLM conflict resolution** across worktrees | LoCoMo 74% (their filesystem agent, beats Mem0 68.5%); terminal-bench 42.5% (agentic) | $10M seed (Felicis), ~23.5k★ |
| **Zep** (Graphiti) ([gh](https://github.com/getzep/graphiti)) | **Temporal knowledge graph**, bi-temporal model | Server + graph DB (Neo4j/FalkorDB) + embedder | **Bi-temporal edge invalidation** — superseded facts marked invalid, not deleted; query "true now" vs "true then". The field's most-developed supersession story | LongMemEval 71.2% (temporal +38.4%); DMR 94.8% | Graphiti ~28k★; OSS server sunset; funding uncertain |
| **cognee** ([gh](https://github.com/topoteretes/cognee)) | KG + vector (ECL pipeline), 3 stores | Light default (SQLite+LanceDB+Kuzu, no server) but embeddings required | Additive; content-hash dedup, **no semantic contradiction detection** | Self-run HotPotQA subset only | $7.5M seed, ~22.6k★ |

**Cross-cutting fact:** none of these treats the git commit log as the memory substrate.
Every one builds and queries a **separate index** (vector and/or graph) with opaque
artifacts. Letta's 2026 git pivot is the one convergent move, but it is a *separate* git
repo of projected memory files bolted onto a server, not "the work's own history is the
memory."

## Orchestration / durable-loop frameworks

LangGraph, Temporal (durable execution), Mastra, Inngest, CrewAI, AutoGen. These model
agent loops/graphs and persist state, but:
- They **defer memory** to a layer above (or use basic vector recall).
- They decide "done" by the model stopping or a human gate, **not** by an honest
  convergence check (deterministic signal + separate judge + quorum). loops' gate is the
  differentiator here.
- Temporal/LangGraph are far more mature on durability, retries, observability, and
  production multi-agent scale. loops deliberately punts durable mid-run replay ("embed a
  loops job inside Temporal/LangGraph if you need it").

## Git-as-memory neighbors (loops' true peers)

| System | What it is | Verified evidence |
|---|---|---|
| **GCC** (Git Context Controller) ([arXiv 2508.00031](https://arxiv.org/abs/2508.00031)) | Context manager with COMMIT/BRANCH/MERGE ops | **SWE-bench Verified: 80.2% with full GCC vs 67.2% no-structured-memory = +13.0pp same-scaffold** (N=500). The quoted +6.2pp is vs the Folding-Agent *competitor* at 74.0%, not a memory-off baseline. The strongest published number in the lane |
| **DiffMem** ([gh](https://github.com/Growth-Kinetics/DiffMem)) | Git + markdown memory; `grep`/`git log`/`git diff` retrieval; "no vector DB, no embeddings, just git and an LLM" | loops' **closest engineering twin** — but **unbenchmarked** (no published numbers) |
| **Letta MemFS** | Git-backed Context Repositories + worktrees (above) | The canonical memory company adopting git-as-memory; independent validation of the direction |

## Why there is no head-to-head

The benchmark landscape is fragmented and ~6–9 months old:
- **Conversational** benchmarks (LoCoMo, LongMemEval, DMR) are what memory products cite —
  and are a different axis from loops. The most-cited (LoCoMo) is small (10 conversations),
  has a ~6.4% corrupt answer key ([audit](https://dev.to/penfieldlabs/we-audited-locomo-64-of-the-answer-key-is-wrong-and-the-judge-accepts-up-to-63-of-intentionally-33lg)),
  a lenient judge (~63% of wrong answers accepted), and is **beaten by a no-memory
  full-context baseline**. Cross-vendor scores are openly disputed (Mem0 vs Zep).
- **Agentic** memory benchmarks are new and unconsolidated: MemoryArena (ICML 2026,
  [arXiv 2602.16313](https://arxiv.org/abs/2602.16313), the LoCoMo-falsification result),
  STATE-Bench ([Microsoft](https://opensource.microsoft.com/blog/2026/05/19/introducing-state-bench-a-benchmark-for-ai-agent-memory/)),
  MemoryAgentBench ([arXiv 2507.05257](https://arxiv.org/abs/2507.05257)), AMA-Bench,
  Mem2ActBench. None is dominant.
- **Coding-agent memory specifically has no recognized benchmark.** CodeSOTA lists memory
  as "pending, not scored." The closest is **SWE-ContextBench**
  ([arXiv 2602.08316](https://arxiv.org/abs/2602.08316), cross-task experience reuse on
  SWE-bench Lite, +8pp with oracle selection).

The field's own consensus across these (ReasoningBank, SWE-ContextBench, the controlled
coding pilot) matches loops' own data: **memory's agentic value is efficiency and
consistency, not raw quality**, concentrated on hard/long-horizon work.

## Where loops wins / loses / is unproven

**Wins (architectural, real):**
- Zero infrastructure — git is the index; nothing to embed, sync, or let go stale. No
  competitor is git-native at the level of "the work's own commit log is the memory."
- Targets the agentic axis the memory field avoids measuring.
- Honest convergence gate (deterministic + judge + quorum), which no orchestration
  framework has.
- A primitive, not a platform: nestable loop/dag, consumed as a source import.
- Unusually honest measurement (openly reports ceilings, a non-replicating draw, noise).

**Loses (real):**
- **Supersession is loops' weakest area.** Zep's bi-temporal invalidation is a genuine
  engineered capability loops has no answer for; `bench/supersede.ts` exists but has **no
  committed results** — unmeasured.
- No product, no managed offering, alpha, tiny noisy benchmarks (n=6–18, haiku).
- Orchestration maturity (durability, observability, scale) lags Temporal/LangGraph.

**Unproven:**
- The read at scale: recent-N grounding fails on a noisy log (0/6); retrieval rescues it
  (83%) but does **not beat a naive full-log dump** (100%) at the tested 16-commit scale.
  The capability claim over brute-force dump needs the dump-infeasible regime (hundreds of
  commits), untested.

## The fairest venues for a real head-to-head

Ranked for a defensible cross-library claim:
1. **SWE-bench Verified, GCC's exact same-scaffold protocol** (full N=500, not Lite) — puts
   loops directly next to the one neighbor with a real number (+13.0pp).
2. **MemoryArena** — agentic, multi-session, interdependent, memory-system-agnostic; the
   de-facto front-runner; matches loops' "memory must change the next action" premise.
3. **STATE-Bench** — explicitly tests "does the agent improve with experience" (loops'
   thesis) with deterministic state assertions (no LLM-judge noise).
4. **A supersession test with committed results** (the `supersede.ts` design) — where Zep's
   invalidation should win and loops should struggle; run it and report honestly.

## Bottom line

loops occupies genuinely uncontested ground — git-commit-log-as-memory, zero-infra, aimed
at agentic completion — and Letta's MemFS pivot plus GCC's SWE-bench result are independent
evidence the direction is sound. But the advantage today is **architectural and ergonomic,
not a measured capability win**: at small scale a naive log-dump matches it, and on the one
axis the field engineered hardest (temporal supersession) loops is behind and unmeasured.
The honest claim is not "loops beats Mem0/Zep" (different axes) but **"the memory field
optimizes conversational recall with mandatory infra; loops makes a different, infra-free
bet on agentic memory that no one has benchmarked yet."** Closing that gap means building
the agentic-memory benchmark that does not exist, and matching GCC's rigor on Verified.
