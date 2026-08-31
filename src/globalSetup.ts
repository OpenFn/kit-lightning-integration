/**
 * vitest globalSetup: boot the stack before the suite, tear it down after.
 * Same code path as `npm run stack -- up` — $LIGHTNING picks the source.
 *
 * TODO(seeding): kickstart a scenario here once the harness wires up
 * Lightning.Setup.kickstart/2, so tests get a manifest (token, webhook paths).
 */

import { resolveLightningSource } from './source.js';
import { down, root, up } from './stack.js';

export async function setup(): Promise<void> {
  await up(resolveLightningSource(process.env.LIGHTNING ?? 'main', root));
}

export async function teardown(): Promise<void> {
  if (process.env.KEEP_STACK) {
    console.log('[harness] KEEP_STACK set — leaving the stack up.');
    return;
  }
  await down();
}
