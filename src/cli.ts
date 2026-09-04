/**
 * Harness CLI.
 *
 *   bun run stack up [--lightning <spec>] [--worker <spec>]
 *   bun run stack seed <scenario-path>
 *   bun run stack down
 *
 * Flags fall back to $LIGHTNING / $WORKER, then OpenFn/lightning@main and
 * @openfn/ws-worker@latest. `up` boots an empty stack; seeding is explicit —
 * tests seed the scenario they need, and `seed` does it by hand.
 */

import { parseArgs } from 'node:util';

import { seedScenario } from './scenario.js';
import { resolveLightningSource, resolveWorkerSource } from './source.js';
import { down, root, up } from './stack.js';

const USAGE = `Usage:
  bun run stack up [--lightning <spec>] [--worker <spec>]
  bun run stack seed <scenario-path>  seed a scenario, print its manifest
  bun run stack down

Lightning specs:
  main                        branch/tag/full SHA on OpenFn/lightning (default)
  owner/repo#ref              branch/tag/full SHA on a fork
  ../lightning                local checkout

Worker specs:
  latest                      published @openfn/ws-worker version (default)
  1.14.1                      any npm version
  main                        branch/tag/full SHA on OpenFn/kit
  owner/repo#ref              branch/tag/full SHA on a fork
  ../kit                      local checkout`;

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    lightning: { type: 'string', default: process.env.LIGHTNING ?? 'main' },
    worker: { type: 'string', default: process.env.WORKER ?? 'latest' },
  },
});

const [command, arg] = positionals;

switch (command) {
  case 'up':
    await up(
      resolveLightningSource(values.lightning, root),
      resolveWorkerSource(values.worker, root),
    );
    break;
  case 'seed': {
    if (!arg) {
      console.error('Which scenario? e.g. `bun run stack seed scenarios/webhook-passthrough.yaml`');
      process.exit(1);
    }
    const manifest = seedScenario(arg);
    console.log(JSON.stringify(manifest, null, 2));
    break;
  }
  case 'down':
    await down();
    break;
  default:
    console.error(USAGE);
    process.exit(command ? 1 : 0);
}
