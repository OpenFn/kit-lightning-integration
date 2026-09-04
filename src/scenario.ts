/**
 * Seeding test data into a running stack, via Lightning's Kickstart.
 *
 * A scenario is a yaml file describing users, projects and workflows (see
 * scenarios/). Seeding one returns its manifest — the record ids, API token
 * and webhook paths for the data it created — which is how a test reaches the
 * fixture it just asked for.
 */

import { existsSync, readFileSync, rmSync } from 'node:fs';
import { basename, resolve } from 'node:path';

import type { Manifest } from './manifest.js';
import { alive, mix, root, STATE_FILE, type State } from './stack.js';

/**
 * Seed a scenario into the running stack and return its manifest.
 *
 * Tests call this for the fixture they need — the scenario a suite runs
 * against is part of the test, not a hidden default of the boot. Kickstart is
 * idempotent, so suites sharing a scenario converge on the same data.
 *
 * `scenarioPath` is a path to a scenario file, absolute or relative to the
 * working directory (e.g. 'scenarios/webhook-passthrough.yaml').
 */
export function seedScenario(scenarioPath: string): Manifest {
  const file = resolve(scenarioPath);
  if (!existsSync(file)) {
    throw new Error(`No scenario file at ${file}`);
  }

  const dir = runningLightningDir();
  const manifestFile = resolve(root, 'tmp', `manifest-${basename(file).replace(/\.\w+$/, '')}.json`);

  console.log(`[harness] seeding scenario ${file}…`);
  rmSync(manifestFile, { force: true });
  try {
    mix(dir, 'lightning.kickstart', file, '--manifest', manifestFile);
  } catch (err) {
    throw new Error(
      'Kickstart failed — does this Lightning include the Kickstart PR (OpenFn/lightning#5026)?',
      { cause: err },
    );
  }
  if (!existsSync(manifestFile)) {
    throw new Error('Kickstart ran but produced no manifest');
  }
  return JSON.parse(readFileSync(manifestFile, 'utf8')) as Manifest;
}

/**
 * The Lightning checkout backing the running stack, per tmp/harness-state.json.
 *
 * Checks the recorded process is still alive, so a stale state file (from a
 * crashed run) fails here rather than as a confusing Ecto error: kickstart
 * talks to the database directly, so it would otherwise happily try to seed a
 * stack that is no longer running.
 */
function runningLightningDir(): string {
  if (!existsSync(STATE_FILE)) {
    throw new Error('No running stack — start one with `bun run up` first');
  }
  const { lightning } = JSON.parse(readFileSync(STATE_FILE, 'utf8')) as State;
  if (!lightning?.dir) {
    throw new Error('The running stack has no Lightning checkout recorded in tmp/harness-state.json');
  }
  if (!alive(lightning.pid)) {
    throw new Error(
      `The recorded Lightning process (pid ${lightning.pid}) is gone — run \`bun down\` to clean up, then \`bun run up\``,
    );
  }
  return lightning.dir;
}
