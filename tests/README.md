# Test layout

Suites are grouped by the **boundary** they exercise, then by the **kind of
contract** under test — one directory per pair of components, one file per
behaviour:

```
tests/
  matchers.ts                 toSucceed() / toFailRun(), registered for every suite
  lightning-worker/           Lightning <-> @openfn/ws-worker (the /worker channel)
    happy-path.spec.ts        webhook -> claim -> run -> success
    sync-webhook.spec.ts      after_completion triggers: the HTTP reply is built from run:complete
    exit-reasons.spec.ts      each worker exit reason → Lightning's stored state + error_type
```

Future boundaries get their own directory alongside (e.g. `lightning-cli/`
for the provisioning/deploy API). Fixtures live in `scenarios/`; a suite names
the one it needs with `useScenario()`, and each scenario uses its own project
so kickstart's convergence can't disturb another suite's data.
