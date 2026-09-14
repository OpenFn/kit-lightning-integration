import { describe, expect, it } from 'vitest';

import { useScenario } from '../../src/testing.js';

/**
 * What a job receives as `state`, and what a step's output looks like when
 * it's too big to hand back to Lightning.
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
    it('shows the redacted placeholder in Lightning\'s own reply when the oversized step is the leaf', async () => {
      const run = await lightning.workflow('Oversized Leaf').trigger({});

      expect(run.state).toBe('success');

      // No downstream job, so the withheld output is the run's final state.
      const reply = (run.response.body as SyncReply).data as { data: string };
      expect(reply.data).toBe('[REDACTED]');
    });
  });
});
