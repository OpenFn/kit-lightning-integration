/**
 * vitest globalSetup: boot the stack before the suite, tear it down after.
 * Same code path as `bun run up` — $LIGHTNING / $WORKER pick the sources.
 *
 * Test data is not seeded here: each suite seeds the scenario it needs with
 * `seedScenario()`, so a test's fixture is visible in the test.
 */

import { resolveLightningSource, resolveWorkerSource } from './source.js';
import { down, root, up } from './stack.js';

export async function setup(): Promise<void> {
  await up(
    resolveLightningSource(process.env.LIGHTNING ?? 'main', root),
    resolveWorkerSource(process.env.WORKER ?? 'latest', root),
  );
}

export async function teardown(): Promise<void> {
  if (process.env.KEEP_STACK) {
    console.log('[harness] KEEP_STACK set — leaving the stack up.');
    return;
  }
  await down();
}
