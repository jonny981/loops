import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { semanticRunRecordJsonSchema } from '../src/runtime/semantic-schema.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outputPath = join(
  root,
  'schemas',
  'semantic-run-record-v1.schema.json',
);
const expected = `${JSON.stringify(semanticRunRecordJsonSchema, null, 2)}\n`;

if (process.argv.includes('--write')) {
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, expected);
} else if (process.argv.includes('--check')) {
  let actual = '';
  try {
    actual = readFileSync(outputPath, 'utf8');
  } catch {
    // The comparison below reports the same repair command for a missing file.
  }
  if (actual !== expected) {
    process.stderr.write(
      'semantic run record schema is stale; run `npm run schema:write`\n',
    );
    process.exitCode = 1;
  }
} else {
  process.stderr.write('usage: semantic-schema.ts --write | --check\n');
  process.exitCode = 1;
}
