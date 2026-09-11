import { describe, expect, it } from 'vitest';

import { useScenario } from '../../src/testing.js';

/**
 * Dataclip shapes: what a job actually receives as `state`, and what happens
 * when a step's output is too big to hand back to Lightning.
 *
 * Input nesting (Lightning, `Runs.get_input/1`): a webhook dataclip is stored
 * as separate `body`/`request` columns; the CASE in that query nests them as
 * `{data: body, request: {headers, method, path, query_params}}` before
 * sending it to the worker as the job's initial state. Non-webhook dataclip
 * types get the bare body instead — not covered here, this suite is about
 * the webhook boundary specifically.
 *
 * Oversized output (kit, `engine-multi/util/ensure-payload-size.ts` +
 * `ws-worker/events/step-complete.ts`): a step's output over the worker's
 * payload limit (`--payload-memory`, 10MB default) is withheld from the
 * `step:complete` event Lightning sees (`output_dataclip_error:
 * "DATACLIP_TOO_LARGE"`, no `output_dataclip_id`). Lightning has no field for
 * the withheld reason (`CompleteStep`'s schema doesn't cast
 * `output_dataclip_error`); it just accepts a step with no output.
 *
 * The redaction is applied in the worker thread, to the one state object
 * that both the Lightning wire event *and* the next job's input alias —
 * `data` is `Object.assign`-replaced with the literal string `'[REDACTED]'`
 * before either side sees it. Note this for anyone reading kit's own
 * `step-complete.ts` comment ("the workflow will carry on internally"): the
 * run does carry on, but the next job gets the placeholder, not the real
 * value the comment might imply survives.
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
