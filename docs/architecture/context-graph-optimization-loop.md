# Context Graph optimization loop

The Context Graph ships with a locked benchmark and a single tuning surface. The
optimization loop is the narrow, auditable bridge between the two: it measures
in-memory parameter overrides against that benchmark and, at most, writes a
*proposal* that a human reads and applies by hand.

It is not an autonomous code modifier. Nothing in `optimizer/` can produce, stage,
or apply a source edit, and nothing in it can commit, push, merge, or publish.

```text
checked-in tuning ──► baseline experiment ──► composite C0
                                                  │
 candidate (structured numeric overrides)          │
   │  validate: allowlist, integrity, bounds       │
   ├─ refused ─────────────────────────────► logged, never run
   ▼                                               │
 resolve in memory (clones, never files)           │
   ▼                                               │
 benchmark, identical corpus + identical budget    │
   ├─ any hard floor red ──────────────────► discarded immediately
   ├─ composite ≤ C0 ──────────────────────► discarded, no artifact
   └─ composite > C0 ──────────────────────► proposal artifact + human review
                                                  │
 working-tree fingerprint re-checked after every experiment
```

## What a candidate may change

Exactly two files, and only their numeric values and profile edge sets:

| Target name      | File                                                    |
| ---------------- | ------------------------------------------------------- |
| `ranking-config` | `src/core/triwiki/context-graph/query/ranking-config.ts` |
| `profiles`       | `src/core/triwiki/context-graph/profiles.ts`             |

A candidate addresses a value by `{ target, pointer, value }` — a structured
override, never patch text. Pointers are derived from the live configuration
objects rather than transcribed, so a weight added to either file becomes tunable
automatically and a removed one stops being addressable.

- `ranking-config` pointers are dot paths inside the ranking configuration:
  `depthDecay`, `seedConfidenceScore.exact_definition`,
  `edgeConfidenceMultiplier.observed`, `redundancyPenalty`, …
- `profiles` pointers cover both the profiles and the traversal caps:
  `profiles.review.edgeWeights.gated_by`, `profiles.implementation.maxDepth`,
  `traversalCaps.maxSelectedNodes`, …

Edge sets are tuned through weights, because the traversal already skips any edge
whose profile weight is not positive. Driving a weight to zero removes that edge
from the profile; giving a positive weight to an edge the profile does not carry
adds it. The declared `edges` list is rebuilt from the weights so the two can
never disagree.

Every pointer carries a bound derived from the checked-in value and a named rule
(`profile_depth`, `profile_edge_weight`, `traversal_cap`, `unit_interval`,
`count`, `negative_bonus`, `weight`). A value outside its bound is rejected before
anything runs, and a count parameter refuses a fractional value.

## What a candidate may never change

| Class         | Examples                                                                 | Result                          |
| ------------- | ------------------------------------------------------------------------ | ------------------------------- |
| `measurement` | `config/context-graph-benchmark.json`, anything under `benchmark/` (corpus, fixtures, metrics, floors, scorer) | **integrity violation** |
| `forbidden`   | every other file in the repository                                        | rejection                        |

The two classes are deliberately asymmetric. Naming a random source file is an
ordinary rejection. Naming the corpus, a fixture, or the scoring code is an
integrity violation reported at the highest severity, because a loop that can move
the bar it is measured against is not measuring anything. When a single candidate
does both, the integrity verdict wins.

Classification is fail-closed: an absolute path, a path that escapes the
workspace, or anything unrecognised is `forbidden`, never `tunable`. Both the
source benchmark directory and its compiled mirror are treated as measurement, so
swapping the built scorer is the same violation as swapping the source.

## How integrity is enforced

Four independent mechanisms, all of them checked rather than asserted:

1. **Allowlist classification** — every override's target is classified before a
   single benchmark case runs. A refused candidate never reaches the benchmark
   and never constructs an adapter.
2. **In-memory resolution** — overrides are applied to clones of the checked-in
   configuration objects. The module-level constants are never mutated, and no
   file is written for an experiment.
3. **Working-tree fingerprint** — the two tuning files plus the whole measurement
   surface are content-hashed before the first experiment and again after every
   one of them. Any difference names the file and the reason
   (`mutated` / `added` / `removed` / `deleted` / `created`), the experiment is
   recorded as `discarded_integrity`, and the run aborts with
   `working_tree_mutated`. A failed experiment therefore cannot be left behind in
   the working tree.
4. **Benchmark integrity** — the corpus hash and the scoring-code hash reported by
   the harness are carried into every log row and into the proposal receipt. A
   corpus hash mismatch aborts the run as `benchmark_integrity_failure` before any
   candidate is scored.

Hard floors are consulted before the composite. A candidate that trips a floor is
discarded on the spot, whatever its score says, so a safety regression can never
be traded against a latency or token win. The baseline is held to the same rule:
a baseline that fails a floor aborts the whole run rather than becoming a lower
bar for the candidates.

## The loop, in order

