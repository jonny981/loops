/**
 * The webhook listener — force over HTTP (docs/momentum.md). The file-based
 * control channel accepts commands from a person at a terminal; this listener
 * accepts them from the world: any webhook (an issue opened, an incident
 * fired, a deploy finished) can be ingested, validated, filtered, and routed
 * into the same three commands — `steer`, `pause`, `abort` — that every other
 * control surface uses. The same port serves the read side back: `/momentum`
 * reports whether the run is alive, so the system emitting force can also see
 * whether it landed.
 *
 * Two deployment shapes, one implementation:
 *
 *   - **In-run** (`RunOptions.listen` / `loops run --listen`): the run process
 *     itself listens. A recipe supplies `route` — the validate/filter/map
 *     step that turns a raw webhook body into a `ControlCommand` (or drops
 *     it) — so arbitrary payload shapes (GitHub, PagerDuty, a cron) become
 *     steers without the sender knowing anything about loops.
 *   - **Gateway** (`loops listen`): one standalone port fronting every
 *     supervised run on the machine, writing through the registry's file
 *     channel (`requestControl`). Senders that can shape their own payloads
 *     POST command envelopes to `/runs/<runId>/control`.
 *
 * Fail-closed defaults: binds 127.0.0.1; with a `token`, every request but
 * `/healthz` must carry `Authorization: Bearer <token>` (constant-time
 * compare); bodies are capped; malformed JSON, unknown commands, and a
 * throwing `route` are 4xx/5xx responses, never a crash and never a
 * dispatched half-command. `webhookSignatureValid` is the HMAC helper for
 * verifying provider signatures (e.g. GitHub `X-Hub-Signature-256`) inside a
 * `route`.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createHmac, timingSafeEqual } from 'node:crypto';

import { LoopError } from '../core/errors.ts';
import {
  requestControl,
  type ControlCommand,
} from './control.ts';
import { readRunProgress, readRunStatus, listRuns } from './supervisor.ts';

const DEFAULT_MAX_BODY_BYTES = 256 * 1024;
const RUN_ID = /^[a-z0-9][a-z0-9-]*$/;

/** What a `route` function receives: the raw request, ready to validate. */
export interface WebhookRequest {
  method: string;
  path: string;
  headers: Record<string, string | string[] | undefined>;
  /** The raw body, exactly as received — what an HMAC signature signs. */
  body: string;
  /** The body parsed as JSON, or undefined when it is not valid JSON. */
  json(): unknown;
}

/**
 * The validate/filter/route step: turn a webhook into a command, or drop it
 * (return undefined → 204, ingested but filtered). Throwing refuses the
 * request (400) and dispatches nothing.
 */
export type WebhookRoute = (
  request: WebhookRequest,
) => ControlCommand | undefined | Promise<ControlCommand | undefined>;

export interface WebhookListenerOptions {
  /** Port to bind; 0 picks an ephemeral one (reported back). */
  port: number;
  /** Bind address. Default 127.0.0.1 — exposing wider is a deliberate act. */
  host?: string;
  /**
   * Bearer token required on every request except `/healthz`. Strongly
   * advised on any non-loopback host.
   */
  token?: string;
  /** Reject bodies larger than this. Default 256 KiB. */
  maxBodyBytes?: number;
  /** The webhook router for POSTs to any path outside the built-ins. */
  route?: WebhookRoute;
}

export interface WebhookListener {
  port: number;
  close(): Promise<void>;
}

/** Constant-time bearer check; a missing or malformed header never matches. */
function bearerOk(header: string | string[] | undefined, token: string): boolean {
  if (typeof header !== 'string') return false;
  const prefix = 'Bearer ';
  if (!header.startsWith(prefix)) return false;
  const presented = Buffer.from(header.slice(prefix.length));
  const expected = Buffer.from(token);
  return (
    presented.length === expected.length && timingSafeEqual(presented, expected)
  );
}

/**
 * Verify a provider HMAC signature over the raw body — the standard webhook
 * authenticity scheme (GitHub `X-Hub-Signature-256`, Stripe, ...). Use inside
 * a `route`:
 *
 *   if (!webhookSignatureValid({ body: req.body,
 *     signature: req.headers['x-hub-signature-256'], secret })) return undefined;
 */
