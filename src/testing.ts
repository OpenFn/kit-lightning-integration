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

import {
  LightningClient,
  type LogLine,
  type RunAttributes,
  type WebhookResponse,
  type WorkOrderState,
} from './clients/lightning.js';
import { apiToken, projectOf, webhookPath, workflow, type Manifest } from './manifest.js';
import { seedScenario } from './scenario.js';

/** A work order that has settled, with the means to explain what happened. */
export interface Run {
  /** Work order id — the handle Lightning gives back for a webhook POST. */
  id: string;
  /** The workflow that produced it, for readable failures. */
  workflow: string;
  /** Terminal state: 'success', 'failed', 'crashed', … */
  state: WorkOrderState;
  /**
   * The run itself, as Lightning stored it: its state and the `error_type`
   * the worker reported (e.g. `JobError`, `TimeoutError`; null on success).
   */
  run: RunAttributes;
  /**
   * The HTTP response to the webhook POST that started this run. For an
   * async trigger that's `{work_order_id}`, sent before the run starts; for a
   * synchronous one (`webhook_reply: after_completion`) it's Lightning's reply
   * once the run finished — status and `{data, meta}` body.
   */
  response: WebhookResponse;
  /** Everything the job and worker logged, fetched on demand. */
  logs(): Promise<LogLine[]>;
}

export interface WorkflowHandle {
  /**
   * POST a payload to this workflow's webhook and wait for the resulting work
   * order to settle. Resolves for *any* terminal state — assert which one you
   * expected with `toSucceed()` / `toFailRun()`, or inspect `run.response`.
   */
  trigger(payload?: unknown, options?: TriggerOptions): Promise<Run>;
}

export interface TriggerOptions {
  /** How long to wait for the work order to settle (default 90s). */
  timeoutMs?: number;
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
      const project = projectOf(manifest, name);
      return {
        async trigger(payload: unknown = {}, options: TriggerOptions = {}): Promise<Run> {
          const path = webhookPath(wf);
          // Taken before the POST, with a second of clock skew, so a reply
          // with no body can still be matched to the work order it created
          // (see newestWorkOrder).
          const since = new Date(Date.now() - 1_000);
          const response = await client.triggerWebhook(path, payload);
          const id =
            workOrderId(response) ??
            (await newestWorkOrder(client, project.id, since, path, response));
          const state = await client.waitForWorkOrder(id, options);
          const run = await client.getRun(id);
          return {
            id,
            workflow: name,
            state,
            run,
            response,
            logs: () => client.getLogLines(id),
          };
        },
      };
    },
  };
}

/**
 * Every reply Lightning gives to a webhook POST carries the work order id
 * somewhere: top-level for async triggers and timeouts, under `meta` for
 * completed synchronous runs. Returns undefined when there's no body to read
 * it from (a synchronous 204/304).
 */
function workOrderId(response: WebhookResponse): string | undefined {
  const body = response.body as { work_order_id?: string; meta?: { work_order_id?: string } } | null;
  return body?.work_order_id ?? body?.meta?.work_order_id;
}

/**
 * Fall back to "the work order this project gained since the POST". Suites run
 * serially and trigger one run at a time, so the newest one is the right one.
 */
async function newestWorkOrder(
  client: LightningClient,
  projectId: string,
  since: Date,
  path: string,
  response: WebhookResponse,
): Promise<string> {
  const [latest] = await client.listWorkOrders(projectId, since);
  if (!latest) {
    throw new Error(
      `Webhook ${path} returned ${response.status} with no work order id, and no work order appeared in the project: ${JSON.stringify(response.body)}`,
    );
  }
  return latest.id;
}
