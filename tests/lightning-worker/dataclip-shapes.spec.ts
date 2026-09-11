import { describe, expect, it } from 'vitest';

import { useScenario } from '../../src/testing.js';

/**
 * What a job receives as `state`, and what happens when a step's output is
 * too big to hand back to Lightning (`Runs.get_input/1`;
 * `engine-multi/util/ensure-payload-size.ts` + `ws-worker/step-complete.ts`).
 *
 * Redaction happens in the worker thread, mutating the one state object both
 * the Lightning event and the next job's input alias — so despite
 * `step-complete.ts`'s own comment ("the workflow will carry on
 * internally"), the next job sees the `'[REDACTED]'` placeholder, not the
 * real value.
 */

interface SyncReply {
  data: unknown;
}

describe('dataclip shapes', () => {
  const lightning = useScenario('scenarios/dataclip-shapes.yaml');

  describe('webhook input nesting', () => {
    it('nests the payload under data and exposes the request alongside it', async () => {
      const run = await lightning
        .workflow('Webhook Input Shape')
        .trigger({ id: 'abc', n: 1 }, { query: { source: 'contract-test' } });

      expect(run.state).toBe('success');
      const state = (run.response.body as SyncReply).data as {
        data: { id: string; n: number };
        request: {
          method: string;
          path: string[];
          query_params: Record<string, string>;
          headers: Record<string, string>;
        };
      };

      expect(state.data).toEqual({ id: 'abc', n: 1 });
      expect(state.request.method).toBe('POST');
      expect(state.request.query_params).toEqual({ source: 'contract-test' });
      expect(state.request.headers['content-type']).toBe('application/json');
    });
  });

  describe('a step output over the payload limit', () => {
    it('withholds the dataclip, logs it, and still lets the run finish', async () => {
      const run = await lightning.workflow('Oversized Step Output').trigger({});

      expect(run.state).toBe('success');

      const logs = await run.logs();
      expect(logs.map(l => l.message)).toContainEqual(
        expect.stringContaining('Dataclip exceeds payload limit'),
      );

      // The downstream job ran (the run didn't fail over the withheld step),
      // but it received the redaction placeholder, not the real ~11MB blob.
      const reply = (run.response.body as SyncReply).data as { data: { sawRedactedPlaceholder: boolean } };
      expect(reply.data.sawRedactedPlaceholder).toBe(true);
    });
  });
});
