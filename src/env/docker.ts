/**
 * `dockerEnvironment` — a local environment via Docker Compose, a thin preset
 * over `commandEnvironment`. The compose project name is the stage (a slug of
 * the branch), so concurrent worktree-teams get isolated stacks that never
 * collide. `docker compose -p <stage> up -d` on up; the service's published host
 * port is discovered with `docker compose -p <stage> port` and turned into a
 * URL; `docker compose -p <stage> down -v` on down.
 *
 * Publish the service to an EPHEMERAL host port in the compose file (e.g.
 * `ports: ["3000"]`) so parallel branches do not fight over a fixed port — the
 * adapter discovers whichever port Docker assigned. No dependency: it shells out
 * to the `docker` CLI on PATH.
 */

import type { Workspace } from '../core/types.ts';
import type { Environment } from './environment.ts';
import { commandEnvironment } from './command.ts';

export interface DockerEnvConfig {
  /** Dir containing the compose file. Default: the workspace dir. */
  cwd?: (ws: Workspace) => string;
  /** Compose project name (isolates per-branch stacks). Default slug(branch). */
  project?: (ws: Workspace) => string;
  /** Service whose published port becomes the URL. */
  service: string;
  /** The container port to resolve to a host port (e.g. 3000). */
  port: number;
  /** Build the URL from the discovered `host:port`. Default `http://<hostPort>`. */
  url?: (hostPort: string) => string;
  /** Extra env injected alongside `BASE_URL`. */
  env?: Record<string, string>;
  /** The docker binary. Default 'docker'. */
  binary?: string;
  /** Compose subcommand argv. Default `['compose']`; e.g. `['compose','-f','x.yml']`. */
  composeArgs?: string[];
  timeoutMs?: number;
}

export function dockerEnvironment(config: DockerEnvConfig): Environment {
  const bin = config.binary ?? 'docker';
  const compose = config.composeArgs ?? ['compose'];
  const argv = (project: string, ...rest: string[]) => ({
    cmd: bin,
    args: [...compose, '-p', project, ...rest],
  });

  return commandEnvironment({
    name: 'docker',
    cwd: config.cwd,
    stage: config.project,
    deploy: (p) => argv(p, 'up', '-d'),
    outputs: (p) => argv(p, 'port', config.service, String(config.port)),
    destroy: (p) => argv(p, 'down', '-v'),
    // `docker compose port` prints `0.0.0.0:49153` (not JSON), so read the raw
    // stdout and normalise the bind address to localhost.
    map: (_outputs, _stage, raw) => {
      const hostPort = raw.trim().split('\n')[0]?.trim();
      if (!hostPort) return {};
      const normalized = hostPort
        .replace(/^0\.0\.0\.0:/, 'localhost:')
        .replace(/^\[?::\]?:/, 'localhost:');
      const url = config.url ? config.url(normalized) : `http://${normalized}`;
      return { url, env: { BASE_URL: url, ...config.env } };
    },
    timeoutMs: config.timeoutMs,
  });
}
