#!/usr/bin/env node
/**
 * Commander wrapper for examples/feature-dev.loop.ts.
 *
 * It exposes feature-development inputs as flags, then delegates to the normal
 * Loops CLI entrypoint so validate, describe, run, checkpoint, resume, records,
 * and reporters behave exactly like `loops run`.
 */

import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Command } from 'commander';

import { main as loopsMain } from '../src/cli.tsx';

interface FeatureDevFlags {
  feature: string;
  scopes: string;
  proofDir?: string;
  gateName?: string;
  humanGate: boolean;
  liveAgents?: boolean;
  brief?: string;
  briefFile?: string;
  engine?: string;
  mainModel?: string;
  adversarialEngine?: string;
  adversarialModel?: string;
  checkpoint?: string;
  resume?: string;
  ack?: boolean;
  record?: string;
  supervise?: boolean;
  tui?: boolean;
  json?: boolean;
  ground?: boolean;
  budget?: string;
  permissionMode?: string;
  onLimit?: string;
  maxWait?: string;
  validate?: boolean;
  describe?: boolean;
  describeJson?: boolean;
}

function slug(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/(^-+|-+$)/g, '') || 'feature';
}

function normalizeEngine(input: string | undefined): string | undefined {
  if (!input) return undefined;
  const normalized = input.toLowerCase();
  if (normalized === 'claude') return 'claude-cli';
  return input;
}

function engineFamily(engine: string | undefined): 'codex' | 'claude' | 'other' {
  const normalized = engine?.toLowerCase() ?? '';
  if (normalized.includes('codex')) return 'codex';
  if (
    normalized.includes('claude') ||
    normalized.includes('anthropic') ||
    normalized === 'agent-sdk'
  )
    return 'claude';
  return 'other';
}

function oppositeReviewerEngine(mainEngine: string | undefined): string {
  return engineFamily(mainEngine) === 'codex' ? 'claude-cli' : 'codex';
}

function setEnv(name: string, value: string | undefined): void {
  if (value == null || value === '') delete process.env[name];
  else process.env[name] = value;
}

function append(args: string[], flag: string, value: string | undefined): void {
  if (value != null && value !== '') args.push(flag, value);
}

