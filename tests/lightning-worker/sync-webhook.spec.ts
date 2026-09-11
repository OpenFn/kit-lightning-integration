import { describe, expect, it } from 'vitest';

import { useScenario } from '../../src/testing.js';

/**
 * Synchronous webhooks: a trigger with `webhook_reply: after_completion`
 * holds the HTTP request open until the run finishes and answers with its
 * result. The reply is assembled from what the worker sent on `run:complete`
 * (`final_state` / `final_dataclip_id`) and `step:complete`
 * (`webhook_response`), so every field of it is a Lightning <-> worker
 * contract point.
 *
 * Reply shape (Lightning, run_channel.ex / webhooks_controller.ex):
 *   status  job's `webhookResponse.status`, else the trigger's
 *           success_code / error_code, else 201 — for failures too
 *   body    {data, meta} — `data` is the run's final state on success, a fixed
 *           "no state on error" message on failure, or the job's own body
 *   204/304 empty body
 *   timeout 504 {error: "timeout", message, work_order_id}
 */

/** The `{data, meta}` envelope Lightning puts around every completed sync reply. */
interface SyncReply {
  data: unknown;
  meta: {
    work_order_id: string;
    run_id: string;
    state: string;
    error_type: string | null;
  };
}

describe('sync webhook round-trip', () => {
  const lightning = useScenario('scenarios/sync-webhook.yaml');

  describe('a successful run', () => {
    it('replies with the final state of a single-leaf workflow', async () => {
      const payload = { id: 'abc', n: 1 };
      const run = await lightning.workflow('Sync Single Leaf').trigger(payload);

      expect(run.state).toBe('success');
      expect(run.response.status).toBe(201);

      const reply = run.response.body as SyncReply;
      // For a single leaf the worker references the step's dataclip
      // (`final_dataclip_id`) rather than only sending `final_state`; the
      // reply body must be the job's output either way.
      expect(reply.data).toMatchObject({ data: { ...payload, echoed: true } });
      expect(reply.meta).toMatchObject({
        work_order_id: run.id,
        state: 'success',
        error_type: null,
      });
    });

    it('replies with every leaf state, keyed by step, for a multi-leaf workflow', async () => {
      const run = await lightning.workflow('Sync Multi Leaf').trigger({});

      expect(run.state).toBe('success');
      expect(run.response.status).toBe(201);

      const leaves = (run.response.body as SyncReply).data as Record<
        string,
        { data: { leaf: string } }
      >;
      // Step ids are minted per run, so assert on the values, not the keys.
      expect(
        Object.values(leaves)
          .map(l => l.data.leaf)
          .sort(),
      ).toEqual(['a', 'b']);
    });
  });

  describe('a failed run', () => {
    it('replies 201 with a fixed message and no state', async () => {
      const run = await lightning.workflow('Sync Failing').trigger({ secret: 'do-not-leak' });

      expect(run.state).toBe('failed');
      // No error_code configured, so failures get the same default as success.
      expect(run.response.status).toBe(201);

      const reply = run.response.body as SyncReply;
      expect(reply.data).toEqual({
        message: expect.stringContaining('Run completed with status: failed'),
      });
      expect(JSON.stringify(reply.data)).not.toContain('do-not-leak');
      expect(reply.meta).toMatchObject({
        work_order_id: run.id,
        state: 'failed',
      });
    });
  });

  describe('trigger-level status codes (webhook_response_config)', () => {
    it('uses custom success_code when the run succeeds', async () => {
      const run = await lightning.workflow('Sync Custom Codes').trigger({ fail: false });

      expect(run.state).toBe('success');
      expect(run.response.status).toBe(200);
      expect((run.response.body as SyncReply).data).toMatchObject({
        data: { fail: false },
      });
    });

    it('uses custom error_code when the run fails', async () => {
      const run = await lightning.workflow('Sync Custom Codes').trigger({ fail: true });

      expect(run.state).toBe('failed');
      expect(run.response.status).toBe(422);
    });
  });

  describe('a job that sets its own response (state.webhookResponse)', () => {
    it('replies with the job-chosen status and body', async () => {
      const run = await lightning.workflow('Sync Job Response').trigger({
        webhookResponse: { status: 202, body: { accepted: true, ref: 'r-1' } },
      });

      expect(run.state).toBe('success');
      expect(run.response.status).toBe(202);
      expect((run.response.body as SyncReply).data).toEqual({
        accepted: true,
        ref: 'r-1',
      });
    });

    it('falls back to the final state when the job sets only a status', async () => {
      const run = await lightning.workflow('Sync Job Response').trigger({
        webhookResponse: { status: 200 },
      });

      expect(run.response.status).toBe(200);
      // `webhookResponse` is ordinary state to the worker, so it comes back too.
      expect((run.response.body as SyncReply).data).toMatchObject({
        data: { webhookResponse: { status: 200 } },
      });
    });

    it('sends an empty body for 204', async () => {
      const run = await lightning.workflow('Sync Job Response').trigger({
        webhookResponse: { status: 204, body: { name: 'Manga' } },
      });

      expect(run.state).toBe('success');
      expect(run.response.status).toBe(204);
      expect(run.response.body).toBeNull();
    });

    it('rejects a non-object body as malformed, keeping the default status', async () => {
      const run = await lightning.workflow('Sync Job Response').trigger({
        webhookResponse: { status: 200, body: [1, 2, 3] },
      });

      expect(run.state).toBe('success');
      expect(run.response.status).toBe(201);
      expect((run.response.body as SyncReply).data).toEqual({
        message: expect.stringContaining('webhook_response was malformed'),
      });
    });
  });

  describe('a run that outlives the response timeout', () => {
    // Lightning gives up on the HTTP reply after WEBHOOK_RESPONSE_TIMEOUT_MS
    // (30s default); the run itself carries on and is left to finish here so
    // teardown doesn't race it.
    it('replies 504 with the work order id, and the run still completes', async () => {
      const run = await lightning.workflow('Sync Slow').trigger({ sleep_ms: 35_000 });

      expect(run.response.status).toBe(504);
      expect(run.response.body).toMatchObject({
        error: 'timeout',
        message: expect.stringContaining('did not complete within timeout'),
        work_order_id: run.id,
      });
      expect(run.state).toBe('success');
    }, 120_000);
  });
});
