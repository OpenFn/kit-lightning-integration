# lightning-worker-contract-tests

End-to-end integration tests for the **Lightning ↔ ws-worker** boundary
([lightning#4784](https://github.com/OpenFn/lightning/issues/4784)).

The only real coupling between [`OpenFn/lightning`](https://github.com/OpenFn/lightning)
and [`OpenFn/kit`](https://github.com/OpenFn/kit) is the WebSocket protocol the
`@openfn/ws-worker` speaks to Lightning's `/worker` channel (JWT auth, run
claim/start/log/complete). Each repo tests that boundary against a *fake* of the
other; this harness runs **real Lightning × real worker**, built from any branch,
and drives them as a black-box integrator (webhooks in, run results out).

## Prerequisites

- **Elixir/Erlang** matching Lightning's `.tool-versions` (asdf picks it up
  automatically inside the checkout), plus **node**.
- On ARM hosts (Apple Silicon): **Rust**, to build the `rambo` dep from source
  — the same prerequisite Lightning's own `bin/bootstrap` enforces.
- **Postgres** reachable at `DATABASE_URL` (default
  `postgres://postgres:postgres@localhost/lightning_test_e2e`) — run it however
  you already do.
Booting works against any Lightning ref; the
[Kickstart PR (lightning#5026)](https://github.com/OpenFn/lightning/pull/5026)
only becomes required at the seeding milestone.

## Boot Lightning

One command — the harness resolves the source, clones it if remote, prepares
the checkout (deps, assets, runtime, db create + migrate — the same sequence as
Lightning's `bin/bootstrap`), runs `mix phx.server` detached, and waits until
it's healthy:

```bash
npm ci
npm run stack -- up --lightning main
```

`--lightning` (or the `LIGHTNING` env var) accepts:

| Spec                      | Meaning                                        |
| ------------------------- | ---------------------------------------------- |
| `main`                    | branch, tag, or SHA on `OpenFn/lightning`      |
| a full 40-char SHA        | any commit (git can't fetch abbreviated SHAs)  |
| `owner/repo#ref`          | branch/tag/SHA on a fork                       |
| `../lightning`            | a local checkout, used as-is                   |

Lightning comes up at <http://localhost:4003> (its log streams to
`tmp/lightning.log`). Stop it with:

```bash
npm run stack -- down
```

The first boot of a fresh clone compiles everything (a few minutes); reruns are
fast. Remote refs are cached in `.cache/lightning/`.

## Run the tests

```bash
npm test                          # boots Lightning, runs the suite, stops it
LIGHTNING=../lightning npm test   # ...against a local checkout
KEEP_STACK=1 npm test             # leave Lightning running afterwards
```

> **Status:** the e2e suite is skipped until the harness seeds a scenario via
> Kickstart and writes `tmp/manifest.json` (API token, webhook paths), and the
> worker isn't attached yet — both are next milestones. Booting from any ref
> (above) is what works today.

## CI

`.github/workflows/test-lightning-branch.yml` (manual `workflow_dispatch`)
runs the suite against any Lightning repo/ref, with postgres as a service
container. Cross-repo triggers with pass/fail checks posted back on the source
commit are planned.

## Layout

```
src/cli.ts           `npm run stack -- up|down`
src/source.ts        --lightning spec → checkout (shallow clone cache)
src/stack.ts         native boot: prep checkout, mix phx.server, health, stop
src/globalSetup.ts   vitest wiring: up before the suite, down after
src/client.ts        black-box HTTP client (webhook + JSON API)
scenarios/*.json     declarative kickstart scenarios
tests/*.spec.ts      the e2e suites
```

## Roadmap

1. ~~Boot Lightning from any GitHub ref or local path~~ ✅
2. Run the worker from a kit branch, local path, or npm version
3. Seed a scenario via Kickstart; save the manifest for tests
4. First e2e test green: webhook → worker → successful run
5. Sync-webhook canary test (the kit#1306 / lightning#4531 regression)
6. CI: caching, nightly main × main, cross-repo triggers
