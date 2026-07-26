# Loop Runtime

SKS treats the user goal as intent and the Loop Graph as the execution SSOT. A request is decomposed into mini-loops, each with a bounded owner scope, budget, durable state, run log, maker/checker policy, local gates, lease, and proof.

The runtime writes artifacts under `.sneakoscope/missions/<mission>/loops`: `loop-plan.json`, per-loop `loop-state.json`, `loop-run-log.jsonl`, `loop-budget.json`, `loop-proof.json`, gate outputs, patch candidates, and the final `loop-graph-proof.json`.

Maker and checker worker counts are derived from owner scope size, risk, and parallelism mode. Checker workers are read-only native review workers; `noMutation` only means read-only and must not silently switch the checker path to deterministic fixtures.

Deterministic loop worker fixtures are test-only. They require `SKS_LOOP_RUNTIME_FIXTURE=1` plus a recognized test/check context such as release check scripts, Node test env, or hermetic temp loop checks. Production/runtime loop execution must fail closed instead of falling back to fixture verification.

Loop levels are `L0-report`, `L1-assisted`, `L2-action`, and `L3-unattended`. New domains do not start at L3, high or critical risk cannot run unattended, L2 requires a checker, and any source mutation requires GPT final arbitration before integration completes.

The CLI surface is `sks loop plan`, `sks loop run`, `sks loop status`, `sks loop proof`, `sks loop kill`, `sks loop resume`, and `sks loop graph`.

## 3.1.2 Production Hardening

Fixture policy is shared across worker, gate, GPT-final, and merge-adjacent checks. A fixture request is allowed only from release check or blackbox scripts, `M-check-*` missions, temp roots, or explicit test runtime env. Production-like `sks loop run`, `sks goal`, and `sks naruto` commands fail closed when `SKS_LOOP_GATE_FIXTURE`, `SKS_LOOP_RUNTIME_FIXTURE`, or `SKS_LOOP_GPT_FINAL_FIXTURE` is set.

`gpt:final-arbiter` is a selector/gate-runner pseudo gate only. The gate artifact is marked `handled_by: loop-finalizer` and points to `.sneakoscope/missions/<mission>/loops/gpt-final-arbiter-gate-contract.json`; the finalizer writes the real arbiter proof and cross-reference in `loop-graph-proof.json`.

Integration merge records a strategy ladder instead of relying on plain `git apply`: `git apply --check`, `git apply`, `git apply --3way --check`, `git apply --3way`, cherry-pick when a loop commit exists, optional no-commit branch merge, then conflict handoff. Same-file conflicts block unless an explicit compatibility proof exists.

The side-effect report is built before GPT final arbitration from loop proofs, worktree diffs, gate artifacts, integration merge results, and `.sneakoscope/missions/<mission>/loops/mutation-ledger.jsonl`. Owner-scope violations, package/release metadata mutations outside integration, global config mutations, and non-hermetic gate side effects block deterministically; a local model or GPT final approval cannot override those blockers.

Loop kill is both checkpoint-aware and interrupt-aware. The runtime still writes phase-boundary checkpoints for resume, but active worker handles are registered in `active-worker-handles.jsonl`; `sks loop kill <loop-id>` writes a kill request and immediately attempts SIGTERM/SIGKILL or session interruption where supported. Resume skips completed loops by default and reruns interrupted or blocked loops.

Loop concurrency is recorded in `concurrency-budget.json`: max active loops, max active workers, max model calls, per-loop maker/checker allocations, and headroom. `SKS_LOOP_MAX_ACTIVE_LOOPS`, `SKS_LOOP_MAX_ACTIVE_WORKERS`, and `SKS_LOOP_MAX_MODEL_CALLS` override the computed budget for release and blackbox checks.
