import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { createHmac } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  run,
  dag,
  loop,
  fnJob,
  livePlan,
  startWebhookListener,
  startRegistryGateway,
  webhookSignatureValid,
  MockEngine,
} from '../src/api.ts';
import type {
  ControlCommand,
  Outcome,
  RunOptions,
  WebhookListener,
} from '../src/api.ts';

const mockOpts: RunOptions = {
  engine: 'mock',
  engines: { mock: () => new MockEngine(() => '') },
};

let seq = 0;
const planName = () => `listener-spec-${(seq += 1)}`;

const url = (l: WebhookListener, path: string) =>
  `http://127.0.0.1:${l.port}${path}`;

describe('webhook listener', () => {
  it('dispatches a valid /control envelope and refuses malformed ones', async () => {
    const dispatched: ControlCommand[] = [];
    const listener = await startWebhookListener({
      port: 0,
      dispatch: (cmd) => dispatched.push(cmd),
    });
    try {
      const ok = await fetch(url(listener, '/control'), {
        method: 'POST',
        body: JSON.stringify({ cmd: 'pause', reason: 'from a webhook' }),
      });
      expect(ok.status).toBe(202);
      const badJson = await fetch(url(listener, '/control'), {
        method: 'POST',
        body: '{nope',
      });
      expect(badJson.status).toBe(400);
      const notCommand = await fetch(url(listener, '/control'), {
        method: 'POST',
        body: JSON.stringify({ cmd: 'detonate' }),
      });
      expect(notCommand.status).toBe(400);
      expect(dispatched).toEqual([{ cmd: 'pause', reason: 'from a webhook' }]);
    } finally {
      await listener.close();
    }
  });

  it('requires the bearer token everywhere but /healthz, in constant time', async () => {
    const dispatched: ControlCommand[] = [];
    const listener = await startWebhookListener({
      port: 0,
      token: 'sekrit',
      dispatch: (cmd) => dispatched.push(cmd),
    });
    try {
      expect((await fetch(url(listener, '/healthz'))).status).toBe(200);
      expect((await fetch(url(listener, '/momentum'))).status).toBe(401);
      const wrong = await fetch(url(listener, '/control'), {
        method: 'POST',
        headers: { authorization: 'Bearer wrong' },
        body: JSON.stringify({ cmd: 'pause' }),
      });
      expect(wrong.status).toBe(401);
      const right = await fetch(url(listener, '/control'), {
        method: 'POST',
        headers: { authorization: 'Bearer sekrit' },
        body: JSON.stringify({ cmd: 'pause' }),
      });
      expect(right.status).toBe(202);
      expect(dispatched.length).toBe(1);
    } finally {
      await listener.close();
    }
  });

  it('routes a raw webhook through the recipe router: mapped, filtered, or refused', async () => {
    const dispatched: ControlCommand[] = [];
    const listener = await startWebhookListener({
      port: 0,
      dispatch: (cmd) => dispatched.push(cmd),
      route: (req) => {
        const payload = req.json() as { action?: string; issue?: number };
        if (req.path !== '/github') throw new Error('unexpected path');
        if (payload?.action !== 'opened') return undefined; // filtered
        return {
          cmd: 'steer',
          edits: [
            {
              op: 'add',
              name: `fix-${payload.issue}`,
              template: 'fix',
              params: { issue: payload.issue },
            },
          ],
        };
      },
    });
    try {
      const mapped = await fetch(url(listener, '/github'), {
        method: 'POST',
        body: JSON.stringify({ action: 'opened', issue: 7 }),
      });
      expect(mapped.status).toBe(202);
      const filtered = await fetch(url(listener, '/github'), {
        method: 'POST',
        body: JSON.stringify({ action: 'closed', issue: 8 }),
      });
      expect(filtered.status).toBe(204);
      const refused = await fetch(url(listener, '/elsewhere'), {
        method: 'POST',
        body: '{}',
      });
      expect(refused.status).toBe(400); // the route threw: refused, not crashed
      expect(dispatched.length).toBe(1);
      expect(dispatched[0]!.cmd).toBe('steer');
    } finally {
      await listener.close();
    }
  });

  it('caps request bodies and serves the momentum read', async () => {
    const listener = await startWebhookListener({
      port: 0,
      maxBodyBytes: 64,
      dispatch: () => {},
      momentum: () => ({ state: 'alive', crystallized: 3 }),
    });
    try {
      const big = await fetch(url(listener, '/control'), {
        method: 'POST',
        body: `{"cmd":"pause","reason":"${'x'.repeat(200)}"}`,
      });
      expect(big.status).toBe(413);
      const momentum = await fetch(url(listener, '/momentum'));
      expect(momentum.status).toBe(200);
      expect(await momentum.json()).toEqual({ state: 'alive', crystallized: 3 });
    } finally {
      await listener.close();
    }
  });

  it('verifies provider HMAC signatures over the raw body', () => {
    const body = '{"action":"opened","issue":7}';
    const secret = 'hook-secret';
    const signature = `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
    expect(webhookSignatureValid({ body, signature, secret })).toBe(true);
    expect(
      webhookSignatureValid({ body: `${body} `, signature, secret }),
    ).toBe(false);
    expect(
      webhookSignatureValid({ body, signature: 'sha256=deadbeef', secret }),
    ).toBe(false);
    expect(
      webhookSignatureValid({ body, signature: undefined, secret }),
    ).toBe(false);
  });

  it('steers a running live dag over HTTP end to end (RunOptions.listen)', async () => {
    const name = planName();
    const plan = livePlan({
      name,
      templates: {
        extra: () => fnJob('extra', async () => ({ status: 'pass' as const })),
      },
      nodes: {
        waiter: fnJob('waiter', async (ctx) => {
          const deadline = Date.now() + 5_000;
          while (plan.version === 1 && Date.now() < deadline && !ctx.signal.aborted)
            await new Promise((r) => setTimeout(r, 10));
          return { status: 'pass' as const };
        }),
      },
    });
    const onListen = vi.fn(async ({ port }: { port: number }) => {
      const res = await fetch(`http://127.0.0.1:${port}/control`, {
        method: 'POST',
        headers: { authorization: 'Bearer hook' },
        body: JSON.stringify({
          cmd: 'steer',
          plan: name,
          edits: [{ op: 'add', name: 'extra', template: 'extra' }],
        } satisfies ControlCommand),
      });
      expect(res.status).toBe(202);
      const momentum = await fetch(`http://127.0.0.1:${port}/momentum`, {
        headers: { authorization: 'Bearer hook' },
      });
      expect(momentum.status).toBe(200);
    });
    const { outcome } = await run(dag({ name: 'http-steered', plan }), {
      ...mockOpts,
      listen: { port: 0, token: 'hook', onListen },
    });
    expect(onListen).toHaveBeenCalled();
    expect(outcome.status).toBe('pass');
    const data = outcome.data as Record<string, Outcome>;
    expect(data.extra!.status).toBe('pass'); // the webhook-borne node ran
  });
});

