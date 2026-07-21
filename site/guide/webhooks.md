# Webhooks and control

Every way of commanding a running graph converges on three commands — `steer`, `pause`, `abort` — dispatched through one handler, so every control surface has identical semantics and identical audit events. There are three surfaces.

## The file channel

A supervised run (`--supervise`) polls its registry directory for appended commands. This is what the CLI writes:

```bash
loops control <runId> pause --reason "standup"   # pause at the next safepoint (exit 75)
loops control <runId> abort
loops steer   <runId> '[{"op":"cancel","name":"refactor"}]'
```

Commands target a **live** run only: the channel starts reading at end-of-file, so a resumed run never replays the pause — or worse, the abort — that ended its previous life, and the CLI refuses commands for runs that do not exist, already ended, or whose process is gone.

## The in-run listener

Open an HTTP endpoint on the run itself and the world can steer it. Any webhook — an issue opened, an incident fired, a deploy finished — is **ingested, validated, filtered, and routed** into a command:

```ts
import { run, webhookSignatureValid } from '@loops-adk/core';

await run(job, {
  listen: {
    port: 8787,
    token: process.env.HOOK_TOKEN, // bearer auth, constant-time compare
    route: (req) => {
      // 1. Validate: provider HMAC over the raw body (GitHub-style).
      if (!webhookSignatureValid({
        body: req.body,
        signature: req.headers['x-hub-signature-256'],
        secret: process.env.GITHUB_WEBHOOK_SECRET!,
      })) return undefined;                       // invalid: dropped

      // 2. Filter: only the events that should become work.
      const event = req.json() as { action?: string; issue?: { number: number } };
      if (event.action !== 'opened') return undefined;   // 204, ingested but filtered

      // 3. Route: the payload becomes a steer.
      return {
        cmd: 'steer',
        edits: [{
          op: 'add',
          name: `fix-${event.issue!.number}`,
          template: 'fix',
          params: event.issue,
        }],
      };
    },
  },
});
```

The endpoint surface:

| Route | Purpose |
|---|---|
| `POST /control` | a ready command envelope: `{"cmd":"steer"\|"pause"\|"abort", ...}` |
| `POST <any other path>` | raw webhooks, through your `route` function |
| `GET /momentum` | the live [momentum](/guide/momentum) read — the sender sees whether its force landed |
| `GET /healthz` | liveness, unauthenticated |

From the CLI, `loops run --listen 8787` opens the same listener with the `/control` envelope endpoint (token via `LOOPS_LISTEN_TOKEN`); a custom `route` is a recipe-side concern, wired through `run()`.

## The gateway

One standalone port fronting **every** supervised run on the machine, writing through the file channel:

```bash
loops listen --port 7433
```

| Route | Purpose |
|---|---|
| `POST /runs/<runId>/control` | a command envelope for that run |
| `GET /runs/<runId>/momentum` | that run's momentum read |
| `GET /runs` | every supervised run: id, status, alive, title |

The gateway refuses commands for runs that are not live (`409`), and refuses to bind a non-loopback host with no token.

## Security posture

Fail-closed by default, on every surface:

- binds `127.0.0.1` unless explicitly widened — and widening without a token is refused;
- bearer tokens compare in constant time; everything but `/healthz` requires one when set;
- request bodies are capped (413), malformed JSON and unknown commands are 400;
- a throwing `route` refuses the request and dispatches nothing;
- `webhookSignatureValid` verifies provider HMAC signatures over the raw body, timing-safe;
- a refused steer is still audited: a `dag:edit` event with `accepted: false` and the reason.
