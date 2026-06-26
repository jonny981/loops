#!/usr/bin/env node
// Thin launcher. Registers tsx's ESM loader globally so the CLI can transform a
// user's `.loop.ts` recipe from any repo (the run-from-anywhere contract), then
// hands off to the CLI. From a checkout the TypeScript source is the entry (the
// no-build-step dev path); a published install ships no `src`, so it falls back
// to the built `dist`. Source wins so a stale `dist` never shadows live code.
import { existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { register } from 'tsx/esm/api';

register();
const here = dirname(fileURLToPath(import.meta.url));
const src = join(here, '..', 'src', 'index.ts');
const entry = existsSync(src) ? src : join(here, '..', 'dist', 'index.js');
await import(pathToFileURL(entry).href);
