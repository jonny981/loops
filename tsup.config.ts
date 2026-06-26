import { defineConfig } from 'tsup';

// Build the publishable package: compile the TypeScript source to ESM `.js` plus
// `.d.ts` in `dist/`, one output per public entry. Dependencies stay external
// (tsup externalises anything in `dependencies`), so the library bundle pulls in
// only what a consumer's own install provides. The CLI's TUI (`ink`) is imported
// dynamically in `cli.tsx`, so it only loads when a run actually renders a TUI.
export default defineConfig({
  entry: {
    api: 'src/api.ts', // the package's "." export
    index: 'src/index.ts', // the CLI entry, loaded by bin/loops.mjs
    'env/command': 'src/env/command.ts',
    'env/sst': 'src/env/sst.ts',
    'env/docker': 'src/env/docker.ts',
  },
  format: ['esm'],
  target: 'node20',
  outDir: 'dist',
  dts: true,
  splitting: true, // shared chunks across entries + dynamic-import chunks
  sourcemap: true,
  clean: true,
  shims: false,
  treeshake: true,
});
