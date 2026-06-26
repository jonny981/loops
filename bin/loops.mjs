#!/usr/bin/env node
// Thin launcher. Registers tsx's ESM loader globally so the CLI can transform a
// user's `.loop.ts` recipe from any repo (the run-from-anywhere contract), then
// hands off to the CLI. In a published install loops' own code is the built
// `dist/`; running from source (this repo, no build step) falls back to the
// TypeScript entry, which the same tsx loader transforms.
import { existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { register } from 'tsx/esm/api';

register();
const here = dirname(fileURLToPath(import.meta.url));
const dist = join(here, '..', 'dist', 'index.js');
const entry = existsSync(dist) ? dist : join(here, '..', 'src', 'index.ts');
await import(pathToFileURL(entry).href);
