# Context Graph Benchmark

The locked measurement harness for the TriWiki Context Graph. It exists to answer one
question with evidence rather than opinion: **is graph-backed context retrieval actually
faster, cheaper and more accurate than the current lexical context mode?**

Everything in this harness is designed so that the answer cannot be improved by editing
the harness. The corpus is hashed, the scoring code is hashed, the gold sets are sets of
identifiers rather than prose, and the hard safety floors are evaluated *before* anything
is scored.

- Corpus (single source of truth): `config/context-graph-benchmark.json`
- Harness: `src/core/triwiki/context-graph/benchmark/`
- Report artifact: `.sneakoscope/reports/context-graph-benchmark.json`

`sks.context-graph-benchmark-corpus.v1` and `sks.context-graph-benchmark.v1` are machine
schema revisions. They are not product version numbers and say nothing about a release.

---

## How to run it

The benchmark takes retrieval implementations as **injected adapters**. It never imports
the query engine or an extractor, which is what lets the harness be reviewed and trusted
independently of the thing it measures. There is no new CLI command; call it from a script
or a test.

```ts
import { runContextGraphBenchmark } from '../core/triwiki/context-graph/benchmark/index.js';

const report = await runContextGraphBenchmark(
  [lexicalBaselineAdapter, graphCandidateAdapter],
  { root: repositoryRoot, coldIterations: 1, warmIterations: 5, writeReport: true }
);
```

An adapter is three things:

```ts
interface ContextGraphBenchmarkAdapter {
  readonly id: string;                 // 'baseline-lexical' | 'candidate-graph'
  readonly kind: 'baseline' | 'candidate';
  run(query: ContextGraphBenchmarkQuery): Promise<ContextGraphBenchmarkRun>;
}
```

The runner hands the adapter a **materialized hermetic fixture repository** in the system
temp directory — never the real workspace — and the adapter answers with matched
workspace-relative paths and node ids in rank order, the gates and tests it selected, the
write-scope conflicts it detected, its token cost, its latency, whether it was a cache hit,
its provenance coverage, whether it included anything stale or invalidated, and a safety
self-report.

Useful options:

| Option | Meaning |
| --- | --- |
| `caseIds` | Restrict to a subset of corpus cases (the corpus itself is unchanged). |
| `coldIterations` | Cold runs per case. Each cold run gets a **freshly materialized** fixture. |
| `warmIterations` | Warm runs per case, reusing the last cold fixture. |
| `writeReport` | Persist the report under `.sneakoscope/reports/`. |
| `expectedScoringCodeHash` | Pin the scorer; a mismatch is an integrity failure. |
| `keepFixtures` | Leave the temp fixtures on disk for debugging. |

There is no network access, no external API, and no production side effect anywhere in the
harness. Reading the git SHA and the dirty state *is* allowed — this is the reporting path,
not the query hot path — and only a hash of the porcelain status is stored, never the text.

---

## Cold and warm are never mixed

A cold run is measured against a fixture that was just written to disk. A warm run reuses
that fixture so caches are populated. The two are collected into separate latency buckets
and reported separately (`coldLatency`, `warmLatency`, each with p50 and p95). Nothing
averages them together. A cold run that reports `cacheHit: true` is recorded as a warning,
because it means the warm/cold separation was not honoured.

The headline latency used by the score is **warm p95**; cold p95 is used only when a run
produced no warm samples at all.

---

## What is measured

Per case, per adapter:

- **recall@8** and **precision@8** over the gold path set, in rank order
- **node recall@8** over the gold node ids
- **gate recall** and **protected-gate recall** over the selected gate ids
- **test recall** over the selected test paths
- **write-scope conflict recall** over declared parallel-slice collisions
- **provenance coverage** — the fraction of returned items carrying provenance
- **stale / invalidated exclusion correctness** — including a stale claim, an invalidated
  proof, or any `must_exclude` path fails the case, at *any* rank, not just inside the top k
- **exact-symbol-seed preservation** — a seed that entered as an exact symbol hit must still
  be exact in the answer; a text candidate never gets promoted to exact
- **token cost** and **useful evidence per 1k tokens**
- **warm / cold latency** p50 and p95
- **cache hit rate**

`useful evidence` counts the *distinct gold items actually delivered*. Padding an answer
with extra files therefore raises token cost without raising evidence, and the density
metric falls.

**task-context success** is the strict per-case verdict: the run succeeded, every gold path
was recalled, every gold gate and test was selected, every declared conflict was detected,
every exact seed survived, and nothing excluded leaked in. It is deliberately all-or-nothing
— it models "did the agent get the context it needed to do the task", which is not a
partial-credit question.

---

## Hard safety floors

Floors are evaluated **first**. If any floor fails, the composite score is **not computed at
all** — the report carries `score: null` and the note
`composite_score_withheld:hard_floor_failed`. A leak or a missed protected gate can never be
traded away against a latency win.

| Floor | Limit | Applies to |
| --- | --- | --- |
| `secret_leak_zero` | 0 | every adapter |
| `path_leak_zero` | 0 | every adapter |
| `dangling_edge_zero` | 0 | every adapter |
| `edge_without_provenance_zero` | 0 | every adapter |
| `deterministic_snapshot_zero_mismatch` | 0 | every adapter |
| `stale_graph_silent_fallback_zero` | 0 | every adapter |
| `unsupported_language_exact_mislabel_zero` | 0 | every adapter |
| `project_code_execution_zero` | 0 | every adapter |
| `unbounded_hot_path_scan_zero` | 0 | every adapter |
| `protected_gate_recall_full` | 100% | candidate |
| `write_scope_conflict_recall_full` | 100% | candidate |