1. Fingerprint the guarded surface.
2. Run the **baseline** experiment on the checked-in tuning. Record its composite.
3. For each candidate, in the order it was generated:
   1. validate — refused candidates are logged and skipped without running;
   2. resolve the overrides in memory;
   3. run the benchmark with the *same* corpus, case list, and cold/warm iteration
      counts as the baseline;
   4. discard immediately on any hard-floor failure or integrity failure;
   5. keep only when the composite strictly improves on the baseline composite and
      the run still clears the corpus improvement threshold;
   6. re-fingerprint; drift aborts the run.
4. Append one row per experiment to the bounded JSONL log.
5. Emit a proposal artifact for each kept candidate. Nothing else is written.

The budget is frozen once per run and reused for every experiment, so no candidate
is ever measured against a cheaper or a longer budget than the baseline. A wall
clock budget bounds the run; candidates past it are logged as `skipped_budget`
rather than silently dropped.

Candidates are enumerated, not invented: a plan names pointers and multipliers and
the generator emits one single-parameter override per pair, in a fixed order, with
deterministic ids. Single-parameter on purpose — a one-pointer delta is the only
kind a reviewer can attribute a score change to without re-running the sweep.

## How to run it

The loop is a library entry point. It adds no CLI command, no daemon, no
scheduler, and no external service.

```ts
import { runContextGraphOptimizerLoop } from '.../context-graph/optimizer/index.js';

const result = await runContextGraphOptimizerLoop({
  root,
  // Build the baseline/candidate adapter pair for one experiment's tuning.
  // The loop never constructs a retrieval engine itself.
  adapters: ({ tuning }) => [lexicalBaselineAdapter(), graphCandidateAdapter(tuning)],
  caseIds: ['command-handler-route-pipeline-gate'],
  coldIterations: 1,
  warmIterations: 3,
  maxCandidates: 8
});
```

`adapters` receives the resolved tuning — the ranking configuration, the profiles,
and the traversal caps — and returns the two adapters the benchmark measures. That
is the only injection point; the benchmark driver itself can also be injected, but
only so tests can drive the decision logic without materializing fixtures.

Passing `writeArtifacts: false` makes the loop decide without persisting anything,
which is the right setting for an exploratory run.

## Artifacts

| Artifact  | Path                                                                   |
| --------- | ---------------------------------------------------------------------- |
| Log       | `.sneakoscope/reports/context-graph-experiments.jsonl`                  |
| Proposal  | `.sneakoscope/reports/context-graph-optimizer/<candidate-id>.patch.json` |

Both live under the ignored report directory. Both are leak-scanned with the
benchmark's own rules before they are written; anything that trips a rule is
dropped rather than persisted, and the run notes which rule fired. The log is
appended through the bounded JSONL helper, so it rotates instead of growing without
limit.

Every field in both artifacts is an id, a code, a pointer, or a number. No
absolute path, no home path, no environment value, no prompt, no tool output, no
file content.

## How to review and apply a candidate

A proposal is a proposal. The artifact says so in its own `reviewRequired` field
and in its `applyInstructions`, and every log row repeats it.

To review one:

1. **Read the overrides.** Each carries the file, the pointer, the value it came
   from, the value proposed, the bound it sat inside, and the rule that produced
   that bound. Confirm the direction makes sense as a retrieval argument, not just
   as a number that went up.
2. **Check the receipt.** It records the corpus revision, the corpus hash, the
   scoring-code hash, the frozen budget, and the surface digest. If the corpus
   hash does not match the corpus in your tree, the proposal was measured against
   a different bar — discard it.
3. **Reproduce.** Re-run the loop with the receipt's budget on your own machine
   and confirm the composite delta reappears. Latency-sensitive components make a
   thin delta machine-dependent; a delta that does not reproduce is noise.
4. **Confirm the floors are green.** A proposal is only emitted when they were,
   but confirm it in the fresh run rather than trusting the artifact.
5. **Apply by hand**, one pointer at a time, editing only the two tuning files.
   The loop deliberately gives you no way to apply the change automatically.
6. **Re-run the benchmark and the full test suite** after the edit, and include
   the before/after composites in the change description.

Reject the proposal if the delta does not reproduce, if any hard floor is anything
other than green, if the improvement is inside the noise of your machine, or if
the change cannot be justified beyond "the score went up". A benchmark win is
evidence, not a decision.

## Outcomes recorded in the log

| Outcome                | Meaning                                                        |
| ---------------------- | -------------------------------------------------------------- |
| `baseline`             | the checked-in tuning, measured first                           |
| `kept`                 | improved the composite with every floor green; artifact emitted |
| `discarded_no_gain`    | ran cleanly, did not improve the composite                      |
| `discarded_floor`      | tripped a hard floor; score never consulted                     |
| `discarded_integrity`  | benchmark integrity failed, or the working tree drifted         |
| `discarded_error`      | the adapter or the harness failed                               |
| `rejected`             | named a non-allowlisted file, or an invalid pointer/value       |
| `integrity_violation`  | named the benchmark corpus, a fixture, or the scoring code      |
| `skipped_budget`       | valid, but the run's wall-clock budget was exhausted            |
