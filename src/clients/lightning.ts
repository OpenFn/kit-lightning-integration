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

/** A line of job/runtime output, as Lightning recorded it. */
export interface LogLine {
  source: string;
  level: string;
  message: string;
  timestamp: string;
  step_id: string | null;
  run_id: string | null;
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

  /**
   * Log lines for a work order, oldest first — what the job and the worker
   * printed while it ran. This is the only view of a run's innards available
   * to an API client, so it's what test failures report.
   *
   * `limit` caps how many of the MOST RECENT lines are fetched (the API pages
   * newest-first); they're returned in chronological order.
   */
  async getLogLines(workOrderId: string, limit = 100): Promise<LogLine[]> {
    const res = await this.api(
      `/api/log_lines?work_order_id=${workOrderId}&page_size=${limit}`,
    );
    const json = (await res.json()) as { data: { attributes: LogLine }[] };
    return json.data
      .map(d => d.attributes)
      .sort((a, b) => a.timestamp.localeCompare(b.timestamp));
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
