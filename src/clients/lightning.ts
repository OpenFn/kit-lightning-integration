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

/**
 * What a webhook POST came back with. The shape of `body` depends on the
 * trigger: an async trigger replies `{work_order_id}` at once; a synchronous
 * one (`webhook_reply: after_completion`) blocks until the run finishes and
 * replies `{data, meta}` — or a timeout/limit error. Tests assert on it
 * directly, so nothing is normalised here.
 */
export interface WebhookResponse {
  status: number;
  /** Parsed JSON when the body was JSON, the raw text otherwise, null if empty. */
  body: unknown;
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

  /**
   * POST a payload to a webhook trigger. Unauthenticated, like a real webhook.
   * Never throws on a non-2xx status: for synchronous triggers the status
   * *is* part of the contract under test (custom error codes, 504 on
   * timeout), so callers decide what counts as a failure.
   */
  async triggerWebhook(webhookPath: string, body: unknown): Promise<WebhookResponse> {
    const res = await fetch(`${this.baseUrl}${webhookPath}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { status: res.status, body: parseBody(await res.text()) };
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

  /**
   * Work orders in a project created at or after `insertedAfter`, newest
   * first. This is how a run is found when the webhook reply carried no id
   * (a synchronous trigger answering 204/304 has no body at all).
   */
  async listWorkOrders(projectId: string, insertedAfter: Date): Promise<{ id: string; inserted_at: string }[]> {
    const query = `inserted_after=${encodeURIComponent(insertedAfter.toISOString())}&page_size=50`;
    const res = await this.api(`/api/projects/${projectId}/work_orders?${query}`);
    const json = (await res.json()) as { data: { id: string; attributes: { inserted_at: string } }[] };
    return json.data
      .map(d => ({ id: d.id, inserted_at: d.attributes.inserted_at }))
      .sort((a, b) => b.inserted_at.localeCompare(a.inserted_at));
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

function parseBody(text: string): unknown {
  if (text === '') return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}
