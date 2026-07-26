# Release DAG

`release-gates.v2.json` is the source of truth for public release checks. `npm run release:check` runs the change-aware affected DAG for ordinary local checks. The bounded implementation handoff is typecheck, one clean build, focused changed-surface tests, `release:check:affected`, one `release:check:confidence`, and `npm pack --dry-run --ignore-scripts --json`.

`npm run release:check:full` belongs only to the distinct repository-maintainer publication workflow. It performs exactly one clean build, runs the canonical recursive test suite exactly once (this writes the publish-required canonical test proof), runs the full release-preset DAG without re-running those same unit suites, verifies the environment-dependent real-check summary, rechecks dist freshness, and writes the release stamp only after that chain completes. Focused `test:*` suites stay on the `incremental` preset so affected/fast/confidence can still select them without duplicating the canonical suite during publish. Optional host repair stays on `sks doctor --fix` and is not part of the stamp chain. Publish preflight reuses that proof and never recompiles or reruns the canonical suite.

Gates declare resources, side-effect class, cache inputs, timeout, isolation, and preset. Hermetic gates run in temporary home and Codex home directories. Real checks use the `real-check` preset and require operator-controlled environment variables.

The full-coverage gate verifies that important package scripts are represented in the release DAG and that the required hardening gates are release-preset members.

Use `npm run gates:run -- --preset affected --changed-since auto --explain` to inspect the planned DAG, and use `npm run release:real-check` only on a host where the required real dependencies are installed and intentionally enabled.
