import { readFileSync, statSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';

export type PromptVars = Record<string, string | number | boolean>;

export interface PromptBank {
  render(name: string, vars?: PromptVars): string;
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

function stripOneTrailingNewline(text: string): string {
  return text.endsWith('\r\n')
    ? text.slice(0, -2)
    : text.endsWith('\n')
      ? text.slice(0, -1)
      : text;
}

export function promptBank(dir: string): PromptBank {
  const root = resolve(dir);
  const cache = new Map<string, CachedTemplate>();

  const load = (name: string): string => {
    const path = templatePath(root, name);
    const stat = statSync(path);
    const cached = cache.get(path);
    if (cached && cached.mtimeMs === stat.mtimeMs) return cached.text;
    const text = stripOneTrailingNewline(readFileSync(path, 'utf8'));
    cache.set(path, { mtimeMs: stat.mtimeMs, text });
    return text;
  };

  const renderTemplate = (
    name: string,
    vars: PromptVars,
    used: Set<string>,
    stack: string[],
  ): string => {
    if (stack.includes(name)) {
      throw new Error(`prompt include cycle: ${[...stack, name].join(' -> ')}`);
    }
    const source = load(name);
    return source.replace(/{{\s*(>?)\s*([A-Za-z0-9_.-]+)\s*}}/g, (_m, include, key) => {
      if (include) return renderTemplate(key, vars, used, [...stack, name]);
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
      const rendered = renderTemplate(name, vars, used, []);
      const unused = Object.keys(vars).filter((key) => !used.has(key));
      if (unused.length) {
        throw new Error(`prompt "${name}" received unused var(s): ${unused.join(', ')}`);
      }
      return rendered;
    },
  };
}
