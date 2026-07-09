/**
 * Offline helm demo — no engine, no key, no network. The driver is the
 * built-in oracle (a deterministic keyword policy), the workspace is a temp
 * dir seeded with a tiny deterministic recipe, and every dispatched run is an
 * ordinary supervised run you can inspect with `loops list` afterwards
 * (LOOPS_HOME below keeps this demo's registry out of your real one). Run it:
 *
 *   npm run example:helm
 */

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  HelmBridge,
  HelmSession,
  apiSpecifier,
  oracleEngine,
  prepareEvalWorkspace,
  helmSystemPrompt,
} from '../src/api.ts';

const workspace = mkdtempSync(join(tmpdir(), 'helm-demo-'));
const home = mkdtempSync(join(tmpdir(), 'helm-demo-home-'));
process.env.LOOPS_HOME = home;
prepareEvalWorkspace(workspace); // package.json + fix.loop.ts (a two-tick recipe)

const session = new HelmSession({
  bridge: new HelmBridge({ cwd: workspace, env: { LOOPS_HOME: home } }),
  engine: oracleEngine({ authorImport: apiSpecifier() }),
  system: helmSystemPrompt({ authorImport: apiSpecifier() }),
  home,
});

const conversation = [
  'What does the until gate do in a loop recipe?',
  'Check whether fix.loop.ts is valid before we spend anything.',
  'Start fix.loop.ts in the background.',
];

for (const message of conversation) {
  console.log(`\nyou › ${message}`);
  for await (const event of session.send(message)) {
    switch (event.kind) {
      case 'say':
        console.log(`helm › ${event.text}`);
        break;
      case 'intent':
        if (event.intent.action !== 'answer')
          console.log(`  → ${event.intent.action}`);
        break;
      case 'observation':
        console.log(
          `  ${event.observation.ok ? '·' : '✗'} ${event.observation.summary}`,
        );
        break;
      case 'turn-end':
        if (event.reason === 'dispatched')
          console.log('  (dispatched — the run continues in the background)');
        break;
    }
  }
}

console.log(`\nregistry: LOOPS_HOME=${home} node bin/loops.mjs list`);
