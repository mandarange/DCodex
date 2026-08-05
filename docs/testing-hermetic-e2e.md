# Hermetic E2E Testing

SKS 0.9.18 route E2E tests run in temp project roots instead of the source checkout.

## Helper

`test/e2e/route-real-command-helper.mjs` exposes:

- `createHermeticProjectRoot({ fixtureName, files, setup })`
- `runSksInRoot(root, args, opts)`
- `assertCompletionProofInRoot(root, missionId, route)`
- `assertImageAnchorsInRoot(root, missionId, opts)`
- `assertNoSourceRepoStateMutation(before, after)`

The default `runSks()` helper now creates a temp root, writes a minimal `package.json` and `README.md`, copies deterministic image fixtures, runs `sks setup --local-only --json`, and executes the route with `cwd=tempRoot`.

## Rule

Route tests must inspect the temp root `.sneakoscope/missions/<id>` path. They must not read source checkout latest mission state or rely on `process.cwd()` `.sneakoscope` artifacts.
## 0.9.20 Trust Kernel E2E Additions

Hermetic route tests now include checks that real route commands write:

- `completion-proof.json`
- `route-completion-contract.json`
- `evidence-index.json`
- `trust-report.json`

Representative tests:

- `test/integration/route-finalization-audit.test.mjs`
- `test/integration/trust-report-route.test.mjs`
- `test/integration/evidence-index-route.test.mjs`
- `test/integration/sks-run-happy-path.test.mjs`
- `test/integration/sks-run-visual-path.test.mjs`

## Desktop Bridge architecture sandbox

The provider architecture has a separate hermetic runner:

```bash
npm run build:incremental --silent
node --test test/e2e/architecture-hardening/hermetic-sandbox.test.mjs
```

[`run.mjs`](../scripts/architecture-hardening-sandbox/run.mjs) starts a worker
with fresh temp `HOME`, `CODEX_HOME`, and `SKS_HOME`. The child receives no
ambient provider credentials. Loopback fixtures represent Codex-LB,
OpenRouter, ChatGPT OAuth identity, and the combined catalog. The matrix covers
one bridge runtime with both provider profiles, explicit route-index
resolution with no fallback, credential withdrawal, session-pin affinity and
tamper rejection, four-stage success and partial failure, catalog
offline/restart recovery, write confinement, and secret-safe output.

All generated paths are enumerated relative to the sandbox root, and the
runner asserts that every write is inside it. It never reads or cleans the real
user home, Codex configuration, or Keychain. Set
`SKS_ARCHITECTURE_KEEP_SANDBOX=1` only when a retained local evidence directory
is useful; the default removes the temp root.

Live evidence is separate:

```bash
npm run desktop-bridge:real-evidence
```

The check consumes only explicitly supplied inputs, validates provider
endpoints, and never places a key in argv or report fields. Missing inputs are
reported as `not-run-real`; fixtures never substitute for them. Its report is
diagnostic and non-release-authorizing, so release evidence must still include
the target-bound real macOS, OAuth, provider, WebSocket, and native artifact
receipts required by the implementation report.

Production menu-bar QA is intentionally separate:

```bash
node native/sks-menubar/UITests/run-signed-restart-qa.mjs
```

That runner requires explicit approval, a production Developer ID app, and an
`.xctestrun` bundle. Without them it reports `not_verified` and does not launch
or modify a user app.
