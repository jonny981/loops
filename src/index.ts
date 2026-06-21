#!/usr/bin/env node
import { main } from './cli.tsx';

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
