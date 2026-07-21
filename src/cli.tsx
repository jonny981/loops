/**
 * The `loops` CLI. Two ways to define a run:
 *   1. a definition file that default-exports a `Job` (supports nesting);
 *   2. flags (`--prompt`, `--until`, `--review`, …) build the standard loop.
 *
 * Output mode: Ink TUI by default (a TTY), `--no-tui` for line logs, `--json`
 * for an NDJSON event stream. Ctrl-C / `q` aborts cleanly and still summarises.
 */

import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import React from 'react';
import { Command } from 'commander';
import { z } from 'zod';
import { parse as parseYaml } from 'yaml';

import { run, exitCodeFor } from './runtime/runner.ts';
import { createHub } from './runtime/hub.ts';
import { installSignalHandlers } from './runtime/signals.ts';
import { jsonReporter, plainReporter, printSummary } from './reporters.ts';
import type { ModelPrice, PriceTable } from './core/cost.ts';
import { buildJobFromFlags, parseDuration } from './config.ts';
import { loop } from './core/loop.ts';
import { humanGateKey, pausedHumanGate } from './core/human.ts';
import { jobMeta, renderPlan } from './core/describe.ts';
import {
  validateParamDefinitions,
  toKebabCase,
  type ParamDefinitions,
  type ParamSpec,
  type RunParams,
} from './core/params.ts';
import type { LoopsConfig, LoopsRunConfig } from './core/config-file.ts';
import { gitRoot } from './core/git.ts';
import {
  listRuns,
  readRunStatus,
  readRunProgress,
  runEventsPath,
  runsHome,
  formatEvent,
  toLine,
} from './runtime/supervisor.ts';
import {
  formatSemanticRecord,
  readSemanticRecords,
  type SemanticRunRecord,
} from './runtime/semantic.ts';
import { SEMANTIC_RECORD_FILTER_KINDS } from './runtime/semantic-schema.ts';
import { requestControl } from './runtime/control.ts';
import { momentumLine } from './core/momentum.ts';
import type { PlanEdit } from './core/plan.ts';
import type { Job, LoopConfig, Outcome } from './core/types.ts';
import type { EngineName, EngineOptions } from './engines/engine.ts';

interface RunFlags {
  prompt?: string;
  promptFile?: string;
  engine?: string;
  defaultModel?: string;
  workerModel?: string;
  validatorModel?: string;
  reviewerModel?: string;
  max?: string;
  until?: string;
  threshold?: string;
  start?: string;
  review?: string;
  reviewThreshold?: string;
  interval?: string;
  maxTokens?: string;
  stallAfter?: string;
  apiKey?: string;
  cliBinary?: string;
  permissionMode?: string;
  engineArg?: string[];
  ack?: string[];
  state?: string;
  budget?: string;
  ground?: boolean;
  record?: string | false;
  checkpoint?: string;
  resume?: string;
  resumeTrustWorkspace?: boolean;
  supervise?: boolean;
  runId?: string;
  prices?: string;
  baselineModel?: string;
  curate?: boolean; // commander sets false for --no-curate
  ladder?: boolean; // commander sets false for --no-ladder
  onLimit?: string;
  maxWait?: string;
  json?: boolean;
  tui?: boolean; // commander sets false for --no-tui
  config?: string;
  profile?: string;
  paramArg?: string[];
}

const ON_LIMIT_VALUES = ['auto', 'wait', 'exit-resume', 'fail'] as const;
type OnLimitValue = (typeof ON_LIMIT_VALUES)[number];

interface CoreOptionMetadata {
  flags: ReadonlySet<string>;
  valueFlags: ReadonlySet<string>;
}

/** The worker prompt comes from --prompt OR --prompt-file (not both). */
function resolvePrompt(flags: RunFlags): string {
  if (flags.promptFile != null && flags.prompt != null) {
    throw new Error('pass either --prompt or --prompt-file, not both');
  }
  if (flags.promptFile != null) {
    const resolved = path.resolve(flags.promptFile);
    if (!fs.existsSync(resolved))
      throw new Error(`prompt file not found: ${flags.promptFile}`);
    return fs.readFileSync(resolved, 'utf8');
  }
  return flags.prompt ?? '';
}

interface LoadedRecipe {
  job: Job;
  title: string;
  params?: ParamDefinitions;
}

interface LoadedConfig {
  run: LoopsRunConfig;
  recipe?: Record<string, unknown>;
}

async function loadJob(file: string): Promise<LoadedRecipe> {
  const resolved = path.resolve(file);
  if (!fs.existsSync(resolved)) {
    throw new Error(
      `loop file not found: ${file}\n(omit the file argument to use flags mode, or run \`loops run --help\`)`,
    );
  }
  // The bin registers tsx's loader globally, so this plain import transforms a
  // `.loop.ts` wherever it lives: inside this package or in a consumer repo that
  // has `loops` installed. A scoped `tsImport` only covers this package's tree,
  // which is why an out-of-tree recipe used to fail on `Unexpected token 'export'`.
  let mod: Record<string, unknown>;
  try {
    mod = (await import(pathToFileURL(resolved).href)) as Record<string, unknown>;
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    const esmHint =
      /ES Module|import statement outside a module|ERR_REQUIRE_ESM/i.test(detail)
        ? `\n  hint: the recipe's folder is not an ES module scope. Add a package.json ` +
          `with {"type":"module"} next to it (repos that use loops as a submodule already have this).`
        : '';
    throw new Error(
      `failed to load loop file ${file}:\n  ${detail}${esmHint}\n` +
        `(the file is imported and run like \`node <file>\`; fix the error above, or ` +
        `run \`loops validate ${file}\` to check it without executing)`,
    );
  }
  const def = mod.default ?? mod.job ?? mod.loop;
  const params = readRecipeParams(mod, file);
  const title = path.basename(file).replace(/\.(loop\.)?(t|j)sx?$/, '');
  if (typeof def === 'function') return { job: def as Job, title, params };
  if (def && typeof def === 'object' && 'body' in def)
    return { job: loop(def as LoopConfig), title, params };
  throw new Error(
    `${file}: default export must be a Job (from loop()/dag()/agentJob()) or a LoopConfig`,
  );
}

function readRecipeParams(
  mod: Record<string, unknown>,
  file: string,
): ParamDefinitions | undefined {
  if (mod.params === undefined) return undefined;
  if (!mod.params || typeof mod.params !== 'object' || Array.isArray(mod.params)) {
    throw new Error(`${file}: exported params must come from defineParams({...})`);
  }
  const params = mod.params as ParamDefinitions;
  validateParamDefinitions(params);
  return params;
}

const RUN_CONFIG_KEYS = new Set([
  'engine',
  'defaultModel',
  'workerModel',
  'validatorModel',
  'reviewerModel',
  'apiKey',
  'cliBinary',
  'permissionMode',
  'engineArg',
  'budget',
  'ground',
  'record',
  'checkpoint',
  'supervise',
  'onLimit',
  'maxWait',
  'json',
  'tui',
]);

function optionAttribute(flag: string): string {
  return flag.replace(/-([a-z0-9])/g, (_, c: string) => c.toUpperCase());
}

function isRecipePath(value: string): boolean {
  return /\.(loop\.)?[cm]?[tj]sx?$/.test(value) && fs.existsSync(path.resolve(value));
}

function optionMetadata(command: Command): CoreOptionMetadata {
  const flags = new Set<string>();
  const valueFlags = new Set<string>();
  for (const option of command.options) {
    for (const flag of [option.long, option.short].filter(
      (flag): flag is string => Boolean(flag),
    )) {
      flags.add(flag);
      if (option.required || option.optional || option.variadic) {
        valueFlags.add(flag);
      }
    }
    if (option.negate) flags.add(`--${option.attributeName()}`);
  }
  return { flags, valueFlags };
}

