import { describe, expect, it } from 'vitest';

import { RUN_TIMEOUT_SECONDS } from '../../src/stack.js';
import { useScenario } from '../../src/testing.js';

/**
 * Exit reasons: how a run ended, as the worker reports it on `run:complete`
 * and as Lightning stores it.
 *
 * The worker sends `reason` (success | fail | crash | kill | exception, plus
 * cancel, which needs a user and isn't covered here) and `error_type`, the
 * class of the error behind it. Lightning maps the reason onto its own state
 * vocabulary — fail→failed, crash→crashed, kill→killed — and keeps
 * `error_type` verbatim. Both halves are asserted: a renamed reason or error
 * class on either side shows up here.
 *
 * What produces each reason (kit: runtime/errors.ts, engine-multi/errors.ts):
 *   fail       an error the job threw (JobError), or a TypeError/RangeError
 *              inside it (RuntimeError) — recorded, the run carries on
 *   crash      ReferenceError/SyntaxError and other programming errors — the
 *              run is aborted (reported as RuntimeCrash / CompileError)
 *   kill       the run exceeded a resource limit: time (TimeoutError) or
 *              memory (OOMError)
 *   exception  the worker couldn't run the job at all, e.g. the adaptor
 *              wouldn't install (AutoinstallError)
 */

const runTimeoutMs = Number(RUN_TIMEOUT_SECONDS) * 1_000;

describe('exit reasons', () => {
  const lightning = useScenario('scenarios/exit-reasons.yaml');

  it('success: stores state success with no error_type', async () => {
    const run = await lightning.workflow('Exit Success').trigger({});

    expect(run.state).toBe('success');
    expect(run.run).toMatchObject({ state: 'success', error_type: null });
  });

  describe('fail', () => {
    it('an error thrown by the job → failed / JobError', async () => {
      const run = await lightning.workflow('Exit Fail').trigger({});

      expect(run.state).toBe('failed');
      expect(run.run).toMatchObject({ state: 'failed', error_type: 'JobError' });
    });

    it('a TypeError inside the job → failed / RuntimeError', async () => {
      const run = await lightning.workflow('Exit Fail Runtime').trigger({});

      expect(run.state).toBe('failed');
      expect(run.run).toMatchObject({ state: 'failed', error_type: 'RuntimeError' });
    });
  });

  it('crash: a ReferenceError in the job → crashed / RuntimeCrash', async () => {
    const run = await lightning.workflow('Exit Crash').trigger({});

    expect(run.state).toBe('crashed');
    // The step keeps the JS class (ReferenceError) on step:complete; the run
    // carries the runtime's wrapper class on run:complete, and that is what
    // Lightning stores against the run.
    expect(run.run).toMatchObject({ state: 'crashed', error_type: 'RuntimeCrash' });
  });

  describe('kill', () => {
    it(
      'a run over run_timeout_ms → killed / TimeoutError',
      async () => {
        // The job spins for the whole run timeout before the worker kills it,
        // so the wait for the work order has to outlast that.
        const run = await lightning
          .workflow('Exit Kill Timeout')
          .trigger({}, { timeoutMs: runTimeoutMs + 60_000 });

        expect(run.state).toBe('killed');
        expect(run.run).toMatchObject({ state: 'killed', error_type: 'TimeoutError' });
      },
      runTimeoutMs + 90_000,
    );

    it('a run over the memory limit → killed / OOMError', async () => {
      const run = await lightning.workflow('Exit Kill OOM').trigger({});

      expect(run.state).toBe('killed');
      expect(run.run).toMatchObject({ state: 'killed', error_type: 'OOMError' });
    });
  });

  // Blocked upstream: the recipe is a job whose adaptor version doesn't exist
  // (`@openfn/language-common@99.99.99` → AutoinstallError), but
  // `mix lightning.kickstart` runs without Lightning's AdaptorRegistry process,
  // and Job validation asks it whether the package exists for any adaptor
  // other than the schema default (`@openfn/language-common@latest`). Seeding
  // the workflow therefore fails before the test can run. Unskip once
  // kickstart starts the registry (or validation tolerates its absence); the
  // fixture to restore is in scenarios/exit-reasons.yaml's history.
  it.skip('exception: an adaptor that will not install → exception / AutoinstallError', async () => {
    const run = await lightning.workflow('Exit Exception').trigger({});

    expect(run.state).toBe('exception');
    expect(run.run).toMatchObject({ state: 'exception', error_type: 'AutoinstallError' });
  });
});
