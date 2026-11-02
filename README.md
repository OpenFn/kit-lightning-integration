# lightning-worker-contract-tests

Real end-to-end contract tests for the boundary between
[`OpenFn/lightning`](https://github.com/OpenFn/lightning) and
[`OpenFn/kit`](https://github.com/OpenFn/kit) — with either side built from any
branch, tag, commit, fork, or local checkout.

The real coupling between the two repos is the WebSocket protocol
`@openfn/ws-worker` speaks to Lightning's `/worker` channel. Historically each
repo tested that boundary against a fake of the other, so a breaking change on
either side shipped green and exploded in integration
([lightning#4784](https://github.com/OpenFn/lightning/issues/4784)). This
harness boots the real pair and drives it as a black-box integrator: webhooks
in, run results out.

- [Quickstart](#quickstart)
- [Prerequisites](#prerequisites)
- [Choosing what to test](#choosing-what-to-test)
- [Running the tests](#running-the-tests)
- [Writing tests](#writing-tests)
- [Test data: scenarios](#test-data-scenarios)
- [Under the hood](#under-the-hood)
- [Running in CI](#running-in-ci)
- [Release process](#release-process)
- [Repository layout](#repository-layout)

## Quickstart

```bash
bun install
bun run up --lightning ../lightning --worker latest
```

That boots a real Lightning at <http://localhost:4003> from whatever source you
pointed at, and attaches a real `@openfn/ws-worker` to its `/worker` channel
(the worker's monitor lands on <http://localhost:2222>). When you're done:

```bash
bun down
```

> `bun up` is taken by bun itself — an alias of `bun update` — hence
> `bun run up`. `bun run stack up|down` also works.

## Prerequisites

| Tool              | Why                                                                                                                                                                         |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **bun**           | Runs the harness.                                                                                                                                                           |
| **node**          | Lightning's assets and the worker under test run on node, as they do in production.                                                                                         |
| **Elixir/Erlang** | Must match Lightning's `.tool-versions` (asdf picks it up automatically inside the checkout).                                                                               |
| **Postgres**      | On localhost. The harness uses its own database (`lightning_integration_e2e` by default, dropped on `down`) — it never touches your dev data. Override with `DATABASE_URL`. |
| **pnpm**          | Only if building the worker from a kit checkout (not needed for published `@openfn/ws-worker` versions).                                                                    |
| **Rust**          | Apple Silicon only, to build Lightning's `rambo` dep from source — the same requirement Lightning's own `bin/bootstrap` enforces.                                           |

Before touching a checkout, `up` checks that the host's Erlang and Elixir match
the checkout's `.tool-versions` and fails with an install hint if not — rather
than three steps later with `mix` exiting 126. Node is only advisory (a
major-version skew works fine).

## Choosing what to test

`--lightning` (or the `LIGHTNING` env var) takes:

| Spec               | Meaning                                       |
| ------------------ | --------------------------------------------- |
| `main`             | branch, tag, or SHA on `OpenFn/lightning`     |
| a full 40-char SHA | any commit (git can't fetch abbreviated SHAs) |
| `owner/repo#ref`   | branch/tag/SHA on a fork                      |
| `../lightning`     | a local checkout, used as-is                  |

`--worker` (or `WORKER`) takes the same checkout specs against `OpenFn/kit`,
plus published versions:

| Spec                       | Meaning                                         |
| -------------------------- | ----------------------------------------------- |
| `latest`, `1.14.1`, `next` | published `@openfn/ws-worker` via npx (default) |
| `main` / full SHA          | branch/SHA on `OpenFn/kit`, built with pnpm     |
| `owner/repo#ref`           | branch/tag/SHA on a fork                        |
| `../kit`                   | a local checkout (built only if `dist` missing) |

Omitted, they default to `main` and the published `latest`.

Remote refs are cloned into `.cache/lightning/` and `.cache/kit/` and reused;
local checkouts are used in place. The first boot of a fresh clone compiles
everything (a few minutes) — after that it's fast.

## Running the tests

```bash
bun run test                                        # boots the stack, runs the suite, stops it
LIGHTNING=../lightning WORKER=../kit bun run test   # ...against local checkouts
KEEP_STACK=1 bun run test                           # leave the stack running afterwards
```

> `bun run test` runs the vitest suite — a bare `bun test` would invoke bun's
> own test runner instead.

The harness sets Lightning's `WORKER_MAX_RUN_DURATION_SECONDS` to **60**
(Lightning's own default is 300), so tests that need a run to hit its timeout
don't take five minutes. Override with `HARNESS_RUN_TIMEOUT_SECONDS`; keep it
above the longest legitimately-slow job in the suites.

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
`lightning.client` is the raw HTTP client. Note that a job's _output data_
isn't reachable this way — Lightning only exposes dataclips to a logged-in
browser session — so assert on what the job logs, or, for a trigger with
`webhook_reply: after_completion`, on `run.response`: the HTTP status and body
Lightning sent back once the run finished.

## Test data: scenarios

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

The scenario file format is documented in Lightning's
`bin/e2e.d/scenarios/README.md`.

## Under the hood

`up` runs the same steps a Lightning dev would: the `bin/bootstrap` prep
sequence (deps, assets, runtime, db create + migrate), then `mix phx.server`,
then the worker — waiting for `/health_check` and `/livez`.

- Both sides share the dev-mode `WORKER_SECRET`, pinned by the harness so a
  checkout's own `.env` can't desync them.
- Logs stream to `tmp/lightning.log` / `tmp/worker.log`.
- The prep steps (`deps.get`, asset/runtime install, db create) write to
  `tmp/prep.log` instead of the console — silent when they succeed, printed in
  full the moment one fails.
- `down` stops both processes and drops the harness database.

## Running in CI

[`test-lightning-branch.yml`](.github/workflows/test-lightning-branch.yml) is a
`workflow_dispatch` that does the same thing on a GitHub runner: check out the
chosen Lightning ref, install the Erlang/Elixir/node **it** pins (read from its
`.tool-versions` — nothing is hardcoded in the workflow), boot the pair, run
the suite. Run it from the Actions tab or:

```bash
gh workflow run test-lightning-branch.yml -f lightning_ref=main -f worker=latest
```

Failures land on the run's summary page (the failing run's log tail, or the
toolchain mismatch), and `tmp/*.log` are uploaded as an artifact. Nothing is
cached yet, so a run compiles Lightning from scratch.

### Using it from another repo

The workflow above is a thin wrapper around [`action.yml`](action.yml), a
composite action any repo can call. Lightning and kit use it to run the suite
against the exact commit their CI has checked out, so a breaking change shows
up on the PR that introduced it:

```yaml
jobs:
  contract:
    runs-on: ubuntu-latest
    services:
      postgres:
        image: postgres:17
        env: { POSTGRES_USER: postgres, POSTGRES_PASSWORD: postgres }
        ports: ['5432:5432']
        options: --health-cmd "pg_isready -U postgres" --health-interval 5s --health-retries 20
    steps:
      - uses: actions/checkout@v4
      - uses: OpenFn/kit-lightning-integration@v1
        with:
          lightning: ${{ github.workspace }} # in Lightning's CI; kit passes `worker:` instead
```

`lightning` and `worker` take the same specs as the CLI (a checkout path, a
ref, `owner/repo#ref`, or a published version for the worker). The caller
provides Postgres — an action can't declare services — and runs on Linux. Pin
a tag (`@v1`), not `@main`, so a harness change can't break your CI
unannounced.

## Release process

Releases are driven by [changesets](https://github.com/changesets/changesets).
Nobody tags by hand — the [Release workflow](.github/workflows/release.yml)
does it when a release PR merges into `main`.

1. **Add a changeset to your PR.** If your change should ship to callers of
   the action, run:

   ```bash
   bunx changeset
   ```

   and commit the generated `.changeset/*.md` file: it records the bump level
   and the changelog line. Patch for fixes and internal changes, minor for new
   capability, major for anything that breaks callers of the action (renamed
   inputs, new required setup, changed defaults). Pure docs/CI tweaks don't
   need one.

2. **Merge to `main`.** The Release workflow collects pending changesets into
   a **Version Packages** PR (branch `changeset-release/main`) that bumps
   `package.json` and writes `CHANGELOG.md`. It stays open and keeps absorbing
   changesets until you're ready to release.

3. **Merge the Version Packages PR.** That merge is the release: the workflow
   tags `vX.Y.Z`, creates the GitHub release with the changelog notes, and
   moves the floating major tag (`v1`) that action callers pin — so
   `OpenFn/kit-lightning-integration@v1` picks the release up on its next run.
   A major bump gets a fresh floating tag (`v2`) instead, and callers opt in
   by updating their workflow.

There is no npm publish and no build artifact — the action and the harness run
from source at the tagged commit, so make sure `main` is green (run the suite
locally or dispatch
[`test-lightning-branch.yml`](.github/workflows/test-lightning-branch.yml))
before merging a release.

## Repository layout

```
src/cli.ts                `bun run up|down|stack seed`
src/source.ts             --lightning/--worker specs → checkout or npm version
src/stack.ts              native boot: Lightning (mix phx.server) + worker, stop
src/scenario.ts           seedScenario(): kickstart a scenario, return its manifest
src/testing.ts            useScenario() + the workflow/run API tests are written against
src/manifest.ts           types + helpers for reading a manifest
src/clients/lightning.ts  typed TS wrapper around a running Lightning
src/globalSetup.ts        vitest wiring: up before the suite, down after
scenarios/*.yaml          declarative kickstart scenarios
tests/matchers.ts         toSucceed() / toFailRun(), with log-reporting failures
tests/<boundary>/*.spec.ts  the e2e suites, one dir per component pair (see tests/README.md)
```