function inferRunFile(
  args: string[],
  coreOptions: CoreOptionMetadata,
): string | undefined {
  const tokens = args[0] === 'run' ? args.slice(1) : args;
  if (tokens[0] && !tokens[0].startsWith('-') && !isRecipePath(tokens[0]))
    return undefined;
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i]!;
    if (token === '--') break;
    if (token.startsWith('--') && token.includes('=')) {
      const [name] = token.split('=', 1);
      if (name && coreOptions.flags.has(name)) continue;
    }
    if (coreOptions.valueFlags.has(token)) {
      i += 1;
      continue;
    }
    if (!token.startsWith('-') && isRecipePath(token)) return token;
  }
  return undefined;
}

function inferInspectionFile(
  argv: string[],
  commandName: 'validate' | 'describe',
  coreOptions: CoreOptionMetadata,
): string | undefined {
  if (argv[2] !== commandName) return undefined;
  const tokens = argv.slice(3);
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i]!;
    if (token === '--') break;
    if (token.startsWith('--') && token.includes('=')) {
      const [name] = token.split('=', 1);
      if (name && coreOptions.flags.has(name)) continue;
    }
    if (coreOptions.valueFlags.has(token)) {
      i += 1;
      continue;
    }
    if (!token.startsWith('-') && isRecipePath(token)) return token;
  }
  return undefined;
}

function assertNoCoreParamCollisions(
  params: ParamDefinitions,
  coreOptions: CoreOptionMetadata,
): void {
  for (const [key, spec] of Object.entries(params)) {
    const flag = spec.flag ?? toKebabCase(key);
    if (
      coreOptions.flags.has(`--${flag}`) ||
      coreOptions.flags.has(`--no-${flag}`)
    ) {
      throw new Error(`recipe param "${key}" collides with loops flag "--${flag}"`);
    }
  }
}

function addRecipeParamOptions(
  command: Command,
  params: ParamDefinitions,
  coreOptions: CoreOptionMetadata,
): void {
  assertNoCoreParamCollisions(params, coreOptions);
  for (const [key, spec] of Object.entries(params)) {
    const flag = spec.flag ?? toKebabCase(key);
    const help = spec.help ?? `recipe parameter "${key}"`;
    if (spec.type === 'boolean') {
      command.option(`--${flag}`, help);
      command.option(`--no-${flag}`, `disable ${help}`);
    } else if (spec.type === 'string[]') {
      command.option(
        `--${flag} <value>`,
        help,
        (value: string, acc: string[] | undefined) => [...(acc ?? []), value],
      );
    } else {
      command.option(`--${flag} <value>`, help);
    }
  }
}

function readStaticRecipeParams(file: string): ParamDefinitions | undefined {
  const source = fs.readFileSync(path.resolve(file), 'utf8');
  const match = /export\s+const\s+params\s*=\s*defineParams\s*\(/.exec(source);
  if (!match) return undefined;
  try {
    const parser = new LiteralParser(source, match.index + match[0].length);
    const parsed = parser.parseValue();
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return undefined;
    }
    const params = parsed as ParamDefinitions;
    validateParamDefinitions(params);
    return params;
  } catch {
    return undefined;
  }
}

class LiteralParser {
  constructor(
    private readonly source: string,
    private index: number,
  ) {}

  parseValue(): unknown {
    this.skip();
    const ch = this.source[this.index];
    if (ch === '{') return this.parseObject();
    if (ch === '[') return this.parseArray();
    if (ch === '"' || ch === "'" || ch === '`') return this.parseString();
    if (ch === '-' || /\d/.test(ch ?? '')) return this.parseNumber();
    const ident = this.parseIdentifier();
    if (ident === 'true') return true;
    if (ident === 'false') return false;
    throw new Error('recipe params help only supports literal metadata');
  }

  private parseObject(): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    this.expect('{');
    while (true) {
      this.skip();
      if (this.take('}')) return out;
      const key = this.parseKey();
      this.skip();
      this.expect(':');
      out[key] = this.parseValue();
      this.skip();
      if (this.take('}')) return out;
      this.expect(',');
    }
  }

  private parseArray(): unknown[] {
    const out: unknown[] = [];
    this.expect('[');
    while (true) {
      this.skip();
      if (this.take(']')) return out;
      out.push(this.parseValue());
      this.skip();
      if (this.take(']')) return out;
      this.expect(',');
    }
  }

  private parseKey(): string {
    this.skip();
    const ch = this.source[this.index];
    if (ch === '"' || ch === "'" || ch === '`') return this.parseString();
    return this.parseIdentifier();
  }

  private parseString(): string {
    const quote = this.source[this.index++];
    let out = '';
    while (this.index < this.source.length) {
      const ch = this.source[this.index++]!;
      if (ch === quote) return out;
      if (quote === '`' && ch === '$' && this.source[this.index] === '{') {
        throw new Error('recipe params help does not evaluate template expressions');
      }
      if (ch !== '\\') {
        out += ch;
        continue;
      }
      const escaped = this.source[this.index++]!;
      if (escaped === 'n') out += '\n';
      else if (escaped === 'r') out += '\r';
      else if (escaped === 't') out += '\t';
      else if (escaped === 'u') {
        const hex = this.source.slice(this.index, this.index + 4);
        if (!/^[0-9a-f]{4}$/i.test(hex)) throw new Error('invalid unicode escape');
        out += String.fromCharCode(Number.parseInt(hex, 16));
        this.index += 4;
      } else {
        out += escaped;
      }
    }
    throw new Error('unterminated string in recipe params');
  }

  private parseNumber(): number {
    const match = /-?(?:0|[1-9]\d*)(?:\.\d+)?/.exec(
      this.source.slice(this.index),
    );
    if (!match) throw new Error('invalid number in recipe params');
    this.index += match[0].length;
    return Number(match[0]);
  }

  private parseIdentifier(): string {
    const match = /[A-Za-z_$][\w$]*/.exec(this.source.slice(this.index));
    if (!match) throw new Error('expected identifier in recipe params');
    this.index += match[0].length;
    return match[0];
  }

  private expect(ch: string): void {
    this.skip();
    if (!this.take(ch)) throw new Error(`expected "${ch}" in recipe params`);
  }

  private take(ch: string): boolean {
    if (this.source[this.index] !== ch) return false;
    this.index += 1;
    return true;
  }

  private skip(): void {
    while (this.index < this.source.length) {
      const ch = this.source[this.index];
      if (/\s/.test(ch ?? '')) {
        this.index += 1;
        continue;
      }
      if (ch === '/' && this.source[this.index + 1] === '/') {
        this.index += 2;
        while (this.index < this.source.length && this.source[this.index] !== '\n') {
          this.index += 1;
        }
        continue;
      }
      if (ch === '/' && this.source[this.index + 1] === '*') {
        this.index += 2;
        while (
          this.index < this.source.length &&
          !(this.source[this.index] === '*' && this.source[this.index + 1] === '/')
        ) {
          this.index += 1;
        }
        this.index += 2;
        continue;
      }
      return;
    }
  }
}

