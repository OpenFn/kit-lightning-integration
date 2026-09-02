# lightning-worker-contract-tests

Run real end-to-end tests between Lightning and the worker, with either side
built from any branch.

## Quickstart

```bash
bun install
bun run up --lightning ../lightning    # or a branch: --lightning main
```

That boots a real Lightning at <http://localhost:4003> from whatever source
you pointed at. When you're done:

```bash
bun down
```

(`bun up` is taken by bun itself — an alias of `bun update` — hence
`bun run up`. `bun run stack up|down` also works.)

### What you need installed

- **bun** — runs the harness. **node** too: Lightning's assets and the worker
  run on node, as they do in production.
- **Elixir/Erlang** matching Lightning's `.tool-versions` (asdf picks it up
  automatically inside the checkout).
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

Remote refs are cloned into `.cache/lightning/` and reused; a local checkout
is used in place. The first boot of a fresh clone compiles everything (a few
minutes) — after that it's fast.

Under the hood, `up` runs the same steps a Lightning dev would: the
`bin/bootstrap` prep sequence (deps, assets, runtime, db create + migrate),
then `mix phx.server`, and waits for `/health_check`. Logs stream to
`tmp/lightning.log`; `down` stops the server and drops the harness database.

## Running the tests

```bash
bun run test                          # boots Lightning, runs the suite, stops it
LIGHTNING=../lightning bun run test   # ...against a local checkout
KEEP_STACK=1 bun run test             # leave Lightning running afterwards
```

> `bun run test` runs the vitest suite — a bare `bun test` would invoke bun's
> own test runner instead.

**Status:** the harness can boot Lightning from any ref. It does not yet seed
test data (via [Kickstart, lightning#5026](https://github.com/OpenFn/lightning/pull/5026))
or attach a worker, so the e2e suite currently skips itself.

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
src/cli.ts              `bun run up|down` (and `bun run stack up|down`)
src/source.ts           --lightning spec → checkout (shallow clone cache)
src/stack.ts            native boot: prep checkout, mix phx.server, health, stop
src/globalSetup.ts      vitest wiring: up before the suite, down after
src/clients/lightning.ts  typed TS wrapper around a running Lightning
scenarios/              declarative kickstart scenarios (used once seeding lands)
tests/*.spec.ts         the e2e suites
```
