import { readFileSync, statSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';

export type PromptVars = Record<string, string | number | boolean>;

export interface PromptBank {
  render(name: string, vars?: PromptVars): string;
}

export interface PromptBankOptions {
  /** Relative directory used to resolve `{{> name}}` fragments. */
  fragmentsDir?: string;
}

interface CachedTemplate {
  mtimeMs: number;
  text: string;
}

function templatePath(dir: string, name: string): string {
  if (isAbsolute(name)) throw new Error(`prompt template name must be relative: ${name}`);
  const file = /\.[A-Za-z0-9]+$/.test(name) ? name : `${name}.md`;
  const path = resolve(dir, file);
  const rel = relative(resolve(dir), path);
  if (rel === '..' || rel.startsWith(`..${sep}`)) {
    throw new Error(`prompt template escapes prompt bank: ${name}`);
  }
  return path;
}

function fragmentsRoot(root: string, dir: string): string {
  if (isAbsolute(dir)) throw new Error(`prompt fragments directory must be relative: ${dir}`);
  const path = resolve(root, dir);
  const rel = relative(root, path);
  if (rel === '..' || rel.startsWith(`..${sep}`)) {
    throw new Error(`prompt fragments directory escapes prompt bank: ${dir}`);
  }
  return path;
}

function stripOneTrailingNewline(text: string): string {
  return text.endsWith('\r\n')
    ? text.slice(0, -2)
    : text.endsWith('\n')
      ? text.slice(0, -1)
      : text;
}

export function promptBank(dir: string, options: PromptBankOptions = {}): PromptBank {
  const root = resolve(dir);
  const fragments =
    options.fragmentsDir === undefined ? root : fragmentsRoot(root, options.fragmentsDir);
  const cache = new Map<string, CachedTemplate>();

  const load = (path: string): string => {
    const stat = statSync(path);
    const cached = cache.get(path);
    if (cached && cached.mtimeMs === stat.mtimeMs) return cached.text;
    const text = stripOneTrailingNewline(readFileSync(path, 'utf8'));
    cache.set(path, { mtimeMs: stat.mtimeMs, text });
    return text;
  };

  const renderTemplate = (
    name: string,
    sourceDir: string,
    vars: PromptVars,
    used: Set<string>,
    stack: Array<{ name: string; path: string }>,
  ): string => {
    const path = templatePath(sourceDir, name);
    if (stack.some((entry) => entry.path === path)) {
      throw new Error(
        `prompt include cycle: ${[...stack.map((entry) => entry.name), name].join(' -> ')}`,
      );
    }
    const source = load(path);
    return source.replace(/{{\s*(>?)\s*([A-Za-z0-9_.-]+)\s*}}/g, (_m, include, key) => {
      if (include) {
        return renderTemplate(key, fragments, vars, used, [...stack, { name, path }]);
      }
      if (!(key in vars)) {
        throw new Error(`prompt "${name}" has unresolved placeholder "{{${key}}}"`);
      }
      used.add(key);
      return String(vars[key]);
    });
  };

  return {
    render(name: string, vars: PromptVars = {}) {
      const used = new Set<string>();
      const rendered = renderTemplate(name, root, vars, used, []);
      const unused = Object.keys(vars).filter((key) => !used.has(key));
      if (unused.length) {
        throw new Error(`prompt "${name}" received unused var(s): ${unused.join(', ')}`);
      }
      return rendered;
    },
  };
}
