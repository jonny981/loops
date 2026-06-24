/**
 * `sstEnvironment` — a per-branch sst stage as an Environment, a thin preset over
 * `commandEnvironment`. `sst deploy --stage <slug(branch)>` on up,
 * `sst remove --stage …` on down. Each worktree-team gets its own stage named
 * after its branch — the personal-stack convention, generalised per-branch.
 *
 * The exact sst flags vary by sst version, so deploy/outputs/destroy are all
 * overridable, and the CONSUMER supplies `map` (which output is the URL / how
 * outputs become env vars) since the output shape is app-specific. By default no
 * outputs are read (the deploy still runs); set `outputs` + `map` to surface a
 * URL. This adds no dependency — it shells out to the `sst` CLI on PATH.
 */

import type { Workspace } from '../core/types.ts';
import type { Environment } from './environment.ts';
import { commandEnvironment, type Cmd } from './command.ts';

export interface SstEnvConfig {
  /** App dir (where sst.config.ts lives). Default: the workspace dir. */
  cwd?: (ws: Workspace) => string;
  /** Stage name. Default: a slug of the workspace branch. */
  stage?: (ws: Workspace) => string;
  /** Override the deploy command. Default: `sst deploy --stage <stage>`. */
  deploy?: (stage: string, ws: Workspace) => Cmd;
  /** Command to read outputs as JSON. Omitted by default (version-specific). */
  outputs?: (stage: string, ws: Workspace) => Cmd;
  /** Override the destroy command. Default: `sst remove --stage <stage>`. */
  destroy?: (stage: string, ws: Workspace) => Cmd;
  /** Map outputs → { url, env }. Required to surface a URL to the gate. */
  map?: (
    outputs: Record<string, unknown>,
    stage: string,
    raw: string,
  ) => { url?: string; env?: Record<string, string> };
  /** The sst binary. Default 'sst'. */
  binary?: string;
  timeoutMs?: number;
}

export function sstEnvironment(config: SstEnvConfig = {}): Environment {
  const bin = config.binary ?? 'sst';
  return commandEnvironment({
    name: 'sst',
    cwd: config.cwd,
    stage: config.stage,
    deploy:
      config.deploy ??
      ((stage) => ({ cmd: bin, args: ['deploy', '--stage', stage] })),
    outputs: config.outputs,
    destroy:
      config.destroy ??
      ((stage) => ({ cmd: bin, args: ['remove', '--stage', stage] })),
    map: config.map,
    timeoutMs: config.timeoutMs,
  });
}