describe('registry gateway', () => {
  let home: string;
  let priorHome: string | undefined;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'loops-gateway-'));
    priorHome = process.env.LOOPS_HOME;
    process.env.LOOPS_HOME = home;
  });
  afterEach(() => {
    if (priorHome === undefined) delete process.env.LOOPS_HOME;
    else process.env.LOOPS_HOME = priorHome;
    rmSync(home, { recursive: true, force: true });
  });

  it('fronts a supervised run: pause lands through the file channel; momentum reads back', async () => {
    const gateway = await startRegistryGateway({ port: 0 });
    const runId = 'gateway-pause';
    try {
      let paused = false;
      const running = run(
        loop({
          name: 'gated',
          max: 200,
          delayMs: 20,
          body: fnJob('tick', async () => ({ status: 'fail' as const })),
        }),
        { ...mockOpts, supervise: true, runId },
      );
      // Wait for the run to register, then command it through the gateway.
      const base = `http://127.0.0.1:${gateway.port}`;
      const deadline = Date.now() + 5_000;
      for (;;) {
        const res = await fetch(`${base}/runs/${runId}/control`, {
          method: 'POST',
          body: JSON.stringify({ cmd: 'pause', reason: 'via gateway' }),
        });
        if (res.status === 202) break;
        if (Date.now() > deadline) throw new Error(`gateway kept refusing: ${res.status}`);
        await new Promise((r) => setTimeout(r, 20));
      }
      const { outcome } = await running;
      paused = outcome.status === 'paused';
      expect(paused).toBe(true);
      expect(outcome.summary).toMatch(/via gateway/);
      const momentum = await fetch(`${base}/runs/${runId}/momentum`);
      expect(momentum.status).toBe(200);
      const body = (await momentum.json()) as { status: string };
      expect(body.status).toBe('paused');
      const unknown = await fetch(`${base}/runs/nope/control`, {
        method: 'POST',
        body: JSON.stringify({ cmd: 'pause' }),
      });
      expect(unknown.status).toBe(404);
    } finally {
      await gateway.close();
    }
  });

  it('refuses commands for a run that already ended', async () => {
    const runId = 'gateway-ended';
    await run(
      fnJob('one-shot', async () => ({ status: 'pass' as const })),
      { ...mockOpts, supervise: true, runId },
    );
    const gateway = await startRegistryGateway({ port: 0, token: 't' });
    try {
      const base = `http://127.0.0.1:${gateway.port}`;
      const noAuth = await fetch(`${base}/runs/${runId}/control`, {
        method: 'POST',
        body: JSON.stringify({ cmd: 'abort' }),
      });
      expect(noAuth.status).toBe(401);
      const ended = await fetch(`${base}/runs/${runId}/control`, {
        method: 'POST',
        headers: { authorization: 'Bearer t' },
        body: JSON.stringify({ cmd: 'abort' }),
      });
      expect(ended.status).toBe(409); // ended runs take no commands
    } finally {
      await gateway.close();
    }
  });
});
