# lightning-worker-contract-tests

Cross-repo contract tests for the **Lightning ↔ ws-worker** boundary.

The only real coupling between [`openfn/lightning`](https://github.com/OpenFn/lightning)
and [`openfn/kit`](https://github.com/OpenFn/kit) is the WebSocket protocol the
`@openfn/ws-worker` speaks to Lightning's `/worker` channel (JWT auth, run
claim/start/log/complete). Each repo currently tests that boundary against a
*fake* of the other:

- Lightning's `test/integration/web_and_worker_test.exs` runs the **real** worker
  against **real** Lightning — but pinned to one worker version.
- kit's `integration-tests/worker/` runs the **real** worker against
  `@openfn/lightning-mock`.

This repo closes the gap: **real Lightning × real worker**, exercised as a
black-box client, across a **version matrix** so a breaking change on *either*
side is caught. Both repos' CI fire a `repository_dispatch` here on merge.

## How it works

1. `docker-compose.yml` stands up Postgres + `openfn/lightning:${LIGHTNING_TAG}`
   + `openfn/ws-worker:${WORKER_TAG}`, wired on the `/worker` channel with a
   shared `WORKER_SECRET` and matching run-token keys.
2. On setup we provision Lightning from a declarative **scenario** (a webhook
   workflow) using its own `Lightning.Bootstrap`, mint an API token, and write a
   `tmp/manifest.json` describing the webhook URL + token. **No Lightning code
   changes required** — this rides on shipped modules via `bin/lightning rpc`.
3. Tests POST to the webhook and poll the JSON API for the resulting
   WorkOrder/Run state — pure black-box, identical to how a real integrator uses
   Lightning.

## Run it locally

> **Note:** the harness provisions via `Lightning.Bootstrap`, which is not yet in
> a published `openfn/lightning` image. Until it ships, run against a local
> Lightning checkout (build from source) — see [Testing a branch](#testing-a-branch).
> The plain image-based flow below only works once Bootstrap is in an image.

```bash
cp .env.example .env        # or: ./bin/gen-secrets.sh   (generates real throwaway keys)
npm ci

# Recommended today — build Lightning from a local checkout (any branch):
COMPOSE_FILE=docker-compose.yml:docker-compose.lightning-src.yml \
LIGHTNING_SRC=/path/to/lightning \
DOCKER_PLATFORM=linux/arm64 \       # native build on Apple Silicon
HARNESS_BUILD=1 \
npm test

# Image-based (once openfn/lightning includes Bootstrap):
#   docker compose pull && npm test
```

Useful env:

| Var             | Default              | Meaning                                      |
| --------------- | -------------------- | -------------------------------------------- |
| `LIGHTNING_TAG` | `latest`             | `openfn/lightning` image tag to test         |
| `WORKER_TAG`    | `latest`             | `openfn/ws-worker` image tag to test         |
| `KEEP_STACK`    | *(unset)*            | if set, don't tear the stack down after tests |
| `LIGHTNING_BIN` | `/app/bin/lightning` | release binary path inside the web container |

## Testing a branch

Two ways, depending on whether the branch is published as an image.

### From local source (no publish needed)

Build the image straight from a checkout — ideal for unreleased branches (e.g.
Lightning's `bootstraper`). Overlay `docker-compose.lightning-src.yml` and/or
`docker-compose.worker-src.yml` and set `HARNESS_BUILD=1`. You can build one side
and pull the other:

```bash
# Build Lightning from local source; pull the worker image as usual.
COMPOSE_FILE=docker-compose.yml:docker-compose.lightning-src.yml \
LIGHTNING_SRC=/path/to/lightning \
DOCKER_PLATFORM=linux/arm64 \   # native build on Apple Silicon
HARNESS_BUILD=1 \
npm test

# Build both from source:
COMPOSE_FILE=docker-compose.yml:docker-compose.lightning-src.yml:docker-compose.worker-src.yml \
LIGHTNING_SRC=/path/to/lightning WORKER_SRC=/path/to/kit \
DOCKER_PLATFORM=linux/arm64 HARNESS_BUILD=1 \
npm test
```

`HARNESS_BUILD=1` makes globalSetup run `docker compose build` instead of
pulling. Whatever branch is checked out at `LIGHTNING_SRC` / `WORKER_SRC` is what
gets tested.

### From a published branch tag

If the source repo's CI publishes a per-branch/commit tag (see the prerequisite
below), just select it — no build:

```bash
LIGHTNING_TAG=main WORKER_TAG=v1.27.1 npm test
```

## CI / triggering

`.github/workflows/contract.yml` runs on `repository_dispatch`
(`lightning-updated` / `worker-updated`) and on manual `workflow_dispatch`. Each
source repo dispatches on merge with the new image tag.

### Prerequisite (one-time, in each source repo)

Both repos must publish a **per-commit / branch tag** (e.g. `:main`) — kit today
only pushes `openfn/ws-worker` on release tags. Add to each repo's release/merge
CI:

```yaml
- uses: peter-evans/repository-dispatch@v3
  with:
    token: ${{ secrets.CONTRACT_TESTS_DISPATCH_TOKEN }}
    repository: OpenFn/lightning-worker-contract-tests
    event-type: lightning-updated          # or worker-updated
    client-payload: '{"lightning_tag":"main","worker_tag":"latest"}'
```

## Layout

```
docker-compose.yml        parameterized Lightning + worker + postgres
.env.example              test-only secrets (regenerate with bin/gen-secrets.sh)
scenarios/*.json          declarative Lightning.Bootstrap scenarios
scripts/provision.exs     rpc'd into the web container to seed + emit manifest
src/globalSetup.ts        up --wait, migrate, provision, (teardown)
src/client.ts             black-box HTTP client (webhook + JSON API)
src/manifest.ts           reads tmp/manifest.json
tests/*.spec.ts           the contract suites
```
