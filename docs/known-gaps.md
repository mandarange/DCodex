# Known Gaps

## 8.1.3 Desktop Bridge evidence gaps

- A build, fixture, or static status cannot prove a real macOS bridge service,
  Codex Desktop restart, provider credential, WebSocket frame round trip, or
  deep feature artifact. These remain `not-run-real` pending target-bound,
  redacted release evidence.
- The release has no alias or fallback path for the removed `sks codex-lb`
  command. It is expected to be unknown; bridge operations use `sks bridge`.
- A disabled or failing inactive profile is not silently substituted. Missing
  and ambiguous model routes are explicit blockers until an operator resolves
  the catalog/route policy.
- A user-owned or ambiguous routing configuration is intentionally not
  rewritten. The safe gap is a fail-closed recovery action, not automatic
  conversion.

## Known Gaps

No P0 blocker is intentionally left open for Codex CLI `rust-v0.133.0` compatibility detection, `codex exec resume --output-schema` fixture coverage, UX-Review generated callout ingestion, text-only fallback blocking, mock-as-real blocking, Image Voxel relation validation, memory summary rebuilds, repeated blocker stops, version drift, or release readiness reporting.

Bounded 1.0.8 claims:

- The Codex hook schema snapshot is `latest` for SKS 1.14.1; the runtime matrix targets `rust-v0.133.0` capability detection and preserves the zero-warning strict subset.
- Codex 0.133 plugin discovery and marketplace config are P1 warning-only unless a route explicitly depends on those surfaces.
- Real UX-Review verification requires a real generated gpt-image-2 annotated callout image and post-fix recapture/re-review evidence for changed screens. Fixture, mock, and unavailable/unlinked imagegen loops are `verified_partial`; unavailable/unlinked imagegen may close as `verified_partial/reference-only` only with source screenshots plus hashes, docs evidence, source Image Voxel anchors, and Honest Mode evidence.
- If Codex App imagegen or Computer Use is unavailable, SKS records a structured blocker such as `imagegen_capability_missing` or `live_capture_blocked`; it does not fabricate screenshots, generated callouts, or fixed-screen evidence.
- Naruto now uses Codex official subagents as execution lanes. Matched official
  `SubagentStart`/`SubagentStop` events prove thread lifecycle, but a stop is not
  classified as successful without a trustworthy structured parent summary
  containing an explicit outcome for that thread. Ambiguous, prose-only, or
  failed parent results fail closed; native process counts are legacy-runtime
  evidence only. Codex App capabilities such as `$imagegen`
  / `gpt-image-2` retain their own route-specific evidence requirements.
  API image fallback remains `api_fallback` evidence and does not satisfy
  Codex App `$imagegen` output proof unless a route explicitly accepts it.
- The README architecture image replacement is a project-bound imagegen handoff, not generic release readiness. It remains blocked until Codex App exposes a real `$imagegen`/`gpt-image-2` output file created after the current prompt contract; `npm run imagegen:readme-architecture` records the blocker and refuses old generated files, API/codex-lb fallbacks, and moved files without Codex output metadata.
- Codex Python SDK auth and richer TurnResult integration are P1 warning-only review items; no live SDK accuracy or performance claim is made.

P1 future enhancements:

- Wire a real Codex App-hosted imagegen adapter once the host exposes a callable artifact handoff to CLI processes.
- Expand real-world doctor probe batching benchmarks across terminal/App launch modes.

## 1.0.7 Known Gaps

No P0 blocker is intentionally left open for Computer Use live evidence mode, Computer Use local-only privacy, Image Voxel linkage-or-reason recording, codex-lb persistence truthfulness, process-only ephemeral warnings, docs truthfulness, or release readiness reporting.

Bounded 1.0.7 claims:

