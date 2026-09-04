/**
 * The API tests are written against.
 *
 * A test names the scenario it needs, triggers a workflow, and asserts on the
 * result:
 *
 *     const lightning = useScenario('scenarios/webhook-passthrough.yaml');
 *
 *     it('runs to completion', async () => {
 *       await expect(lightning.workflow('Webhook Passthrough').trigger({ x: 1 }))
 *         .toSucceed();
 *     });
 *
 * Everything underneath — the manifest, webhook paths, API tokens, polling —
 * is handled here so tests can talk about workflows and runs instead.
 */

import { beforeAll } from 'vitest';

import { LightningClient, type LogLine, type WorkOrderState } from './clients/lightning.js';
import { apiToken, webhookPath, workflow, type Manifest } from './manifest.js';
import { seedScenario } from './scenario.js';

/** A work order that has settled, with the means to explain what happened. */
export interface Run {
  /** Work order id — the handle Lightning gives back for a webhook POST. */
  id: string;
  /** The workflow that produced it, for readable failures. */
  workflow: string;
  /** Terminal state: 'success', 'failed', 'crashed', … */
  state: WorkOrderState;
  /** Everything the job and worker logged, fetched on demand. */
  logs(): Promise<LogLine[]>;
}

export interface WorkflowHandle {
  /**
   * POST a payload to this workflow's webhook and wait for the resulting work
   * order to settle. Resolves for *any* terminal state — assert which one you
   * expected with `toSucceed()` / `toFailRun()`.
   */
  trigger(payload?: unknown): Promise<Run>;
}

export interface Lightning {
  client: LightningClient;
  manifest: Manifest;
  workflow(name: string): WorkflowHandle;
}

/**
 * Seed a scenario for this suite and return a handle to the instance holding
 * its data.
 *
 * Seeding happens in `beforeAll`, so the handle is live inside `it()` blocks
 * (not in the describe body).
 */
export function useScenario(scenarioPath: string): Lightning {
  const lightning = {} as Lightning;

  beforeAll(() => {
    const manifest = seedScenario(scenarioPath);
    Object.assign(lightning, build(manifest));
  });

  return lightning;
}

function build(manifest: Manifest): Lightning {
  const client = new LightningClient(apiToken(manifest));

  return {
    client,
    manifest,
    workflow(name: string): WorkflowHandle {
      const wf = workflow(manifest, name);
      return {
        async trigger(payload: unknown = {}): Promise<Run> {
          const { work_order_id: id } = await client.triggerWebhook(webhookPath(wf), payload);
          const state = await client.waitForWorkOrder(id);
          return {
            id,
            workflow: name,
            state,
            logs: () => client.getLogLines(id),
          };
        },
      };
    },
  };
}