The two capability floors are asked only of the candidate. The lexical baseline is the
thing being replaced; it is required to be **safe**, not to be **capable**. If it were held
to protected-gate recall it would fail on every run and no comparison could ever be made.

Leak detection reports **rule ids only**, never the matched text, so a leak report can never
become a second copy of the leak. The serialized report is scanned before it is written; a
report that trips a rule is refused rather than persisted.

---

## Composite score

Computed only after integrity and floors pass. Weights live in the corpus, not in the code,
so re-weighting is a corpus edit and therefore an integrity change.

| Component | Weight |
| --- | --- |
| task-context success | 30% |
| retrieval recall | 20% |
| precision | 15% |
| useful evidence per 1k tokens | 15% |
| latency improvement | 10% |
| token improvement | 10% |

The first three components are absolute (0..1). The last three are relative and symmetric:
the better side scores 1 and the other side scores its ratio, so both adapters go through
exactly the same function with exactly the same inputs.

**The candidate must beat the baseline by at least 5%** on the composite:

```
improvement = (candidate.composite - baseline.composite) / baseline.composite
passed      = improvement >= 0.05
```

`report.ok` is true only when integrity passed, every floor passed, a score was computed,
and that score passed the 5% rule.

---

## Fixture repositories

Fixtures are stored as **data plus a builder**, not as thousands of committed files. Each
family declares its paths and contents; `materializeFixture()` writes them into a fresh
`os.tmpdir()` directory and `dispose()` removes it again. Nothing reads the real HOME — the
git-backed family runs `git init` with HOME, the global config and the system config all
redirected inside the fixture.

| Family | What it proves |
| --- | --- |
| `ts-path-alias` | alias resolution from configuration, without importing project code |
| `reexport-chain` | a symbol reachable only through a barrel re-export |
| `dynamic-import-literal` | a command module reached only through a literal dynamic import |
| `cyclic-modules` | a module cycle that must terminate with no dangling edge |
| `command-route-pipeline-gate` | command → route → pipeline → gate wiring, with lexical decoys |
| `test-production-binding` | which tests and gates a production change pulls in |
| `proof-invalidation` | proof invalidation reaching the affected graph and the release cache |
| `stale-wiki-claim` | a wiki claim whose cited source hash no longer matches |
| `parallel-write-conflict` | two slices declaring the same write target |
| `secret-and-path-redaction` | a secret-shaped token and an absolute path that must never escape |
| `dirty-and-untracked` | determinism across a dirty tracked file and an untracked file |
| `large-repo-incremental` | a generated module chain large enough to expose an unbounded scan |
| `malformed-manifest` | a manifest that must be skipped, not crashed on, not called exact |
| `symlink-escape` | a symlink resolving outside the workspace that must never be followed |

Every family is referenced either by a scored case or by a `safety_probes` entry, so no
fixture can quietly stop being exercised.

The redaction fixture composes its secret-shaped and absolute-path-shaped strings from
fragments at build time on purpose: a literal credential or a literal home path in committed
source would itself be the failure that fixture is meant to detect.

---

## Integrity: why the number cannot be quietly moved

The report records four things that make tampering visible:

1. `integrity.corpusHash` — the hash declared inside the corpus file.
2. `integrity.expectedCorpusHash` — the hash recomputed from the file's actual contents.
   These are sha256 over a **canonical serialization**: object keys sorted, no whitespace,
   `corpus_hash` itself removed. Editing a gold set, deleting a failing case, or re-weighting
   the score changes the recomputed hash and the two stop matching.
3. `integrity.scoringCodeHash` — a hash over the benchmark's own scoring modules. Pass
   `expectedScoringCodeHash` to pin it; a scorer edit then reports an integrity failure
   instead of publishing a quietly different number.
4. `integrity.reportLeakRules` — rule ids tripped by the serialized report itself.

If corpus integrity fails, **no case is executed at all**. The report comes back with
`cases: []`, `score: null` and the note `corpus_hash_mismatch`. There is no code path that
scores an unsealed corpus.

The report also records the git SHA, the git branch, a `clean` / `dirty` / `unknown` state,
a **hash** of the porcelain status plus its entry count, and a machine profile (platform,
architecture, cpu count, cpu model, total memory, node major). That is enough to tell two
runs apart without recording what was in the working tree.

### Changing the corpus on purpose

A legitimate corpus change is a two-step, reviewable act:

1. Edit `config/context-graph-benchmark.json`.
2. Re-seal it by recomputing the hash over the canonical serialization with `corpus_hash`
   removed, using `computeCorpusHash()` from the benchmark's `corpus` module, and writing
   the result back into the `corpus_hash` field.

Step 2 is what makes the change visible in review. A corpus edited without re-sealing simply
stops running; a corpus edited *and* re-sealed shows a changed hash in the diff, next to the
gold set that moved.

---

## Rules this harness holds itself to

- Fixtures only ever exist under the system temp directory, and are always disposed.
- No adapter answer, no artifact and no report may contain an absolute path, a home path, a
  temp path, an environment value, a token, a raw prompt or raw tool output.
- A missing or stale graph must surface an explicit error; silently answering from text
  search is a floor failure, not a degraded success.
- Nothing from an unsupported language may be labelled an exact relation.
- No workspace or project code is executed or dynamically imported during a measurement.
- Deleting a failing case or softening a gold set trips the corpus integrity hash.