export function webhookSignatureValid(input: {
  body: string;
  signature: string | string[] | undefined;
  secret: string;
  /** Digest algorithm. Default sha256. */
  algorithm?: string;
  /** Header prefix before the hex digest. Default `sha256=`. */
  prefix?: string;
}): boolean {
  if (typeof input.signature !== 'string') return false;
  const algorithm = input.algorithm ?? 'sha256';
  const prefix = input.prefix ?? `${algorithm}=`;
  if (!input.signature.startsWith(prefix)) return false;
  const presented = Buffer.from(input.signature.slice(prefix.length), 'hex');
  const expected = createHmac(algorithm, input.secret)
    .update(input.body)
    .digest();
  return (
    presented.length === expected.length && timingSafeEqual(presented, expected)
  );
}

function isControlCommand(value: unknown): value is ControlCommand {
  return (
    !!value &&
    typeof value === 'object' &&
    ((value as ControlCommand).cmd === 'pause' ||
      (value as ControlCommand).cmd === 'abort' ||
      (value as ControlCommand).cmd === 'steer')
  );
}

function send(res: ServerResponse, status: number, body?: unknown): void {
  const payload = body === undefined ? '' : `${JSON.stringify(body)}\n`;
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(payload);
}

function readBody(
  req: IncomingMessage,
  maxBytes: number,
): Promise<string | undefined> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let overflowed = false;
    req.on('data', (chunk: Buffer) => {
      if (overflowed) return; // keep draining (unbuffered) so the 413 can flush
      size += chunk.length;
      if (size > maxBytes) {
        overflowed = true;
        chunks.length = 0;
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      resolve(overflowed ? undefined : Buffer.concat(chunks).toString('utf8'));
    });
    req.on('error', () => resolve(undefined));
  });
}

function listen(server: Server, port: number, host: string): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      const address = server.address();
      resolve(typeof address === 'object' && address ? address.port : port);
    });
  });
}

function closer(server: Server): () => Promise<void> {
  return () =>
    new Promise((resolve) => {
      server.close(() => resolve());
      // Idle keep-alive sockets must not pin the close.
      server.closeAllConnections?.();
    });
}

/**
 * The in-run listener. `dispatch` receives every accepted command — the same
 * handler the file channel feeds — and `momentum` serves the live read.
 */
export async function startWebhookListener(
  options: WebhookListenerOptions & {
    dispatch: (command: ControlCommand, origin: string) => void;
    momentum?: () => unknown;
  },
): Promise<WebhookListener> {
  const maxBody = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  const server = createServer(async (req, res) => {
    try {
      const path = (req.url ?? '/').split('?')[0]!;
      if (path === '/healthz') return send(res, 200, { ok: true });
      if (options.token && !bearerOk(req.headers.authorization, options.token))
        return send(res, 401, { error: 'unauthorized' });

      if (req.method === 'GET' && path === '/momentum')
        return send(res, 200, options.momentum ? options.momentum() : {});

      if (req.method !== 'POST')
        return send(res, 404, { error: `no ${req.method} ${path}` });

      const body = await readBody(req, maxBody);
      if (body === undefined)
        return send(res, 413, { error: `body over ${maxBody} bytes` });

      if (path === '/control') {
        let parsed: unknown;
        try {
          parsed = JSON.parse(body);
        } catch {
          return send(res, 400, { error: 'body is not valid JSON' });
        }
        if (!isControlCommand(parsed))
          return send(res, 400, {
            error: 'body must be a command: {"cmd":"pause"|"abort"|"steer",...}',
          });
        options.dispatch(parsed, 'http:/control');
        return send(res, 202, { ok: true, cmd: parsed.cmd });
      }

      if (options.route) {
        const request: WebhookRequest = {
          method: req.method,
          path,
          headers: req.headers,
          body,
          json: () => {
            try {
              return JSON.parse(body);
            } catch {
              return undefined;
            }
          },
        };
        let command: ControlCommand | undefined;
        try {
          command = await options.route(request);
        } catch (e) {
          // A throwing route refuses the request — never a dispatched
          // half-command, never a crashed listener.
          return send(res, 400, {
            error: `route refused: ${e instanceof Error ? e.message : String(e)}`,
          });
        }
        if (command === undefined) return send(res, 204);
        if (!isControlCommand(command))
          return send(res, 500, { error: 'route returned a non-command' });
        options.dispatch(command, `http:${path}`);
        return send(res, 202, { ok: true, cmd: command.cmd });
      }

      return send(res, 404, { error: `no route for ${path}` });
    } catch (e) {
      send(res, 500, {
        error: e instanceof Error ? e.message : String(e),
      });
    }
  });
  server.requestTimeout = 30_000;
  const port = await listen(
    server,
    options.port,
    options.host ?? '127.0.0.1',
  );
  server.unref();
  return { port, close: closer(server) };
}

