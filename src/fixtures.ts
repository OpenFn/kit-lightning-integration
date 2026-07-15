import { randomUUID } from 'node:crypto';
import type { WorkflowRef } from './manifest.js';

/**
 * A project + workflow spec in the shape Lightning's /api/provision expects.
 * IDs are generated client-side, so we know the webhook trigger id (and thus the
 * webhook URL) up front — no read-back required.
 */
export interface ProvisionFixture {
  spec: Record<string, unknown>;
  ref: WorkflowRef;
}

/** A webhook-triggered single-job passthrough workflow. */
export function buildWebhookPassthrough(userId: string): ProvisionFixture {
  const projectId = randomUUID();
  const workflowId = randomUUID();
  const triggerId = randomUUID();
  const jobId = randomUUID();
  const edgeId = randomUUID();
  const name = 'Webhook Passthrough';

  const spec = {
    id: projectId,
    name: 'contract-tests',
    project_users: [{ user_id: userId, role: 'owner' }],
    workflows: [
      {
        id: workflowId,
        name,
        jobs: [
          {
            id: jobId,
            name: 'Echo',
            adaptor: '@openfn/language-common@latest',
            body: 'fn(state => ({ ...state, data: { ...state.data, echoed: true } }));',
          },
        ],
        triggers: [{ id: triggerId, type: 'webhook', enabled: true }],
        edges: [
          {
            id: edgeId,
            source_trigger_id: triggerId,
            target_job_id: jobId,
            condition_type: 'always',
            enabled: true,
          },
        ],
      },
    ],
  };

  return {
    spec,
    ref: {
      name,
      project_id: projectId,
      workflow_id: workflowId,
      trigger_id: triggerId,
      webhook_path: `/i/${triggerId}`,
    },
  };
}
