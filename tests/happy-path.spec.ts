import { describe, it } from 'vitest';

import { useScenario } from '../src/testing.js';

/**
 * The end-to-end contract: a webhook payload flows Lightning -> /worker channel
 * -> ws-worker -> job execution -> result reported back -> WorkOrder success.
 * If either side breaks the protocol, the work order never reaches `success`
 * and this fails. Ported from lightning's web_and_worker_test.exs.
 */
describe('webhook -> worker -> success', () => {
  const lightning = useScenario('scenarios/webhook-passthrough.yaml');

  it('runs a webhook-triggered workflow to completion', async () => {
    await expect(lightning.workflow('Webhook Passthrough').trigger({ x: 1 })).toSucceed();
  });
});