/**
 * The standalone gateway: one port fronting every supervised run on the
 * machine, writing through the registry's file channel. For senders that can
 * shape their own payloads:
 *
 *   POST /runs/<runId>/control   — a command envelope for that run
 *   GET  /runs/<runId>/momentum  — that run's momentum read
 *   GET  /runs                   — the run list (id, status, title)
 *
 * Commands are refused for runs that do not exist, ended, or whose process
 * is gone — the same live-run rule the CLI enforces.
 */
export async function startRegistryGateway(
  options: WebhookListenerOptions,
): Promise<WebhookListener> {
  const maxBody = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  const server = createServer(async (req, res) => {
    try {
      const path = (req.url ?? '/').split('?')[0]!;
      if (path === '/healthz') return send(res, 200, { ok: true });
      if (options.token && !bearerOk(req.headers.authorization, options.token))
        return send(res, 401, { error: 'unauthorized' });

      if (req.method === 'GET' && path === '/runs')
        return send(
          res,
          200,
          listRuns().map((r) => ({
            runId: r.runId,
            status: r.status,
            alive: r.alive,
            title: r.title,
          })),
        );

      const match = path.match(/^\/runs\/([^/]+)\/(control|momentum)$/);
      if (!match) return send(res, 404, { error: `no route for ${path}` });
      const [, runId, kind] = match as unknown as [string, string, 'control' | 'momentum'];
      if (!RUN_ID.test(runId))
        return send(res, 400, { error: 'invalid runId' });

      if (kind === 'momentum') {
        if (req.method !== 'GET')
          return send(res, 404, { error: `no ${req.method} ${path}` });
        const progress = readRunProgress(runId, { recent: 0 });
        if (!progress) return send(res, 404, { error: `no run "${runId}"` });
        return send(res, 200, {
          runId,
          status: progress.status,
          momentum: progress.momentum,
        });
      }

      if (req.method !== 'POST')
        return send(res, 404, { error: `no ${req.method} ${path}` });
      const status = readRunStatus(runId);
      if (!status) return send(res, 404, { error: `no run "${runId}"` });
      if (status.status !== 'running' || !status.alive)
        return send(res, 409, {
          error: `run "${runId}" is not live (${status.status}${status.alive ? '' : ', process gone'}); commands only reach a live run`,
        });

      const body = await readBody(req, maxBody);
      if (body === undefined)
        return send(res, 413, { error: `body over ${maxBody} bytes` });
      let parsed: unknown;
      try {
        parsed = JSON.parse(body);
      } catch {
        return send(res, 400, { error: 'body is not valid JSON' });
      }
      if (!isControlCommand(parsed))
        return send(res, 400, {
          error: 'body must be a command: {"cmd":"pause"|"abort"|"steer",...}',
        });
      try {
        requestControl(runId, parsed);
      } catch (e) {
        const error = LoopError.from(e, { code: 'CONFIG' });
        return send(res, 400, { error: error.message });
      }
      return send(res, 202, { ok: true, runId, cmd: parsed.cmd });
    } catch (e) {
      send(res, 500, {
        error: e instanceof Error ? e.message : String(e),
      });
    }
  });
  server.requestTimeout = 30_000;
  const port = await listen(
    server,
    options.port,
    options.host ?? '127.0.0.1',
  );
  return { port, close: closer(server) };
}
