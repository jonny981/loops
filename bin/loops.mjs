#!/usr/bin/env node
// Thin launcher: install tsx's ESM loader globally, then run the TypeScript CLI
// directly — no build step. Registering the loader globally (rather than a
// scoped `tsImport`) is what lets `loops run` transform a `.loop.ts` that lives
// OUTSIDE this package — a recipe in a consumer repo — not just files under this
// package's own tree. `loops` resolves here after `npm install`.
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { register } from 'tsx/esm/api';

register();
const here = dirname(fileURLToPath(import.meta.url));
await import(pathToFileURL(join(here, '..', 'src', 'index.ts')).href);
