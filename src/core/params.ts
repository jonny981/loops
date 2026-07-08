export type ParamType = 'string' | 'number' | 'boolean' | 'choice' | 'string[]';

export interface ParamSpecBase {
  /** CLI flag name. Defaults to the kebab-case parameter key. */
  flag?: string;
  /** Help text shown under `loops run <file> --help`. */
  help?: string;
  /** Environment variable fallback, useful while migrating older wrappers. */
  env?: string;
  /** Dynamic fallback when no CLI, env, or static default is present. */
  defaultFrom?: 'gitRoot' | 'cwd';
  /** Treat a missing value as invalid after defaults and env fallback. */
  required?: boolean;
}

export interface StringParamSpec extends ParamSpecBase {
  type: 'string';
  default?: string;
}

export interface NumberParamSpec extends ParamSpecBase {
  type: 'number';
  default?: number;
}

export interface BooleanParamSpec extends ParamSpecBase {
  type: 'boolean';
  default?: boolean;
}

export interface ChoiceParamSpec extends ParamSpecBase {
  type: 'choice';
  choices: readonly string[];
  default?: string;
}

export interface StringArrayParamSpec extends ParamSpecBase {
  type: 'string[]';
  default?: readonly string[];
}

export type ParamSpec =
  | StringParamSpec
  | NumberParamSpec
  | BooleanParamSpec
  | ChoiceParamSpec
  | StringArrayParamSpec;

export type ParamDefinitions = Record<string, ParamSpec>;
export type RunParams = Record<string, string | number | boolean | string[]>;

/** Identity helper for recipe-authored run parameters. */
export function defineParams<const T extends ParamDefinitions>(params: T): T {
  validateParamDefinitions(params);
  return params;
}

export function validateParamDefinitions(params: ParamDefinitions): void {
  const seen = new Set<string>();
  for (const [key, spec] of Object.entries(params)) {
    const flag = spec.flag ?? toKebabCase(key);
    if (!/^[a-z][a-z0-9-]*$/i.test(flag)) {
      throw new Error(`param "${key}" has invalid flag "${flag}"`);
    }
    if (seen.has(flag)) throw new Error(`duplicate recipe param flag "--${flag}"`);
    seen.add(flag);
    if (spec.type === 'choice') {
      if (!spec.choices.length)
        throw new Error(`choice param "${key}" must declare at least one choice`);
      if (spec.default !== undefined && !spec.choices.includes(spec.default)) {
        throw new Error(
          `choice param "${key}" default must be one of ${spec.choices.join(' | ')}`,
        );
      }
    }
  }
}

export function toKebabCase(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/[_\s]+/g, '-')
    .toLowerCase();
}