async function loadConfig(
  flags: RunFlags,
  cwd: string,
  file?: string,
): Promise<LoadedConfig> {
  const configPath = await resolveConfigPath(flags.config, cwd, file);
  if (!configPath) return { run: {} };
  const config = await loadConfigFile(configPath);
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    throw new Error(`${configPath}: config must export an object`);
  }
  if (
    config.recipe !== undefined &&
    (!config.recipe ||
      typeof config.recipe !== 'object' ||
      Array.isArray(config.recipe))
  ) {
    throw new Error(`${configPath}: recipe config must be an object`);
  }
  const profile = flags.profile;
  const profileConfig = profile ? config.profiles?.[profile] : undefined;
  if (profile && profileConfig === undefined) {
    throw new Error(`${configPath}: profile "${profile}" was not found`);
  }
  const profileRun =
    profileConfig && 'run' in profileConfig
      ? profileConfig.run
      : (profileConfig as LoopsRunConfig | undefined);
  const merged = {
    ...(config.run ?? {}),
    ...(profileRun ?? {}),
  };
  validateRunConfig(configPath, 'run', config.run);
  validateRunConfig(configPath, profile ? `profiles.${profile}` : 'profile', profileRun);
  validateRunConfig(configPath, 'merged run config', merged);
  return { run: merged, recipe: config.recipe };
}

async function loadConfigFile(configPath: string): Promise<LoopsConfig | undefined> {
  if (/\.ya?ml$/i.test(configPath)) {
    return parseYaml(fs.readFileSync(configPath, 'utf8')) as LoopsConfig | undefined;
  }
  const mod = (await import(pathToFileURL(configPath).href)) as {
    default?: unknown;
    config?: unknown;
  };
  return (mod.default ?? mod.config) as LoopsConfig | undefined;
}

function validateRunConfig(
  file: string,
  label: string,
  config: LoopsRunConfig | undefined,
): void {
  if (!config) return;
  for (const key of Object.keys(config)) {
    if (!RUN_CONFIG_KEYS.has(key)) {
      throw new Error(`${file}: unknown ${label} key "${key}"`);
    }
  }
}

async function resolveConfigPath(
  explicit: string | undefined,
  cwd: string,
  file?: string,
): Promise<string | undefined> {
  if (explicit) {
    const resolved = path.resolve(explicit);
    if (!fs.existsSync(resolved)) throw new Error(`config file not found: ${explicit}`);
    return resolved;
  }
  const names = [
    'loops.config.ts',
    'loops.config.mjs',
    'loops.config.js',
    'loops.config.yaml',
    'loops.config.yml',
  ];
  if (file) {
    const recipeDir = path.dirname(path.resolve(file));
    const recipeRoot = (await gitRoot({ cwd: recipeDir })) ?? recipeDir;
    const found = findConfigUpward(recipeDir, recipeRoot, names);
    if (found) return found;
  }
  const root = (await gitRoot({ cwd })) ?? cwd;
  const found = findConfigUpward(root, root, names);
  if (found) return found;
  return undefined;
}

