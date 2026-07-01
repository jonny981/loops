/**
 * The pluggable execution backend. A `Step` asks an `Engine` to run one agent
 * turn with a *fresh context* and stream events back. Each call is independent —
 * that is what gives every loop iteration its clean slate.
 */

/**
 * Built-in, registry-resolvable adapter names. The union is open (`& {}` trick)
 * so callers can name and register their own engines — the core never assumes a
 * fixed provider set. (`mock` is constructed directly in tests/examples, not
 * registered by name, so it is intentionally not listed here.)
 */
export type EngineName =
  | 'agent-sdk'
  | 'claude-cli'
  | 'codex'
  | 'anthropic-api'
  | (string & {});

export interface Usage {
  inputTokens: number;
  outputTokens: number;
}

/** Tools an agent uses to spawn sub-agents / fan out. A `leaf` request disallows these. */
export const SUBAGENT_TOOLS = ['Task'];

export interface AgentRequest {
  prompt: string;
  system?: string;
  model?: string;
  maxTokens?: number;
  /** Tool allowlist, where the backend supports tools (SDK / CLI). */
  allowedTools?: string[];
  cwd?: string;
  timeoutMs?: number;
  /**
   * Forbid this agent from spawning sub-agents (fanning out). A leaf agent is told to
   * disallow the sub-agent tool (`SUBAGENT_TOOLS`), so a branch of the graph bottoms out
   * here instead of expanding into an uncontrolled swarm — control over where work stops.
   * Authoritative over `allowedTools` (a disallow wins). Engines with no sub-agent tool
   * (anthropic-api, codex, mock) ignore it.
   */
  leaf?: boolean;
}

export interface AgentResult {
  /** Final assistant text (concatenated across blocks). */
  text: string;
  usage: Usage;
  model: string;
  stopReason?: string;
  /** Backend-native final payload, for escape-hatch inspection. */
  raw?: unknown;
}

/** Streamed during a run. The runtime re-tags these as `LoopEvent`s. */
export type EngineStreamEvent =
  | { type: 'text'; delta: string }
  | { type: 'thinking'; delta: string }
  | { type: 'tool'; name: string; phase: 'use' | 'result' }
  | { type: 'usage'; usage: Usage; model: string };

export type EngineEventSink = (event: EngineStreamEvent) => void;

export interface Engine {
  readonly name: EngineName;
  /**
   * Run one fresh agent turn. Contract for the `usage` stream event: emit it
   * **exactly once, at the end** of the turn — stats sums every `usage` event,
   * so a backend that emits incremental usage mid-stream would inflate totals.
   */
  run(
    req: AgentRequest,
    onEvent: EngineEventSink,
    signal: AbortSignal,
  ): Promise<AgentResult>;
}

/**
 * Anywhere an engine can be selected, accept either a registered name or a
 * ready-made `Engine`. The latter is the "bring your own provider/framework"
 * escape hatch — the runtime treats every backend through this one interface.
 */
export type EngineRef = EngineName | Engine;

export function isEngine(ref: EngineRef | undefined): ref is Engine {
  return (
    typeof ref === 'object' &&
    ref !== null &&
    typeof (ref as Engine).run === 'function'
  );
}

/**
 * How a tool-using engine treats permission prompts. Mirrors the Claude Code
 * values. `bypassPermissions` lets a headless worker read/write/run without
 * prompting — required for an unattended agent that must touch the filesystem or
 * shell, and to be set deliberately.
 */
export type PermissionMode =
  | 'default'
  | 'acceptEdits'
  | 'bypassPermissions'
  | 'plan'
  | 'dontAsk'
  | 'auto';

/** Per-run options that the registry uses to construct engines. */
export interface EngineOptions {
  /** Default model when a request/step does not name one. */
  defaultModel?: string;
  apiKey?: string;
  /** For CLI-backed engines: path to the binary. */
  cliBinary?: string;
  /** Extra args appended to CLI-backed engine invocations. */
  cliArgs?: string[];
  /**
   * Permission mode for tool-using engines. Unset = the engine/CLI default
   * where applicable; the Codex adapter stays read-only unless explicitly set
   * to `bypassPermissions`.
   */
  permissionMode?: PermissionMode;
}