- Computer Use live evidence is opt-in. `probe_only` is the default and `live_capture_success` requires official Codex App/macOS capture capability; unavailable capture records `live_capture_blocked` with a structured reason instead of fabricated evidence.
- Computer Use screenshots are local-only by default. Shared TriWiki can record metadata/anchors, but screenshot binaries are not published automatically.
- Browser Use evidence and manual screenshots are separate evidence sources, not substitutes for Codex Chrome Extension web evidence or native Computer Use live evidence.
- codex-lb setup reports `durable_env_file`, `durable_keychain`, `shell_profile`, `process_only_ephemeral`, or `none` according to actual setup choices and effects. `--launchctl` is base URL only and removes API-key launchd env values. If all durable choices are off, the next shell may require setup or explicit environment variables again.
- Recovery commands: `sks computer-use smoke --json`, `sks computer-use smoke --real --capture-screenshot --json`, and `sks bridge repair --json`.

P1 future enhancements:

- Broaden real-world macOS Screen Recording/Accessibility detection once Codex App exposes a stable capture API to CLI processes.
- Add more fixture permutations for GUI-launch environment propagation across shells and managed macOS profiles.

## 1.0.6 Known Gaps

No P0 blocker is intentionally left open for latest Codex hook schema validation, category-aware strict-subset semantic hook validation, hook trust warning-zero release gates, codex-lb setup plan/apply truthfulness, codex-lb missing-env prevention, or optional Computer Use live smoke status.

Bounded claims:

- A local Codex CLI older than `0.133.0` reports `compatibility_degraded`; release hook validation still uses the vendored `latest` snapshot and semantic validator.
- Live Codex Chrome Extension availability depends on Codex App/browser setup. If it is missing, web/browser/webapp QA and UX routes halt until the user completes setup. Live Computer Use availability depends on Codex App and macOS permissions and is only for native Mac/non-web targets. If either official capability is blocked or unavailable, SKS records the status and does not fabricate visual evidence. Real native smoke remains opt-in with `SKS_TEST_REAL_COMPUTER_USE=1`.
- codex-lb health checks can still report structured network/auth blockers; the fixed invariant is that raw missing `CODEX_LB_API_KEY` messages and secret leaks are release failures.
- The 1.0.6 black-box fixtures validate warning-zero, strict-subset classification, setup plan/apply truthfulness, codex-lb missing-env prevention, and no forbidden Computer Use wording; broader real-world Codex App/OS capability permutations remain environment-dependent.

0.9.20 strengthens the core trust kernel, but these claims remain bounded:

- Real model/native-agent speedup is not claimed unless `real_parallel=true`, parsed outputs are present, and benchmark artifacts pass.
- Fixture and mock route completions are `verified_partial`, not live production evidence.
- `sks bench blackbox` records the budget surface; full package install execution still lives in `npm run blackbox:check` and `npm run blackbox:matrix` with `SKS_REAL_BLACKBOX_MATRIX=1`.
- Some older internal files remain extraction candidates. `npm run architecture:check` warns on files over 1500 lines and fails on 3000-line split-review risk in active `src/`.
- Rust acceleration is optional. JS fallback parity remains the release requirement unless `--require-native` is used.
- Feature quality improved to zero missing fixtures and lower static contracts, but `runtime_mock_verified >= 45` remains a P1 target rather than a 0.9.20 P0 claim.

Static contracts are not runtime verification. They document expected behavior and must be promoted through executable fixtures before being used as completion proof.
# 1.0.3 Known Gaps

No P0 stable-release blocker is intentionally left open for TypeScript-built `dist` runtime, actual typed command registry, package boundary, command import smoke, `sks run --execute`, strict TypeScript suppression gates, feature quality, architecture hard-fail, performance tiers, or Trust Kernel stale/mock/static blocking.

Remaining non-P0 work:

- Broaden DB safety fixture volume and SQL parser edge cases beyond the current release gate.
- Add more native/Rust acceleration paths for large Image Voxel ledgers.
- Legacy `.mjs` source files are retained only outside the published package boundary as compatibility/reference surfaces; the package runtime and command import closure are TypeScript-built `.js` under `dist`.
- Wrongness memory now captures DB, hook, image, trust, and test negative evidence in fixtures; broader real-world classification coverage remains future work and must not be claimed as exhaustive.
- Git collaboration now validates shared memory shards and local runtime ignores, but SKS still does not auto-install Git hooks. Teams must wire `sks git precommit` into their own hook if they want automatic local enforcement.
