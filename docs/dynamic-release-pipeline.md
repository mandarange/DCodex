# Dynamic Release Pipeline (1.20.4)

SKS has a **two-tier** release verification model. Understanding the difference is
critical: only one tier can authorize a publish.

## Tiers

| Tier | Command | Purpose | Authorizes publish? |
|------|---------|---------|---------------------|
| Full hermetic | `npm run release:check` | Runs the complete hermetic gate set (the `&&` chain + parallel DAG). The publish gate. | **Yes** |
| Change-aware (incremental) | `npm run release:check:dynamic:execute` | Runs only the gates whose `affected_by` globs match the changed files (plus always-on), with caching. Fast local/CI feedback. | **No** |
| Environment / real | `npm run release:real-check` | Runs gates that need a real Codex or Imagegen environment. Reports proven / integration_optional / blocked honestly. | Required alongside full check for publish |

## release:check:dynamic vs release:check:dynamic:execute

- `release:check:dynamic` — **plan only**. Selects + reports which gates *would* run for the current change set, and self-proves two invariants (docs-only changes never select real/heavy gates; publish mode never drops a `required_for_publish` gate). It does not execute anything.
- `release:check:dynamic:execute` — the **runner**. Default mode executes the selected hermetic gates; `--plan-only` reverts to planning; `--publish` selects every `required_for_publish` gate.

Both are **standalone** scripts — they are intentionally NOT members of the
`release:check` chain, the DAG, or the gate manifest (`release-gates.v2.json`).
Adding them would recursively invoke the entire gate set.

## Execution model (`release:check:dynamic:execute`)

1. Detect changed files (`git diff` vs `origin/main` merge-base + working tree).
2. `selectGates(manifest, changedFiles, {publish})` → `{selected, skipped}`.
3. Real/heavy gates (`cost: 'real' | 'heavy'`) are **deferred** to `release:real-check`
   (recorded in `skipped` with reason `deferred_to_real_check`) — never run incrementally.
4. For each selected **hermetic** gate, build a cache key from: gate id, command,
   package version, git HEAD, `dist/build-manifest` source digest, env mode, and the
   sha256 of every file matching the gate's `affected_by` globs.
5. Cache **hit** (recorded + `ok`) → skip the run, record in `cache_hits`.
   **Miss** → spawn `npm run <id>`, time it, and cache the result **only on success**
   (failed gates always re-run; failures are never served as hits).
6. Write the cache and a `sks.release-check-dynamic.v2` report
   (`.sneakoscope/reports/release-check-dynamic-execute.json`):
   `{mode, selected, skipped, executed, cache_hits, failures, ok, invariants}`.

The cache file (`.sneakoscope/reports/gate-cache.json`, schema
`sks.release-gate-cache.v1`) is shared with `release:gate-budget`, which reads
`duration_ms`/`gate_id` to report slow gates — the executor uses the existing
`recordGateResult` API and does not change the cache schema.

## Publish policy

A dynamic (incremental) run **cannot** authorize an npm publish: it deliberately
narrows the gate set to changed inputs and caches results. Publishing requires a
full `npm run release:check` plus `npm run release:real-check`. See
`docs/release-readiness.md`.
