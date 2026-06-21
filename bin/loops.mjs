#!/usr/bin/env node
// Thin launcher: run the TypeScript CLI directly through tsx's loader so the
// island needs no build step. `loops ...` resolves here after `npm install`.
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { tsImport } from 'tsx/esm/api';

const here = dirname(fileURLToPath(import.meta.url));
await tsImport(join(here, '..', 'src', 'index.ts'), import.meta.url);
