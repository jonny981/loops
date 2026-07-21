# Engines

An `Engine` is where an agent turn actually executes. It is a one-method interface — `run(request, onEvent, signal)` — so anything that can take a prompt and stream events can drive a loop.

## Built-in engines

| Name | Backing | Notes |
|---|---|---|
| `agent-sdk` | `@anthropic-ai/claude-agent-sdk` | the default; mediates tool calls in-process |
| `claude-cli` | the `claude` CLI as a subprocess | inherits your local login and settings |
| `anthropic-api` | `@anthropic-ai/sdk` | token streaming; the cheapest lane for judges |
| `codex` | `codex exec` as a subprocess | a different model behind the same interface |
| `mock` | scripted responses | offline and deterministic — tests and examples run on it |

Select per run, per job, or per condition:

```ts
run(job, { engine: 'agent-sdk' })
agentJob({ prompt, engine: 'claude-cli' })
agentCheck({ question, engine: 'anthropic-api', model: 'claude-haiku-4-5' })
```

## Bring your own

Register anything implementing the interface:

```ts
run(job, {
  engines: {
    mine: () => ({
      name: 'mine',
      async run(request, onEvent, signal) {
        // call any provider or framework here
        return { outcome: { status: 'pass' }, text: '...' };
      },
    }),
  },
  engine: 'mine',
})
```

## Resilience

- **Failure classification** distinguishes lane-dead failures (auth, config — they will not heal in-run) from limits (rate, quota — they reset).
- **`fallbackEngine`** chains lanes as an engine combinator: on a lane-dead failure it reroutes to the next engine and latches; it never silently swallows rate limits.
- **`onLimit` policy** governs limit hits per run: `auto` waits out a known reset within a ceiling, else checkpoints and exits resumable (code 75) with a ready-to-paste resume command.
- **Budgets** cap total tokens for a run; engine call sites refuse to spend past them.
- **`loops preflight`** runs one tiny live turn per lane and classifies the result — the online counterpart to the offline `loops validate`.
