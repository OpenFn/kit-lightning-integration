import { beforeAll, describe, expect, it } from 'vitest';
import { LightningClient } from '../src/client.js';
import { loadManifest, workflow, type Manifest } from '../src/manifest.js';

/**
 * The end-to-end contract: a webhook payload flows Lightning -> /worker channel
 * -> ws-worker -> job execution -> result reported back -> WorkOrder success.
 * If either side breaks the protocol, the WorkOrder never reaches `success` and
 * this fails. Ported from lightning's web_and_worker_test.exs.
 */
describe('webhook -> worker -> success', () => {
  let manifest: Manifest;
  let client: LightningClient;

  beforeAll(() => {
    manifest = loadManifest();
    client = new LightningClient(manifest.api_token);
  });

  it('runs a webhook-triggered workflow to completion', async () => {
    const wf = workflow(manifest, 'Webhook Passthrough');
    expect(wf.webhook_path, 'workflow should have a webhook trigger').toBeTruthy();

    const { work_order_id } = await client.triggerWebhook(wf.webhook_path!, { x: 1 });
    expect(work_order_id).toBeTruthy();

    const state = await client.waitForWorkOrder(work_order_id, { until: ['success'] });
    expect(state).toBe('success');
  });
});
