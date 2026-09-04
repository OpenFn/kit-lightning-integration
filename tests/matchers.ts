/**
 * Custom matchers for run assertions, registered for every suite via
 * vitest's `setupFiles`.
 *
 * The point of these is the failure message: a run that didn't do what the
 * test expected prints its exit state *and its logs* right there, instead of
 * `expected 'failed' to be 'success'` and a trip to tmp/worker.log.
 */

import { expect } from 'vitest';

import type { Run } from '../src/testing.js';

/**
 * The last few log lines are where a failure explains itself; the earlier ones
 * are worker/adaptor preamble. Show the tail, say how much was cut.
 */
const TAIL = 20;

function format(run: Run, lines: { source: string; message: string }[]): string {
  const shown = lines.slice(-TAIL).map(l => `    [${l.source}] ${l.message}`);
  const omitted = lines.length - shown.length;
  if (omitted > 0) shown.unshift(`    … ${omitted} earlier lines omitted`);
  const logs = shown.length ? shown.join('\n') : '    (no log lines)';
  return `  workflow  ${run.workflow}\n  work order  ${run.id}\n  logs\n${logs}`;
}

expect.extend({
  /** Asserts the run reached `success`, reporting its logs if it didn't. */
  async toSucceed(received: Run | Promise<Run>) {
    const run = await received;
    if (run.state === 'success') {
      return {
        pass: true,
        message: () => `expected work order not to succeed, but it did (${run.id})`,
      };
    }
    const details = format(run, await run.logs());
    return {
      pass: false,
      message: () => `expected work order to succeed, got "${run.state}"\n${details}`,
    };
  },

  /**
   * Asserts the run settled in a non-success state (optionally a specific
   * one), reporting logs when it unexpectedly passed.
   */
  async toFailRun(received: Run | Promise<Run>, expectedState?: string) {
    const run = await received;
    const failed = expectedState ? run.state === expectedState : run.state !== 'success';
    if (failed) {
      return {
        pass: true,
        message: () => `expected work order not to be "${run.state}" (${run.id})`,
      };
    }
    const wanted = expectedState ?? 'a failure';
    const details = format(run, await run.logs());
    return {
      pass: false,
      message: () => `expected work order to be ${wanted}, got "${run.state}"\n${details}`,
    };
  },
});

interface RunMatchers<R = unknown> {
  toSucceed(): Promise<R>;
  toFailRun(expectedState?: string): Promise<R>;
}

declare module 'vitest' {
  interface Assertion<T = any> extends RunMatchers<T> {}
  interface AsymmetricMatchersContaining extends RunMatchers {}
}
