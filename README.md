# lightning-worker-contract-tests

Run real end-to-end tests between Lightning and the worker, with either side
built from any branch.

## Quickstart

```bash
bun install
bun run up --lightning ../lightning --worker latest
```

That boots a real Lightning at <http://localhost:4003> from whatever source
you pointed at, and attaches a real `@openfn/ws-worker` to its `/worker`
channel (the worker's monitor lands on <http://localhost:2222>). When you're
done:

```bash
bun down
```

(`bun up` is taken by bun itself — an alias of `bun update` — hence
`bun run up`. `bun run stack up|down` also works.)

### What you need installed

- **bun** — runs the harness. **node** too: Lightning's assets and the worker
  under test run on node, as they do in production.
- **Elixir/Erlang** matching Lightning's `.tool-versions` (asdf picks it up
  automatically inside the checkout).
- **pnpm**, only if building the worker from a kit checkout (not needed for
  published `@openfn/ws-worker` versions).
- **Postgres** on localhost. The harness uses its own database
  (`lightning_integration_e2e` by default, dropped on `down`) — it will never
  touch your dev data. Point `DATABASE_URL` elsewhere to override.
- On Apple Silicon: **Rust**, to build Lightning's `rambo` dep from source —
  the same requirement Lightning's own `bin/bootstrap` enforces.

## Choosing what to test

`--lightning` (or the `LIGHTNING` env var) takes:

| Spec                      | Meaning                                        |
| ------------------------- | ---------------------------------------------- |
| `main`                    | branch, tag, or SHA on `OpenFn/lightning`      |
| a full 40-char SHA        | any commit (git can't fetch abbreviated SHAs)  |
| `owner/repo#ref`          | branch/tag/SHA on a fork                       |
| `../lightning`            | a local checkout, used as-is                   |

`--worker` (or `WORKER`) takes the same checkout specs against `OpenFn/kit`,
plus published versions:

| Spec                      | Meaning                                        |
| ------------------------- | ---------------------------------------------- |
| `latest`, `1.14.1`, `next`| published `@openfn/ws-worker` via npx (default)|
| `main` / full SHA         | branch/SHA on `OpenFn/kit`, built with pnpm    |
| `owner/repo#ref`          | branch/tag/SHA on a fork                       |
| `../kit`                  | a local checkout (built only if `dist` missing)|

Omitted, they default to `main` and the published `latest`.

Remote refs are cloned into `.cache/lightning/` and `.cache/kit/` and reused;
local checkouts are used in place. The first boot of a fresh clone compiles
everything (a few minutes) — after that it's fast.

Under the hood, `up` runs the same steps a Lightning dev would: the
`bin/bootstrap` prep sequence (deps, assets, runtime, db create + migrate),
then `mix phx.server`, then the worker — waiting for `/health_check` and
`/livez`. Both sides share the dev-mode `WORKER_SECRET`, pinned by the harness
so a checkout's own `.env` can't desync them. Logs stream to
`tmp/lightning.log` / `tmp/worker.log`; `down` stops both and drops the
harness database.

## Running the tests

```bash
bun run test                                    # boots the stack, runs the suite, stops it
LIGHTNING=../lightning WORKER=../kit bun run test   # ...against local checkouts
KEEP_STACK=1 bun run test                       # leave the stack running afterwards
```

> **Today the suite needs a Lightning that has Kickstart**, which `main`
> doesn't yet — until
> [lightning#5026](https://github.com/OpenFn/lightning/pull/5026) merges, point
> it at that branch: `LIGHTNING=bootstrap-from-config bun run test`.

> `bun run test` runs the vitest suite — a bare `bun test` would invoke bun's
> own test runner instead.

## Writing tests

A test names the scenario it needs, triggers a workflow, and asserts on the
result — the manifest, webhook paths, tokens and polling are handled for you:

```ts
import { useScenario } from '../src/testing.js';

describe('webhook -> worker -> success', () => {
  const lightning = useScenario('scenarios/webhook-passthrough.yaml');

  it('runs a webhook-triggered workflow to completion', async () => {
    await expect(lightning.workflow('Webhook Passthrough').trigger({ x: 1 })).toSucceed();
  });
});
```

`trigger()` POSTs to the workflow's webhook and resolves once the work order
settles, whatever the outcome — `toSucceed()` / `toFailRun()` assert which one
you expected. When the assertion fails it prints the run's log lines, so you
find out why without opening `tmp/worker.log`:

```
expected work order to succeed, got "failed"
  workflow  Boom
  work order  e6b847e4-ffd5-496d-b42b-e7d651541f9e
  logs
    … 3 earlier lines omitted
    [R/T] Starting operation 1
    [R/T] Boom aborted with error (270ms)
    [R/T] kaboom from the job
    [R/T] JobError: kaboom from the job
    [R/T] Run complete with status: fail
```

Need more than pass/fail? `await run.logs()` returns the lines, and
`lightning.client` is the raw HTTP client. Note that a job's *output data*
isn't reachable this way — Lightning only exposes dataclips to a logged-in
browser session — so assert on what the job logs, or (once sync webhooks land)
on the webhook's response body.

## Test data

`up` gives you an empty Lightning. Test data comes from **scenarios** — yaml
files in [scenarios/](scenarios/) describing users, projects and workflows —
and each suite seeds the one it needs, so a test's fixture is visible in the
test:

```ts
beforeAll(() => {
  manifest = seedScenario('scenarios/webhook-passthrough.yaml');
  client = new LightningClient(apiToken(manifest));
});
```

`seedScenario` takes the path to a scenario file, runs
`mix lightning.kickstart` with it, and returns the scenario's **manifest** —
the record ids, API token and webhook paths for the data it just created.
Seeding is idempotent, so suites can share a scenario. To seed one by hand and
inspect it:

```bash
bun run stack seed scenarios/webhook-passthrough.yaml
```

Scenarios only work against a Lightning that has Kickstart (see the note
above). The scenario file format is documented in Lightning's
`bin/e2e.d/scenarios/README.md`.

## Why this repo exists

The real coupling between [`OpenFn/lightning`](https://github.com/OpenFn/lightning)
and [`OpenFn/kit`](https://github.com/OpenFn/kit) is the WebSocket protocol
`@openfn/ws-worker` speaks to Lightning's `/worker` channel. Today each repo
tests that boundary against a fake of the other, so a breaking change on
either side ships green and explodes in integration
([lightning#4784](https://github.com/OpenFn/lightning/issues/4784)). This
harness runs the real pair and drives it as a black-box integrator: webhooks
in, run results out.

## Layout

```
src/cli.ts              `bun run up|down|stack seed`
src/source.ts           --lightning/--worker specs → checkout or npm version
src/stack.ts            native boot: Lightning (mix phx.server) + worker, stop
src/scenario.ts         seedScenario(): kickstart a scenario, return its manifest
src/testing.ts          useScenario() + the workflow/run API tests are written against
src/manifest.ts         types + helpers for reading a manifest
src/clients/lightning.ts  typed TS wrapper around a running Lightning
src/globalSetup.ts      vitest wiring: up before the suite, down after
scenarios/*.yaml        declarative kickstart scenarios
tests/matchers.ts       toSucceed() / toFailRun(), with log-reporting failures
tests/*.spec.ts         the e2e suites
```
