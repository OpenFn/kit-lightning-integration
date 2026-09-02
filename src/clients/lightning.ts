/**
 * A typed TypeScript wrapper around a running Lightning instance.
 *
 * Construct it with an API token and point it at the instance the harness
 * booted (defaults match `stack up`); it then lets tests talk to Lightning
 * like a real integrator would — fire a webhook trigger, look up a work
 * order, wait for a run to finish — without knowing any HTTP details.
 *
 * It deliberately speaks only Lightning's public surface (webhook endpoints +
 * the JSON API), never internals, so tests exercise the true contract.
 */

// Default matches bin/e2e's port; the harness boots Lightning there.
const BASE_URL = process.env.HARNESS_BASE_URL ?? `http://localhost:${process.env.PORT ?? '4003'}`;

/** Exit reasons: the final states a work order can settle in. */
export const EXIT_REASONS = [
  'success',
  'failed',
  'crashed',
  'cancelled',
  'killed',
  'exception',
  'lost',
  'rejected',
] as const;

export type WorkOrderState =
  | 'pending'
  | 'running'
  | (typeof EXIT_REASONS)[number];

export interface WebhookResult {
  work_order_id: string;
}

export class LightningClient {
  constructor(
    private readonly token: string,
    private readonly baseUrl = BASE_URL,
  ) {}

  /** POST a payload to a webhook trigger. Unauthenticated, like a real webhook. */
  async triggerWebhook(webhookPath: string, body: unknown): Promise<WebhookResult> {
    const res = await fetch(`${this.baseUrl}${webhookPath}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      throw new Error(`Webhook ${webhookPath} returned ${res.status}: ${await res.text()}`);
    }
    return (await res.json()) as WebhookResult;
  }

  async getWorkOrderState(id: string): Promise<WorkOrderState> {
    const res = await this.api(`/api/work_orders/${id}`);
    const json = (await res.json()) as { data: { attributes: { state: WorkOrderState } } };
    return json.data.attributes.state;
  }

  /**
   * Poll a work order until it settles in an exit reason (or one of `until`).
   * Throws on timeout so a stuck worker/protocol break surfaces as a failure.
   */
  async waitForWorkOrder(
    id: string,
    { timeoutMs = 90_000, intervalMs = 1_000, until = EXIT_REASONS as readonly string[] } = {},
  ): Promise<WorkOrderState> {
    const deadline = Date.now() + timeoutMs;
    let last: WorkOrderState = 'pending';
    while (Date.now() < deadline) {
      last = await this.getWorkOrderState(id);
      if (until.includes(last)) return last;
      await sleep(intervalMs);
    }
    throw new Error(`WorkOrder ${id} still "${last}" after ${timeoutMs}ms (expected one of: ${until.join(', ')})`);
  }

  private async api(path: string): Promise<Response> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      headers: { authorization: `Bearer ${this.token}`, accept: 'application/json' },
    });
    if (!res.ok) {
      throw new Error(`GET ${path} returned ${res.status}: ${await res.text()}`);
    }
    return res;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}