function findConfigUpward(
  start: string,
  stopAt: string,
  names: readonly string[],
): string | undefined {
  let current = path.resolve(start);
  const stop = path.resolve(stopAt);
  for (const name of names) {
    const candidate = path.join(current, name);
    if (fs.existsSync(candidate)) return candidate;
  }
  while (current !== stop && current !== path.dirname(current)) {
    current = path.dirname(current);
    for (const name of names) {
      const candidate = path.join(current, name);
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  return undefined;
}

function optionWasCli(command: Command, attr: string): boolean {
  return command.getOptionValueSource(attr) === 'cli';
}

function applyRunDefaults(
  flags: RunFlags,
  defaults: LoopsRunConfig,
  command: Command,
): RunFlags {
  const merged: RunFlags = { ...flags };
  const set = <K extends keyof RunFlags>(
    key: K,
    value: RunFlags[K] | undefined,
    attr = String(key),
  ) => {
    if (value !== undefined && !optionWasCli(command, attr)) merged[key] = value;
  };

  set('engine', defaults.engine);
  set('defaultModel', defaults.defaultModel);
  set('workerModel', defaults.workerModel);
  set('validatorModel', defaults.validatorModel);
  set('reviewerModel', defaults.reviewerModel);
  set('apiKey', defaults.apiKey);
  set('cliBinary', defaults.cliBinary);
  set('permissionMode', defaults.permissionMode);
  if (defaults.engineArg !== undefined && !optionWasCli(command, 'engineArg')) {
    merged.engineArg = defaults.engineArg;
  }
  set(
    'budget',
    defaults.budget === undefined ? undefined : String(defaults.budget),
  );
  set('ground', defaults.ground);
  if (defaults.record !== undefined && !optionWasCli(command, 'record')) {
    merged.record = defaults.record;
  }
  set('checkpoint', defaults.checkpoint);
  set('supervise', defaults.supervise);
  set('onLimit', defaults.onLimit);
  set('maxWait', defaults.maxWait);
  set('json', defaults.json);
  if (defaults.tui !== undefined && !optionWasCli(command, 'tui')) {
    merged.tui = defaults.tui;
  }
  return merged;
}

interface ParsedParams {
  values: RunParams;
  args: string[];
}

async function parseRecipeParams(
  params: ParamDefinitions | undefined,
  command: Command,
  flags: RunFlags,
  cwd: string,
  coreOptions: CoreOptionMetadata,
): Promise<ParsedParams> {
  if (!params) return { values: {}, args: [] };
  assertNoCoreParamCollisions(params, coreOptions);
  const values: RunParams = {};
  const args: string[] = [];
  const root = await gitRoot({ cwd });

  for (const [key, spec] of Object.entries(params)) {
    const flag = spec.flag ?? toKebabCase(key);
    const attr = optionAttribute(flag);
    const source = command.getOptionValueSource(attr);
    const cliValue = (flags as Record<string, unknown>)[attr];
    const envValue = spec.env ? process.env[spec.env] : undefined;
    const raw =
      source === 'cli'
        ? cliValue
        : envValue !== undefined
          ? envValue
          : spec.defaultFrom === 'gitRoot'
            ? root ?? cwd
            : spec.defaultFrom === 'cwd'
              ? cwd
              : defaultFor(spec);
    if (raw === undefined) {
      if (spec.required) throw new Error(`missing required recipe param --${flag}`);
      continue;
    }
    values[key] = coerceParam(key, spec, raw);
    if (source === 'cli') args.push(...renderParamArg(flag, spec, values[key]));
  }
  return { values, args };
}

function applyParamEnv(
  params: ParamDefinitions | undefined,
  values: RunParams,
): void {
  if (!params) return;
  for (const [key, spec] of Object.entries(params)) {
    if (!spec.env || values[key] === undefined) continue;
    const value = values[key];
    process.env[spec.env] = Array.isArray(value) ? value.join(',') : String(value);
  }
}

function defaultFor(spec: ParamSpec): unknown {
  return 'default' in spec ? spec.default : undefined;
}

function coerceParam(
  key: string,
  spec: ParamSpec,
  raw: unknown,
): string | number | boolean | string[] {
  switch (spec.type) {
    case 'string':
      return String(raw);
    case 'number': {
      const value = typeof raw === 'number' ? raw : Number(raw);
      if (!Number.isFinite(value)) {
        throw new Error(`recipe param "${key}" must be a number`);
      }
      return value;
    }
    case 'boolean':
      if (typeof raw === 'boolean') return raw;
      if (/^(true|1|yes|on)$/i.test(String(raw))) return true;
      if (/^(false|0|no|off)$/i.test(String(raw))) return false;
      throw new Error(`recipe param "${key}" must be boolean`);
    case 'choice': {
      const value = String(raw);
      if (!spec.choices.includes(value)) {
        throw new Error(
          `recipe param "${key}" must be one of ${spec.choices.join(' | ')}`,
        );
      }
      return value;
    }
    case 'string[]':
      return Array.isArray(raw) ? raw.map(String) : [String(raw)];
  }
}

function renderParamArg(
  flag: string,
  spec: ParamSpec,
  value: string | number | boolean | string[],
): string[] {
  if (spec.type === 'boolean') return [value ? `--${flag}` : `--no-${flag}`];
  if (Array.isArray(value)) return value.flatMap((item) => [`--${flag}`, item]);
  return [`--${flag}`, String(value)];
}

function buildFromFlags(flags: RunFlags): Job {
  const num = (v: string | undefined) => (v == null ? undefined : Number(v));
  const prompt = resolvePrompt(flags); // outside the try so its errors aren't reported as flag-validation
  try {
    // Parsing/validation lives in buildJobFromFlags (single source of truth);
    // we just shape the raw input and translate a Zod failure into a clean error.
    return buildJobFromFlags({
      prompt,
      engine: flags.engine,
      workerModel: flags.workerModel,
      validatorModel: flags.validatorModel,
      reviewerModel: flags.reviewerModel,
      max: num(flags.max),
      untilAgent: flags.until,
      threshold: num(flags.threshold),
      startAgent: flags.start,
      review: flags.review,
      reviewThreshold: num(flags.reviewThreshold),
      interval:
        flags.interval != null ? parseDuration(flags.interval) : undefined,
      maxTokens: num(flags.maxTokens),
      stallAfter: num(flags.stallAfter),
    });
  } catch (e) {
    if (e instanceof z.ZodError) {
      throw new Error(
        `invalid flags:\n  - ${e.issues.map((i) => i.message).join('\n  - ')}`,
      );
    }
    throw e;
  }
}

async function execute(
  file: string | undefined,
  flags: RunFlags,
  command: Command,
  coreOptions: CoreOptionMetadata,
): Promise<void> {
  const cwd = process.cwd();
  const resumeWasCli = optionWasCli(command, 'resume');
  const checkpointWasCli = optionWasCli(command, 'checkpoint');
  const staticParams = file ? readStaticRecipeParams(file) : undefined;
  const preImportParams = await parseRecipeParams(
    staticParams,
    command,
    flags,
    cwd,
    coreOptions,
  );
  applyParamEnv(staticParams, preImportParams.values);

  const defaults = await loadConfig(flags, cwd, file);
  flags = applyRunDefaults(flags, defaults.run, command);
  if (
    flags.resume &&
    (!flags.checkpoint || (resumeWasCli && !checkpointWasCli))
  ) {
    flags.checkpoint = flags.resume;
  }
  if (flags.resumeTrustWorkspace && !flags.resume) {
    throw new Error('--resume-trust-workspace requires --resume');
  }

  const { job, title, params } = file
    ? await loadJob(file)
    : { job: buildFromFlags(flags), title: 'loop', params: undefined };
  const parsedParams = staticParams
    ? preImportParams
    : await parseRecipeParams(params, command, flags, cwd, coreOptions);
  applyParamEnv(params, parsedParams.values);
  if (parsedParams.args.length) flags.paramArg = parsedParams.args;

  const engineOptions: EngineOptions = {};
  if (flags.defaultModel) engineOptions.defaultModel = flags.defaultModel;
  if (flags.apiKey) engineOptions.apiKey = flags.apiKey;
  if (flags.cliBinary) engineOptions.cliBinary = flags.cliBinary;
  if (flags.permissionMode)
    engineOptions.permissionMode =
      flags.permissionMode as EngineOptions['permissionMode'];
  if (flags.engineArg?.length) engineOptions.cliArgs = flags.engineArg;

  let state: Record<string, unknown> | undefined;
  if (flags.state) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(flags.state);
    } catch (e) {
      throw new Error(
        `--state must be valid JSON: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error(
        `--state must be a JSON object, got ${Array.isArray(parsed) ? 'array' : typeof parsed}`,
      );
    }
    state = parsed as Record<string, unknown>;
  }
  // Each --ack seeds the named gate's state key. The explicit seed wins over a
  // checkpoint's restored state (see the runner's resume merge), so a resumed
  // run passes the gate it paused at.
  if (flags.ack?.length) {
    state ??= {};
    for (const name of flags.ack) state[humanGateKey(name)] = true;
  }

  let budget: number | undefined;
  if (flags.budget != null) {
    budget = Number(flags.budget);
    if (!Number.isFinite(budget) || budget <= 0) {
      throw new Error(
        `--budget must be a positive number of tokens, got "${flags.budget}"`,
      );
    }
  }

  let onLimit: OnLimitValue | undefined;
  if (flags.onLimit != null) {
    if (!ON_LIMIT_VALUES.includes(flags.onLimit as OnLimitValue)) {
      throw new Error(
        `--on-limit must be one of ${ON_LIMIT_VALUES.join(' | ')}, got "${flags.onLimit}"`,
      );
    }
    onLimit = flags.onLimit as OnLimitValue;
  }

  const maxWaitMs =
    flags.maxWait != null ? parseDuration(flags.maxWait) : undefined;

  let cost: { prices: PriceTable; baselineModel?: string } | undefined;
  if (flags.prices) {
    const pricesPath = path.resolve(flags.prices);
    let parsed: unknown;
    try {
      parsed = JSON.parse(fs.readFileSync(pricesPath, 'utf8'));
    } catch (e) {
      throw new Error(
        `--prices: could not read ${flags.prices}: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('--prices must be a JSON object of model → price entries');
    }
    for (const [model, price] of Object.entries(parsed)) {
      const p = price as Partial<ModelPrice> | null;
      if (
        !p ||
        typeof p.inputPerMTokUsd !== 'number' ||
        typeof p.outputPerMTokUsd !== 'number'
      ) {
        throw new Error(
          `--prices: entry "${model}" needs numeric inputPerMTokUsd and outputPerMTokUsd`,
        );
      }
    }
    cost = { prices: parsed as PriceTable, baselineModel: flags.baselineModel };
  } else if (flags.baselineModel) {
    throw new Error('--baseline-model requires --prices');
  }

  const mode: 'json' | 'plain' | 'tui' = flags.json
    ? 'json'
    : flags.tui === false || !process.stdout.isTTY
      ? 'plain'
      : 'tui';

  const resumeCommand =
    process.env.LOOPS_RESUME_COMMAND ?? buildResumeCommand(file, flags);
  const recordTo =
    flags.record === false ? undefined : flags.record === undefined ? 'auto' : flags.record;

  const hub = createHub();
  const signals = installSignalHandlers();
  const runOptions = {
    engine: flags.engine as EngineName | undefined,
    engineOptions,
    signal: signals.controller.signal,
    cwd,
    onEvent: hub.emit,
    state,
    params: parsedParams.values,
    config: defaults.recipe !== undefined ? { recipe: defaults.recipe } : {},
    resetScratch: !flags.resume,
    budget,
    ground: flags.ground,
    recordTo,
    checkpoint: flags.checkpoint,
    resumeFrom: flags.resume,
    resumeTrustWorkspace: flags.resumeTrustWorkspace,
    supervise: flags.supervise,
    runId: flags.runId,
    cost,
    // Only an explicit --no-curate / --no-ladder overrides the recipe;
    // commander defaults negated flags to true, which must stay "unset".
    curate: flags.curate === false ? false : undefined,
    ladder: flags.ladder === false ? false : undefined,
    onLimit,
    maxWaitMs,
    resumeCommand,
  };

  let result;
  if (mode === 'tui') {
    const { render } = await import('ink');
    const { App } = await import('./tui/App.tsx');
    const instance = render(
      <App
        hub={hub}
        title={title}
        onAbort={() => signals.controller.abort()}
      />,
    );
    result = await run(job, runOptions);
    instance.unmount();
    await instance.waitUntilExit().catch(() => {});
    printSummary(result, resumeCommand);
  } else {
    const unsubscribe = hub.subscribe(
      mode === 'json' ? jsonReporter() : plainReporter(),
    );
    result = await run(job, runOptions);
    unsubscribe();
    if (mode !== 'json') printSummary(result, resumeCommand);
  }

  if (result.outcome.status === 'paused')
    printResumeGuidance(file, flags, result.outcome, resumeCommand);

  signals.dispose();
  process.exitCode = exitCodeFor(result.outcome);
}

async function loadJobForInspection(
  file: string,
  flags: RunFlags,
  command: Command,
  coreOptions: CoreOptionMetadata,
): Promise<LoadedRecipe> {
  const staticParams = readStaticRecipeParams(file);
  const parsedParams = await parseRecipeParams(
    staticParams,
    command,
    flags,
    process.cwd(),
    coreOptions,
  );
  applyParamEnv(staticParams, parsedParams.values);
  return loadJob(file);
}

/**
 * Reconstruct a ready-to-paste resume command from the invocation. The resumed
 * run reads state from the checkpoint, so it picks up where the limit stopped it.
 * Returns `undefined` when no checkpoint is configured: such a run can still pause
 * cleanly, but it has no state to resume.
 */
export function buildResumeCommand(
  file: string | undefined,
  flags: RunFlags,
): string | undefined {
  if (!flags.checkpoint) return undefined;
  const parts = ['loops', 'run'];
  if (file) parts.push(quoteArg(file));
  parts.push('--resume', quoteArg(flags.checkpoint));
  const opt = (name: string, value: string | undefined) => {
    if (value !== undefined) parts.push(name, quoteArg(value));
  };
  const repeat = (name: string, values: string[] | undefined) => {
    for (const value of values ?? []) parts.push(name, quoteArg(value));
  };
  // Carry the flags that shape the run so the resume is the same job. `--state`
  // and prior `--ack` values deliberately stay out: the checkpoint is the
  // restored state, and `printResumeGuidance` appends the gate ack being lifted.
  opt('--engine', flags.engine);
  opt('--default-model', flags.defaultModel);
  opt('--worker-model', flags.workerModel);
  opt('--validator-model', flags.validatorModel);
  opt('--reviewer-model', flags.reviewerModel);
  opt('--cli-binary', flags.cliBinary);
  opt('--permission-mode', flags.permissionMode);
  repeat('--engine-arg', flags.engineArg);
  if (!file) {
    opt('--prompt-file', flags.promptFile);
    if (!flags.promptFile) opt('--prompt', flags.prompt);
    opt('--max', flags.max);
    opt('--until', flags.until);
    opt('--threshold', flags.threshold);
    opt('--start', flags.start);
    opt('--review', flags.review);
    opt('--review-threshold', flags.reviewThreshold);
    opt('--interval', flags.interval);
    opt('--max-tokens', flags.maxTokens);
    opt('--stall-after', flags.stallAfter);
  }
  opt('--budget', flags.budget);
  // A resumed run silently losing grounding would change agent behaviour mid-run.
  if (flags.ground) parts.push('--ground');
  opt('--on-limit', flags.onLimit);
  opt('--max-wait', flags.maxWait);
  if (flags.record && flags.record !== 'auto') opt('--record', flags.record);
  if (flags.record === false) parts.push('--no-record');
  for (const arg of flags.paramArg ?? []) parts.push(quoteArg(arg));
  if (flags.tui === false) parts.push('--no-tui');
  if (flags.json) parts.push('--json');
  return parts.join(' ');
}

/** Shell-quote an argument unless it is a plain shell token. */
function quoteArg(value: string): string {
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(value)
    ? value
    : `'${value.replace(/'/g, `'\\''`)}'`;
}

/** Print resume guidance to stderr on a paused run (a TUI-safe channel).
 *  Exported for the regression test pinning the `--ack <name>` hint. */
export function printResumeGuidance(
  file: string | undefined,
  flags: RunFlags,
  outcome: Outcome,
  resumeCommand = process.env.LOOPS_RESUME_COMMAND ?? buildResumeCommand(file, flags),
): void {
  // A human-gate pause needs `--ack <name>` on the resume; a limit pause does not.
  const gate = pausedHumanGate(outcome);
  const at = gate ? `at human gate "${gate}"` : 'at a limit';
  const cmd = resumeCommand;
  if (cmd) {
    const resume = gate ? `${cmd} --ack ${quoteArg(gate)}` : cmd;
    process.stderr.write(`\nPaused ${at}. Resume with:\n  ${resume}\n`);
  } else {
    process.stderr.write(
      `\nPaused ${at}. No checkpoint was configured, so there is no warm ` +
        'state to resume.\nRe-run with --checkpoint <path> to make a pause ' +
        `resumable${gate ? ` (then resume with --ack ${quoteArg(gate)})` : ''}.\n`,
    );
  }
}

/** Compact relative age, e.g. `8s`, `5m`, `2h`, `3d`. */
function relAge(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h`;
  return `${Math.round(h / 24)}d`;
}

function parsePositiveIntFlag(value: string, flag: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${flag} must be a positive integer, got "${value}"`);
  }
  return parsed;
}

function parseSinceFlag(value: string): number {
  const trimmed = value.trim();
  // Treat only an all-digit string as epoch ms. The old `Number()`-first parse
  // silently accepted `''` (→ 0, matches every record) and `'2026'` (→ 2026 ms,
  // 2s after the epoch) instead of routing them to Date.parse or erroring.
  if (/^\d+$/.test(trimmed)) return Number(trimmed);
  const parsed = Date.parse(trimmed);
  if (!Number.isFinite(parsed)) {
    throw new Error(`--since must be epoch ms or an ISO timestamp, got "${value}"`);
  }
  return parsed;
}

function normalizeRecordPath(value: string): string {
  return value
    .split(/[\/›>]+/)
    .map((part) => part.trim())
    .filter(Boolean)
    .join('/');
}

function matchesRecordPath(record: SemanticRunRecord, prefix: string): boolean {
  const path = record.path.join('/');
  return path === prefix || path.startsWith(`${prefix}/`);
}

function writeInitFile(
  file: string,
  contents: string,
  force: boolean,
  written: string[],
): void {
  if (fs.existsSync(file) && !force) return;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, contents);
  written.push(file);
}

function ensureGitignore(dir: string, force: boolean, written: string[]): void {
  const file = path.join(dir, '.gitignore');
  const entry = '.loops/';
  if (!fs.existsSync(file)) {
    writeInitFile(file, `${entry}\n`, force, written);
    return;
  }
  const text = fs.readFileSync(file, 'utf8');
  if (text.split(/\r?\n/).includes(entry)) return;
  fs.appendFileSync(file, `${text.endsWith('\n') ? '' : '\n'}${entry}\n`);
  written.push(file);
}

function initProject(dir: string, force: boolean): string[] {
  const target = path.resolve(dir);
  const written: string[] = [];
  writeInitFile(
    path.join(target, 'package.json'),
    JSON.stringify({ type: 'module' }, null, 2) + '\n',
    force,
    written,
  );
  writeInitFile(
    path.join(target, 'tsconfig.json'),
    JSON.stringify(
      {
        compilerOptions: {
          target: 'ES2022',
          module: 'NodeNext',
          moduleResolution: 'NodeNext',
          allowImportingTsExtensions: true,
          noEmit: true,
          strict: true,
        },
        include: ['**/*.ts'],
      },
      null,
      2,
    ) + '\n',
    force,
    written,
  );
  writeInitFile(
    path.join(target, 'loops.config.ts'),
    "import { defineConfig } from '@loops-adk/core';\n\nexport default defineConfig({\n  run: { tui: false, record: 'auto' },\n});\n",
    force,
    written,
  );
  ensureGitignore(target, force, written);
  return written;
}

// The package version, read at runtime rather than hardcoded (a literal here
// goes stale on every release). Both homes of this module sit one level below
// the package root (`src/` under tsx, `dist/` when built), so '../package.json'
// resolves to the same file from either.
const { version: PKG_VERSION } = createRequire(import.meta.url)(
  '../package.json',
) as { version: string };

export async function main(argv: string[] = process.argv): Promise<void> {
  const program = new Command();
  program
    .name('loops')
    .description(
      'Run a prompt/agent in a loop with a fresh context every iteration. A nestable job primitive: loops, DAG stages, agent-validated conditions, review-restart.',
    )
    .version(PKG_VERSION);

  const runCommand = program
    .command('run', { isDefault: true })
    .argument(
      '[file]',
      'a loop-definition file (default-exports a Job); omit to use flags',
    )
    .option('-p, --prompt <text>', 'worker prompt (no-file mode)')
    .option(
      '-f, --prompt-file <path>',
      'read the worker prompt from a file (no-file mode)',
    )
    .option(
      '-e, --engine <name>',
      'default engine: codex | agent-sdk | claude-cli | anthropic-api',
    )
    .option('--default-model <id>', 'fallback model id for engines')
    .option('--worker-model <id>', 'model for the worker job')
    .option(
      '--validator-model <id>',
      'cheap model for agent-validated conditions',
    )
    .option('--reviewer-model <id>', 'model for the review job')
    .option('-n, --max <n>', 'max iterations')
    .option('-u, --until <question>', 'agent-validated stop condition')
    .option('-t, --threshold <0..1>', 'confidence threshold for --until', '0.8')
    .option('--start <question>', 'agent-validated start gate')
    .option(
      '--review <instructions>',
      'review job; failing it restarts the loop',
    )
    .option(
      '--review-threshold <0..1>',
      'confidence threshold for --review',
      '0.85',
    )
    .option('-i, --interval <dur>', 'delay between iterations (e.g. 30s, 5m)')
    .option('--max-tokens <n>', 'max output tokens per agent turn')
    .option(
      '--stall-after <n>',
      'end exhausted after n consecutive iterations with no observable progress',
    )
    .option('--api-key <key>', 'Anthropic API key (anthropic-api engine)')
    .option(
      '--cli-binary <path>',
      'path to a CLI engine binary',
    )
    .option(
      '--permission-mode <mode>',
      'tool permission mode for CLI/SDK engines (default | acceptEdits | bypassPermissions | plan | dontAsk | auto)',
    )
    .option(
      '--engine-arg <arg>',
      'extra arg forwarded to CLI-backed engines (repeatable)',
      (v: string, acc: string[]) => acc.concat(v),
      [] as string[],
    )
    .option(
      '--ack <name>',
      'acknowledge a human gate by name so it passes (repeatable)',
      (v: string, acc: string[]) => acc.concat(v),
      [] as string[],
    )
    .option('--state <json>', 'seed the shared run state (JSON)')
    .option('--budget <tokens>', 'cap total tokens (input+output) for the run')
    .option(
      '--prices <file>',
      'price the run: a JSON file of { "<model or prefix>": { "inputPerMTokUsd": n, "outputPerMTokUsd": n } }',
    )
    .option(
      '--baseline-model <id>',
      'with --prices: also report what the same tokens would have cost on this model (a reconstruction, labeled as such)',
    )
    .option(
      '--ground',
      "ground every agent job's turn in branch memory (commit log + scratch files); judge/validator turns are unaffected; a job's own ground config wins",
    )
    .option(
      '--no-curate',
      "skip every curation turn (ground.curate) — the A/B arm for measuring curated grounding against plain grounding",
    )
    .option(
      '--no-ladder',
      'pin every laddered job to its default lane (rung 0) — the A/B arm for measuring routing against a static assignment',
    )
    .option('--record <path>', 'append a JSONL run record to this path')
    .option(
      '--checkpoint <path>',
      'snapshot run state to this path at each loop/dag/job boundary',
    )
    .option(
      '--resume <path>',
      'restore run state from a prior --checkpoint file',
    )
    .option(
      '--resume-trust-workspace',
      'reuse checkpointed green DAG nodes after an explicit workspace change',
    )
    .option(
      '--on-limit <policy>',
      'on a rate/quota/budget limit: auto | wait | exit-resume | fail (default auto)',
    )
    .option(
      '--max-wait <dur>',
      'cap an auto/wait limit-wait (e.g. 5m, 30s); default 5m',
    )
    .option('--config <path>', 'load run defaults from a loops.config.* file')
    .option('--profile <name>', 'named profile from loops.config.*')
    .option('--json', 'emit NDJSON events to stdout (no TUI)')
    .option('--no-tui', 'plain line output instead of the Ink TUI')
    .option('--no-record', 'disable the default .loops/records/<runId>.jsonl record')
    .option(
      '--supervise',
      'register this run in ~/.loops/runs so `loops list`/`status`/`tail` can observe it from another process',
    )
    .option(
      '--run-id <id>',
      'assign the registry id for --supervise (so a dispatching tool knows it up front)',
    );
  const coreOptions = optionMetadata(runCommand);
  const inferredRunFile = inferRunFile(argv.slice(2), coreOptions);
  const inferredParams = inferredRunFile
    ? readStaticRecipeParams(inferredRunFile)
    : undefined;
  if (inferredParams) addRecipeParamOptions(runCommand, inferredParams, coreOptions);
  runCommand.action(function (
    this: Command,
    file: string | undefined,
    flags: RunFlags,
  ) {
    return execute(file, flags, this, coreOptions);
  });

  const validateCommand = program
    .command('validate')
    .argument('<file>', 'a loop-definition file to check')
    .description(
      'load a .loop.ts and print its shape without running it: the cheap, no-model pre-flight an agent runs before `loops run`',
    )
    .option('--json', 'emit JSON with the loaded job shape')
    .action(async function (this: Command, file: string, flags: { json?: boolean }) {
      // loadJob imports + constructs the Job (so it catches syntax, import,
      // transform, and bad-export errors) but never calls run(), so no agent
      // turns fire. A failure throws the same agent-grade error `run` would,
      // and the top-level handler reports it with exit code 1.
      const { job } = await loadJobForInspection(
        file,
        flags as RunFlags,
        this,
        validateCoreOptions,
      );
      const shape = jobMeta(job);
      if (flags.json) {
        process.stdout.write(
          `${JSON.stringify({ file, ok: true, executed: false, shape }, null, 2)}\n`,
        );
        return;
      }
      const plan = renderPlan(shape);
      process.stdout.write(
        `✓ ${file} loads (not executed)\n${plan.map((l) => `  ${l}`).join('\n')}\n`,
      );
    });
  let validateCoreOptions = optionMetadata(validateCommand);
  const validateParamsFile = inferInspectionFile(argv, 'validate', validateCoreOptions);
  const validateParams = validateParamsFile
    ? readStaticRecipeParams(validateParamsFile)
    : undefined;
  if (validateParams)
    addRecipeParamOptions(validateCommand, validateParams, validateCoreOptions);

  const describeCommand = program
    .command('describe')
    .argument('<file>', 'a loop-definition file')
    .description(
      "print a loop's shape (its gate, body, and dag nodes) without running it",
    )
    .option('--json', 'emit the job shape as JSON')
    .action(async function (this: Command, file: string, flags: { json?: boolean }) {
      const { job } = await loadJobForInspection(
        file,
        flags as RunFlags,
        this,
        describeCoreOptions,
      );
      const shape = jobMeta(job);
      process.stdout.write(
        flags.json
          ? `${JSON.stringify(shape, null, 2)}\n`
          : `${renderPlan(shape).join('\n')}\n`,
      );
    });
  let describeCoreOptions = optionMetadata(describeCommand);
  const describeParamsFile = inferInspectionFile(argv, 'describe', describeCoreOptions);
  const describeParams = describeParamsFile
    ? readStaticRecipeParams(describeParamsFile)
    : undefined;
  if (describeParams)
    addRecipeParamOptions(describeCommand, describeParams, describeCoreOptions);

  program
    .command('helm')
    .argument('[message...]', 'a one-shot message; omit for the interactive REPL')
    .description(
      'the conversational harness: a driver model turns your messages into authored recipes, validations, and dispatched supervised runs',
    )
    .option(
      '-e, --engine <name>',
      'driver engine: claude-cli | codex | agent-sdk | anthropic-api (default claude-cli)',
    )
    .option('--model <id>', 'driver model id')
    .option('--max-steps <n>', 'intent budget per turn (default 8)')
    .option('--max-runs <n>', 'runs the session may dispatch (default 8)')
    .option(
      '--run-arg <arg>',
      'extra arg forwarded to every dispatched run (repeatable)',
      (v: string, acc: string[]) => acc.concat(v),
      [] as string[],
    )
    .option(
      '--import <specifier>',
      "import specifier authored recipes use (default '@loops-adk/core')",
    )
    .option('--session <id>', 'name the helm session (transcript under ~/.loops/helm)')
    .action(async (messageParts: string[], flags: Record<string, unknown>) => {
      // Lazy import: the helm pulls in the bridge/session machinery that the
      // ordinary run/validate paths never need.
      const { runHelmCommand } = await import('./helm/cli.ts');
      await runHelmCommand(messageParts, flags);
    });

  program
    .command('preflight')
    .description(
      'prove each engine can actually run before a loop spends a turn finding out: one tiny live turn per lane, failures classified (auth | billing | missing-cli | model-unavailable | ...) — the online counterpart to the offline `validate`',
    )
    .option(
      '-e, --engine <name>',
      'engine to probe (repeatable; default claude-cli)',
      (v: string, acc: string[]) => acc.concat(v),
      [] as string[],
    )
    .option('--model <id>', 'model for the probes')
    .option('--cli-binary <path>', 'path to a CLI engine binary')
    .option('--api-key <key>', 'Anthropic API key (anthropic-api engine)')
    .option('--timeout <dur>', 'per-probe cap (e.g. 30s); default 60s')
    .action(
      async (flags: {
        engine: string[];
        model?: string;
        cliBinary?: string;
        apiKey?: string;
        timeout?: string;
      }) => {
        const { preflight, formatPreflight } = await import(
          './engines/preflight.ts'
        );
        const engines = flags.engine.length ? flags.engine : ['claude-cli'];
        const results = await preflight(engines, {
          model: flags.model,
          timeoutMs: flags.timeout ? parseDuration(flags.timeout) : undefined,
          engineOptions: {
            cliBinary: flags.cliBinary,
            apiKey: flags.apiKey,
          },
        });
        for (const result of results) {
          process.stdout.write(`${toLine(formatPreflight(result))}\n`);
        }
        if (results.some((r) => !r.ok)) process.exitCode = 1;
      },
    );

  program
    .command('init')
    .argument('[dir]', 'directory to initialise', '.')
    .description('create the small project files a loops recipe island expects')
    .option('--force', 'overwrite package.json, tsconfig.json, and loops.config.ts')
    .action((dir: string, flags: { force?: boolean }) => {
      const written = initProject(dir, !!flags.force);
      if (!written.length) {
        process.stdout.write('loops init: no changes\n');
        return;
      }
      for (const file of written) {
        process.stdout.write(`created ${path.relative(process.cwd(), file) || file}\n`);
      }
    });

  // ── Supervision: observe a run from another process (the registry is files) ──

  program
    .command('list')
    .alias('ls')
    .description('list supervised runs (start one with `loops run --supervise`)')
    .action(() => {
      const runs = listRuns();
      if (!runs.length) {
        process.stdout.write(
          `no supervised runs in ${runsHome()}\n(start one with: loops run --supervise <file>)\n`,
        );
        return;
      }
      for (const r of runs) {
        const state =
          r.status === 'running' ? (r.alive ? 'running' : 'dead') : r.status;
        const age = relAge(Date.now() - (r.endedAt ?? r.updatedAt));
        process.stdout.write(
          `${r.runId.padEnd(26)}  ${state.padEnd(9)}  iter ${String(r.live.iteration).padStart(3)}  ${age.padStart(4)}  ${r.title}\n`,
        );
      }
    });

  program
    .command('status')
    .argument('<runId>', 'a run id from `loops list`')
    .description("show a supervised run's live state and shape")
    .option(
      '--recent [n]',
      'also show the last n formatted events from the run (default 10)',
    )
    .action((runId: string, flags: { recent?: boolean | string }) => {
      const r = readRunStatus(runId);
      if (!r) {
        process.stderr.write(`no run "${runId}" in ${runsHome()}\n`);
        process.exitCode = 1;
        return;
      }
      const recentN =
        typeof flags.recent === 'string'
          ? parsePositiveIntFlag(flags.recent, '--recent')
          : 10;
      const progress = readRunProgress(runId, { recent: recentN });
      const state =
        r.status === 'running'
          ? r.alive
            ? 'running'
            : 'dead (process gone)'
          : r.status;
      const g = r.live.lastGate;
      const o = r.live.lastOutcome;
      const lines = [
        `${r.runId}  [${state}]`,
        `  title:   ${r.title}`,
        `  cwd:     ${r.cwd}`,
        `  pid:     ${r.pid}`,
        r.live.iteration
          ? `  at:      ${r.live.path.join(' › ')} (iteration ${r.live.iteration})`
          : '',
        // Gate reasons and outcome summaries quote judge/agent text, the most
        // model-influenced strings in this output, so they get the same
        // terminal sanitisation as the blocker line below.
        g
          ? `  gate:    ${g.which} ${g.met ? 'met' : 'not met'}${g.confidence != null ? ` @ ${g.confidence.toFixed(2)}` : ''}: ${toLine(g.reason)}`
          : '',
        o
          ? `  last:    ${o.status}${o.late ? ' late' : ''}${o.summary ? `: ${toLine(o.summary)}` : ''}`
          : '',
        progress?.current
          ? `  current: ${progress.current.label ?? progress.current.node ?? progress.current.kind} (${Math.round(progress.current.elapsedMs / 1000)}s elapsed${progress.current.remainingMs != null ? `, ${Math.round(progress.current.remainingMs / 1000)}s remaining` : ''})`
          : '',
        progress?.evidence?.count
          ? `  evidence: ${progress.evidence.count}${progress.evidence.indexPath ? ` at ${progress.evidence.indexPath}` : ''}`
          : '',
        `  tokens:  ${r.live.usage.inputTokens} in / ${r.live.usage.outputTokens} out (${r.live.usage.calls} calls)`,
        progress?.momentum
          ? `  momentum: ${momentumLine(progress.momentum)}`
          : '',
        progress?.blocker
          ? `  blocker: ${progress.blocker.kind}: ${toLine(progress.blocker.detail)}`
          : '',
      ].filter(Boolean);
      process.stdout.write(`${lines.join('\n')}\n`);
      if (r.shape)
        process.stdout.write(
          `\n  shape:\n${renderPlan(r.shape)
            .map((l) => `    ${l}`)
            .join('\n')}\n`,
        );
      // `recent` lines come out of `formatEvent`, which sanitises every event.
      if (flags.recent && progress?.recent.length)
        process.stdout.write(
          `\n  recent:\n${progress.recent.map((l) => `    ${l}`).join('\n')}\n`,
        );
    });

  program
    .command('tail')
    .argument('<runId>', 'a run id from `loops list`')
    .description("stream a supervised run's events live (Ctrl-C to stop)")
    .action(async (runId: string) => {
      const path = runEventsPath(runId);
      if (!fs.existsSync(path)) {
        process.stderr.write(`no run "${runId}" in ${runsHome()}\n`);
        process.exitCode = 1;
        return;
      }
      let offset = 0;
      let stop = false;
      const onSig = () => {
        stop = true;
      };
      process.once('SIGINT', onSig);
      for (;;) {
        const buf = fs.readFileSync(path, 'utf8');
        if (buf.length > offset) {
          // Only consume up to the last newline, so a torn read never drops a line.
          const chunk = buf.slice(offset);
          const lastNl = chunk.lastIndexOf('\n');
          if (lastNl >= 0) {
            offset += lastNl + 1;
            for (const line of chunk.slice(0, lastNl).split('\n')) {
              if (!line.trim()) continue;
              try {
                process.stdout.write(`${formatEvent(JSON.parse(line))}\n`);
              } catch {
                /* skip an unparseable line */
              }
            }
          }
        }
        if (stop) break;
        const st = readRunStatus(runId);
        if (st && st.status !== 'running') {
          process.stdout.write(`◂ ${st.status}\n`);
          break;
        }
        if (st && !st.alive) {
          process.stdout.write('◂ process gone (no terminal status)\n');
          break;
        }
        await new Promise((res) => setTimeout(res, 200));
      }
      process.removeListener('SIGINT', onSig);
    });

  // ── Control: command a run from another process (the channel is a file) ──

  program
    .command('control')
    .argument('<runId>', 'a run id from `loops list`')
    .argument('<action>', 'pause | abort')
    .option('--reason <text>', 'why — recorded and surfaced in the paused summary')
    .description(
      'pause a supervised run at its next safepoint (resumable, exit 75) or abort it',
    )
    .action((runId: string, action: string, flags: { reason?: string }) => {
      if (action !== 'pause' && action !== 'abort') {
        process.stderr.write(`unknown control action "${action}" (pause | abort)\n`);
        process.exitCode = 1;
        return;
      }
      try {
        requestControl(runId, { cmd: action, reason: flags.reason });
      } catch (e) {
        process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`);
        process.exitCode = 1;
        return;
      }
      process.stdout.write(
        action === 'pause'
          ? `pause requested: ${runId} will finish its current turn and pause at the next safepoint\n`
          : `abort requested: ${runId}\n`,
      );
    });

  program
    .command('steer')
    .argument('<runId>', 'a run id from `loops list`')
    .argument(
      '[edits]',
      'a JSON edit batch: [{"op":"add","name":...,"node":{...}}, {"op":"cancel","name":...}, ...]',
    )
    .option('--plan <name>', "the live plan's registered name (defaults to the run's only plan)")
    .option('--file <path>', 'read the JSON edit batch from a file instead')
    .description(
      'apply an atomic edit batch (add/remove/rewire/cancel/reprioritise) to a running live plan',
    )
    .action(
      (
        runId: string,
        editsArg: string | undefined,
        flags: { plan?: string; file?: string },
      ) => {
        let raw = editsArg;
        if (flags.file) {
          try {
            raw = fs.readFileSync(flags.file, 'utf8');
          } catch (e) {
            process.stderr.write(
              `cannot read --file ${flags.file}: ${e instanceof Error ? e.message : String(e)}\n`,
            );
            process.exitCode = 1;
            return;
          }
        }
        if (!raw) {
          process.stderr.write('pass an edit batch as JSON, or --file <path>\n');
          process.exitCode = 1;
          return;
        }
        let edits: PlanEdit[];
        try {
          const parsed = JSON.parse(raw) as unknown;
          edits = Array.isArray(parsed) ? (parsed as PlanEdit[]) : [parsed as PlanEdit];
        } catch (e) {
          process.stderr.write(
            `edit batch is not valid JSON: ${e instanceof Error ? e.message : String(e)}\n`,
          );
          process.exitCode = 1;
          return;
        }
        const bad = edits.find(
          (edit) =>
            !edit ||
            typeof edit !== 'object' ||
            typeof edit.op !== 'string' ||
            typeof edit.name !== 'string',
        );
        if (bad !== undefined) {
          process.stderr.write(
            'every edit needs an "op" and a "name" (add | remove | rewire | cancel | reprioritise)\n',
          );
          process.exitCode = 1;
          return;
        }
        try {
          requestControl(runId, { cmd: 'steer', plan: flags.plan, edits });
        } catch (e) {
          process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`);
          process.exitCode = 1;
          return;
        }
        process.stdout.write(
          `steer sent: ${edits.length} edit${edits.length === 1 ? '' : 's'} for ${runId}` +
            `${flags.plan ? ` (plan ${flags.plan})` : ''}; acceptance lands as dag:edit events (loops tail ${runId})\n`,
        );
      },
    );

  program
    .command('records')
    .argument('<runId>', 'a run id from `loops list`')
    .description("show a supervised run's semantic records")
    .option(
      '--kind <kind>',
      `filter by record kind: ${SEMANTIC_RECORD_FILTER_KINDS.join(' | ')}`,
    )
    .option('--path <path>', 'filter by slash-separated record path prefix')
    .option('--since <time>', 'show records at or after an epoch ms or ISO timestamp')
    .option('--last <n>', 'show only the last n matching records')
    .option('--json', 'emit matching semantic records as JSONL')
    .action((runId: string, flags: { kind?: string; path?: string; since?: string; last?: string; json?: boolean }) => {
      const records = readSemanticRecords(runId);
      if (!records) {
        process.stderr.write(`no semantic records for run "${runId}" in ${runsHome()}\n`);
        process.exitCode = 1;
        return;
      }
      const validKinds: readonly string[] = SEMANTIC_RECORD_FILTER_KINDS;
      if (flags.kind && !validKinds.includes(flags.kind)) {
        process.stderr.write(
          `--kind must be one of ${validKinds.join(' | ')}, got "${flags.kind}"\n`,
        );
        process.exitCode = 1;
        return;
      }
      let pathPrefix: string | undefined;
      if (flags.path != null) {
        pathPrefix = normalizeRecordPath(flags.path);
        if (!pathPrefix) {
          process.stderr.write('--path must contain at least one path segment\n');
          process.exitCode = 1;
          return;
        }
      }
      let since: number | undefined;
      let last: number | undefined;
      try {
        if (flags.since != null) since = parseSinceFlag(flags.since);
        if (flags.last != null) last = parsePositiveIntFlag(flags.last, '--last');
      } catch (e) {
        process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`);
        process.exitCode = 1;
        return;
      }
      let filtered = flags.kind
        ? flags.kind === 'revision'
          ? records.filter(
              (r) => r.kind === 'revision-emitted' || r.kind === 'revision-routed',
            )
          : records.filter((r) => r.kind === flags.kind)
        : records;
      if (pathPrefix) filtered = filtered.filter((r) => matchesRecordPath(r, pathPrefix));
      if (since != null) filtered = filtered.filter((r) => r.ts >= since);
      if (last != null) filtered = filtered.slice(-last);
      if (flags.json) {
        for (const record of filtered) {
          process.stdout.write(`${JSON.stringify(record)}\n`);
        }
        return;
      }
      for (const record of filtered) {
        // Semantic records carry outcome summaries and revision reasons
        // (model-influenced text), so this path sanitises like the others.
        process.stdout.write(`${toLine(formatSemanticRecord(record))}\n`);
      }
    });

  await program.parseAsync(argv);
}