function shellQuote(value: string): string {
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(value)
    ? value
    : `'${value.replace(/'/g, `'\\''`)}'`;
}

function commandLine(parts: string[]): string {
  return parts.map(shellQuote).join(' ');
}

const here = dirname(fileURLToPath(import.meta.url));
const wrapperFile = fileURLToPath(import.meta.url);
const loopFile = join(here, 'feature-dev.loop.ts');

const program = new Command()
  .name('feature-dev')
  .description('Run the generic feature-development Loops example')
  .option('--feature <name>', 'feature or project name', 'feature-dev')
  .option('--scopes <items>', 'comma-separated actionable scopes', 'implementation')
  .option('--proof-dir <path>', 'directory for proof and offline artifacts')
  .option('--gate-name <name>', 'human gate name')
  .option('--no-human-gate', 'skip the human checkpoint gate')
  .option('--live-agents', 'use real agent implementation and agent reviewers')
  .option('--brief <text>', 'feature brief text')
  .option('--brief-file <path>', 'read the feature brief from a file')
  .option('--engine <engine>', 'main engine for implementation and ordinary reviewers')
  .option('--main-model <model>', 'model for implementation and ordinary reviewers')
  .option('--adversarial-engine <engine>', 'engine for the adversarial reviewer')
  .option('--adversarial-model <model>', 'model for the adversarial reviewer')
  .option('--checkpoint <path>', 'checkpoint file; defaults under proof-dir')
  .option('--resume <path>', 'resume from a checkpoint')
  .option('--ack', 'acknowledge the configured human gate on resume')
  .option('--record <path>', 'write raw events to this JSONL file')
  .option('--supervise', 'register the run for list/status/tail/records')
  .option('--no-tui', 'use plain logs instead of the TUI')
  .option('--json', 'emit raw NDJSON events')
  .option('--ground', 'default agent jobs to grounded prompts')
  .option('--budget <tokens>', 'token budget for the run')
  .option('--permission-mode <mode>', 'engine permission mode')
  .option('--on-limit <policy>', 'limit policy: auto | wait | exit-resume | fail')
  .option('--max-wait <duration>', 'max auto-wait duration for limits')
  .option('--validate', 'validate the loop instead of running it')
  .option('--describe', 'describe the loop instead of running it')
  .option('--describe-json', 'describe the loop as JSON instead of running it')
  .action(async (flags: FeatureDevFlags) => {
    if (flags.brief && flags.briefFile) {
      throw new Error('pass either --brief or --brief-file, not both');
    }
    if (
      [flags.validate, flags.describe, flags.describeJson].filter(Boolean).length > 1
    ) {
      throw new Error('choose only one of --validate, --describe, or --describe-json');
    }

    const mainEngine = normalizeEngine(flags.engine);
    const adversarialEngine = normalizeEngine(
      flags.adversarialEngine ?? (mainEngine ? oppositeReviewerEngine(mainEngine) : undefined),
    );
    const featureSlug = slug(flags.feature);
    const proofDir = resolve(
      flags.proofDir ?? join(tmpdir(), `loops-${featureSlug}`),
    );
    const gateName = flags.gateName ?? `${featureSlug}-checkpoint`;
    const checkpoint = flags.checkpoint ?? join(proofDir, 'checkpoint.json');

    mkdirSync(proofDir, { recursive: true });
    mkdirSync(dirname(checkpoint), { recursive: true });

    setEnv('LOOPS_FEATURE_NAME', flags.feature);
    setEnv('LOOPS_ACTIONABLE_SCOPES', flags.scopes);
    setEnv('LOOPS_PROOF_DIR', proofDir);
    setEnv('LOOPS_GATE_NAME', gateName);
    setEnv('LOOPS_REQUIRE_GATE', flags.humanGate === false ? '0' : '1');
    setEnv('LOOPS_LIVE_AGENTS', flags.liveAgents ? '1' : undefined);
    setEnv('LOOPS_FEATURE_BRIEF', flags.brief);
    setEnv('LOOPS_FEATURE_BRIEF_FILE', flags.briefFile);
    setEnv('LOOPS_MAIN_ENGINE', mainEngine);
    setEnv('LOOPS_MAIN_MODEL', flags.mainModel);
    setEnv('LOOPS_ADVERSARIAL_ENGINE', adversarialEngine);
    setEnv('LOOPS_ADVERSARIAL_MODEL', flags.adversarialModel);

    const args = ['node', 'loops'];
    if (flags.validate) {
      args.push('validate', loopFile);
    } else if (flags.describe || flags.describeJson) {
      args.push('describe', loopFile);
      if (flags.describeJson) args.push('--json');
    } else {
      const wrapperResume = ['npx', 'tsx', wrapperFile];
      append(wrapperResume, '--feature', flags.feature);
      append(wrapperResume, '--scopes', flags.scopes);
      append(wrapperResume, '--proof-dir', proofDir);
      append(wrapperResume, '--gate-name', gateName);
      if (flags.humanGate === false) wrapperResume.push('--no-human-gate');
      if (flags.liveAgents) wrapperResume.push('--live-agents');
      append(wrapperResume, '--brief', flags.brief);
      append(wrapperResume, '--brief-file', flags.briefFile);
      append(wrapperResume, '--engine', mainEngine);
      append(wrapperResume, '--main-model', flags.mainModel);
      append(wrapperResume, '--adversarial-engine', adversarialEngine);
      append(wrapperResume, '--adversarial-model', flags.adversarialModel);
      append(wrapperResume, '--checkpoint', checkpoint);
      append(wrapperResume, '--resume', flags.resume ?? checkpoint);
      append(wrapperResume, '--record', flags.record);
      if (flags.supervise) wrapperResume.push('--supervise');
      if (flags.tui === false) wrapperResume.push('--no-tui');
      if (flags.json) wrapperResume.push('--json');
      if (flags.ground) wrapperResume.push('--ground');
      append(wrapperResume, '--budget', flags.budget);
      append(wrapperResume, '--permission-mode', flags.permissionMode);
      append(wrapperResume, '--on-limit', flags.onLimit);
      append(wrapperResume, '--max-wait', flags.maxWait);
      setEnv('LOOPS_RESUME_COMMAND', commandLine(wrapperResume));

      args.push('run', loopFile);
      append(args, '--engine', mainEngine);
      append(args, '--default-model', flags.mainModel);
      append(args, '--checkpoint', checkpoint);
      append(args, '--resume', flags.resume);
      if (flags.ack) args.push('--ack', gateName);
      append(args, '--record', flags.record);
      if (flags.supervise) args.push('--supervise');
      if (flags.tui === false) args.push('--no-tui');
      if (flags.json) args.push('--json');
      if (flags.ground) args.push('--ground');
      append(args, '--budget', flags.budget);
      append(args, '--permission-mode', flags.permissionMode);
      append(args, '--on-limit', flags.onLimit);
      append(args, '--max-wait', flags.maxWait);
    }

    await loopsMain(args);
  });

await program.parseAsync(process.argv);
