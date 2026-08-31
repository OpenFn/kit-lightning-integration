/**
 * Harness CLI.
 *
 *   npm run stack -- up [--lightning <spec>]   boot the stack (see source.ts for specs)
 *   npm run stack -- down                      tear it down (containers + volumes)
 *
 * `--lightning` falls back to $LIGHTNING, then OpenFn/lightning@main.
 */

import { parseArgs } from 'node:util';

import { resolveLightningSource } from './source.js';
import { down, root, up } from './stack.js';

const USAGE = `Usage:
  npm run stack -- up [--lightning <spec>]
  npm run stack -- down

Lightning specs:
  main                        branch/tag/SHA on OpenFn/lightning (default)
  owner/repo#ref              branch/tag/SHA on a fork
  ../lightning                local checkout`;

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    lightning: { type: 'string', default: process.env.LIGHTNING ?? 'main' },
  },
});

const [command] = positionals;

switch (command) {
  case 'up':
    await up(resolveLightningSource(values.lightning, root));
    break;
  case 'down':
    await down();
    break;
  default:
    console.error(USAGE);
    process.exit(command ? 1 : 0);
}
