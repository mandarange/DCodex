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

## Architecture-hardening sandbox

The provider architecture has a separate hermetic runner:

```bash
npm run build:incremental --silent
node --test test/e2e/architecture-hardening/hermetic-sandbox.test.mjs
```

[`run.mjs`](../scripts/architecture-hardening-sandbox/run.mjs) starts a worker
with fresh temp `HOME`, `CODEX_HOME`, and `SKS_HOME`. The child receives no
ambient provider credentials. Four loopback fixture servers represent Codex
LB, OpenRouter, ChatGPT OAuth, and the native catalog. The matrix covers the
three exclusive modes, credential withdrawal, session/child pinning,
four-stage success and partial failure, catalog offline/restart behavior,
bounded pause/resume, graph writer locking, and secret-safe output.

All generated paths are enumerated relative to the sandbox root, and the
runner asserts that every write is inside it. It never reads or cleans the real
user home, Codex configuration, or Keychain. Set
`SKS_ARCHITECTURE_KEEP_SANDBOX=1` only when a retained local evidence directory
is useful; the default removes the temp root.

Live evidence is a separate field. The optional probe runs only with all of:

```text
CODEX_LB_API_KEY
CODEX_LB_BASE_URL
SKS_ARCHITECTURE_LIVE_APPROVED=1
```

It additionally requires a working `codex` executable, validates the base URL
as HTTPS or loopback HTTP, and sends one bounded Responses protocol check. The
key is never a command argument or report field. Missing inputs produce
`not_verified: secret_injection_required` (or an explicit approval/runtime
reason); fixtures never substitute for them.

Production menu-bar QA is intentionally separate:

```bash
node native/sks-menubar/UITests/run-signed-restart-qa.mjs
```

That runner requires explicit approval, a production Developer ID app, and an
`.xctestrun` bundle. Without them it reports `not_verified` and does not launch
or modify a user app.
