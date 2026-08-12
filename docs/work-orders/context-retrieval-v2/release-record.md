# CRK2 Release Record

## CLEARED: v2 recall now exceeds v1

**`v1 0.460692 · v2 0.481132 · v2 ahead by 0.020440`**, over 62 cases and 3
repeats against real engines, re-measured independently on a clean build with
zero drift. §4 confidence violations held at **10 (v1) / 3 (v2)** across every
step. Determinism mismatches 0. The failed-floor list is byte-identical to the
day this record opened.

Two lanes closed a gap of 0.122642 without a single tuned threshold:

| step | v2 recall | gap to v1 |
| --- | --: | --: |
| baseline | 0.338050 | +0.122642 |
| `changedPaths` seeds wired | 0.408805 | +0.051887 |
| **name anchoring** | **0.481132** | **−0.020440** |

The predicted honest ceiling was +0.0723 → 0.4811. It landed on 0.481132. That
the prediction held to four decimals is the useful part: the gap had been
attributed correctly before it was closed, so the fix was aimed rather than
searched for.

**Twelve cases moved across both lanes and exactly one moved down** — the
`review-reverse-dependency` displacement, named and kept rather than netted out.
The five cases the name lane recovered all went to 1.000, and all 62 v1 rows are
byte-identical throughout, so the comparison never drifted under its own
measurement.

### The original decomposition, kept because it is why the fix was aimed

**This is a release gate, not a research target.** `search/context.ts` was moved
onto the v2 kernel in `d53edb7f`, which is **not** an ancestor of `v8.7.0` — the
published 8.7.0 still answers `sks search --mode context` from v1, so no user is
affected today. That is precisely why the number binds: shipping 9.0.0 with the
v2 search path live and its must-include recall below the v1 it replaces would be
a *released* retrieval regression on the flagship query path, introduced by the
release that advertises the new kernel. The gap must close before 9.0.0, or the
search path must not cut over in it.

The original figure was `v1 0.460692 · v2 0.338050 · gap 0.122642`, reproduced
exactly over 62 cases and 3 repeats against real engines. The gap was decomposed
by varying one input at a time, and **the hypothesis recorded first was the
smallest live cause**:

| variant (v2 only, one input varied) | v2 mustIncl | share of gap closed |
| --- | --: | --: |
| as-is (control) | 0.3381 | 0.0% |
| + `changedPaths` seeds | 0.4088 | **57.7%** |
| + anchor-grade structural resolution | 0.4292 | **74.4%** |
| **+ both** | **0.4811** | **116.7% — v2 ahead of v1** |
| posting cap 4,096 → 16,777,216 | 0.3381 | **0.0%** |
| claim-prose change | 0.3381 | **0.0%** |

**The largest cause was not on the list: `changedPaths` seeds never reach the v2
engine.** The v1 engine turns them into `file_path` provided seeds; the v2 side
drops the field. `KernelRequest.seeds` exists and `admitProvidedSeeds` routes a
`file_path` seed into the anchor lane — and **neither production v2 caller passes
seeds either** (`search/context.ts:211`, `projections/attention.ts:101`), while
v1 had an entire seed-acquisition stage. So this is both an instrument asymmetry
and a live consumer-migration gap, and it is the **fourth** defect in this build
of the shape "built, wired, tested, and never fed".

**Symbol anchoring bounds at +0.0094**, not the headline it was recorded as. The
recoverable mass is bare label and basename anchoring (+0.0629). Checked
directly: **0 of the 12 recall regressions lost a target v1 answered at
`exact_definition`**, and only 2 of 12 held such a seed at all. A further +0.0189
of the measured ceiling is reachable *only by breaching the §4 confidence
ceiling* and is therefore not admissible; the honest anchor ceiling is +0.0723.

**The posting cap contributes exactly zero, and structurally cannot do
otherwise here.** The busiest term in the benchmark graph has 86 postings — 47.6×
below the 4,096 cap — and lifting the cap to 16.7M left every node id
byte-identical. On *this repository* the cap does bite: 103,123 postings dropped
across exactly 14 terms, all frequency stopwords (`src ts core function const …`),
with 3 of 14 probe queries changing answers. Real, but its recall effect is
unmeasurable without gold for this repository, and **nothing measured justifies
moving the cap**.

**Claim prose contributes zero for a reason worth knowing before that lane
measures itself green:** the benchmark fixture produces no claim or proof nodes
at all — `compiled.skipped` reports `.sneakoscope/wiki/context-pack.json` as
`unreadable: missing`. Four evidence-lane gold targets across six cases are
unrealized and **both engines score 0 on all of them, so they cancel**. Storing
claim text moves this benchmark by 0.000 until the fixture grows a context pack.

### Three findings that change how the fix must be built

1. **Adding a correct anchor can lose recall.** `review-reverse-dependency` goes
   0.500 → 0.000 when handed its own legitimate `changedPaths` seed: the anchor
   displaces a gold node out of top-k. Any seed-join fix must be measured
   per-case; the mean would have hidden this.
2. **Anchoring costs confidence-contract compliance.** Injected structural seeds
   take v2's §4 violations from 3 to 16, against v1's 10. `jargon-align-run-repair`
   alone produces 12 violations for **zero** recall gain, because v1's resolver
   turns a three-word jargon query into six `exact_definition` seeds. A label or
   symbol table needs a query-shape gate, or it will breach §4 while finding
   nothing.
3. **Two regressions resist both causes — 0.0315 of the gap.**
   `focus-path-restricted-answer` (v2's focus filtering is reachability, not path
   prefix — a documented limitation) and `graph-dependency-cycle` (v1 found both
   nodes through its `text_candidate` sweep; v2's BM25F ranks them out).

**Do not read a `fast_but_empty` verdict-count change as a retrieval change.**
Counts drifted 36/1 vs 34/3 between runs whose recall was byte-identical, because
that verdict is decided on a p95 comparison.

## Closed: the seed join is wired, and it cost exactly one case

`changedPaths` now reaches the v2 kernel as caller-verified `file_path` seeds at
both production call sites (`search/context.ts`, `projections/attention.ts`) and
in the benchmark instrument. One resolver — `query/changed-path-seeds.ts`, 91
lines — serves all three, so the two sides of the comparison cannot drift apart
on *which* paths become seeds again.

| | before | after |
| --- | --: | --: |
| v1 must-include recall | 0.460692 | 0.460692 |
| **v2 must-include recall** | **0.338050** | **0.408805** |
| gap | 0.122642 | 0.051887 |
| v2 recall@k | 0.246541 | 0.329874 |
| v1 / v2 §4 confidence violations | 10 / 3 | 10 / 3 |
| determinism mismatches | 0 | 0 |

**+0.070755 = 57.69% of the gap**, matching the predicted 0.4088 exactly.
Re-measured independently on a separate build: **zero drift across all 62 cases**,
and the failed-floor list is byte-identical before and after
(`forbidden_node_zero=2`, `unsupported_language_exact_mislabel_zero=3`), so
nothing new was mislabelled or leaked. The 3→16 violation blow-up this record
warned about comes from injected *structural* seeds, not from caller-supplied
paths — that warning still stands for the anchoring lane.

Seven of 62 cases moved; nothing else changed.

| case | category | v1 | before | after | Δ |
| --- | --- | --: | --: | --: | --: |
| **review-reverse-dependency** | review_nl | 0.000 | **0.500** | **0.000** | **−0.500** |
| review-affected-tests | review_nl | 0.000 | 0.000 | 1.000 | +1.000 |
| review-high-risk-change | review_nl | 1.000 | 0.000 | 1.000 | +1.000 |
| graph-high-fan-in-ids | graph_shape | 0.750 | 0.250 | 0.500 | +0.250 |
| graph-high-fan-out-registry | graph_shape | 0.500 | 0.000 | 0.500 | +0.500 |
| lifecycle-one-file-incremental | lifecycle | 1.000 | 0.000 | 0.500 | +0.500 |
| lifecycle-file-rename | lifecycle | 1.000 | 0.000 | 1.000 | +1.000 |

**The cost is named rather than netted out.** `review-reverse-dependency` 0.500 →
0.000 is finding #1 above reproducing, now attributed rather than inferred:
`format.ts` enters at rank 0 as the anchor and its own three depth-1 symbols take
ranks 1–3, pushing gold `generation.ts` from rank 9 — the last slot inside k=10 —
to rank 12. Both gold nodes are still in the answer; both fall outside k. The
displacers are the seed and its own children, which for "who depends on X" are
the least useful nodes in the set. Suppressing them would be an unmeasured
invention contradicting §7.1 — a caller-verified seed *is* a legitimate anchor,
and in production "what does this file do" must return the file.

**The response cache key had to change with it.** Seeds change the answer, so a
cached unseeded response would have silently voided the fix on the second call.
Keyed on the *resolved* seed set, so two callers differing only in an unusable
path still share one cached answer.

### Two more of the same shape, found while wiring this one

- `SearchRequest.tokenBudget` is published as "`context` mode only: token budget
  for the packed context" and was read by nothing — `searchContext` took only the
  injected option. An external caller setting the documented field silently got
  the default. Fixed with the same precedence as `profile`.
- `official-subagent-preparation.ts` held the mission's declared slice write
  scopes and passed the attention query the goal sentence alone. Fixed.
- **Reported, not touched** (different subsystem): the same file calls
  `chooseVerificationBudget({ taskProfile, changedFiles: [] })` — a hardcoded
  empty array where a real changed-file list belongs.

`search/context-graph-seeds.ts` now has **zero production importers** — only its
own test. It is on the CG2-15 deletion list.

## Closed: name anchoring, and the confidence line held

The gold nodes were never missing. Every one was already in the returned set,
below `k` — so this was a ranking gap and it was closed by ranking, not by
widening what the engine admits.

| case | category | before → after | v1 |
| --- | --- | --: | --: |
| `basename-reader-ts` | basename | 0.000 → **1.000** | 1.000 |
| `snake-fragment-context-graph-smoke` | snake_case_fragment | 0.000 → **1.000** | 1.000 |
| `basename-index-ts-collision` | basename | 0.333 → **1.000** | 1.000 |
| `determinism-tie-break-stability` | determinism | 0.333 → **1.000** | 1.000 |
| `exact-symbol-compile-context-index` | exact_symbol | 0.500 → **1.000** | 1.000 |

Nothing moved down. `recall_regression` verdicts fell 9 → 4, and the four that
remain are the ones that should: the two documented limitations
(`focus-path-restricted-answer`, `graph-dependency-cycle`) and two natural-language
queries the gate refuses on purpose.

**The §4 line held structurally, not by luck.** Nothing in the change calls
`table.claim`. A name match sets a flag and moves two scores; confidence stays
whatever the lane assigned. Verified across the corpus: every name-matched
candidate claims `text_candidate`, the sole exception being one that was *also* a
genuine whole-path anchor. The gate is `the whole query is one bare token`, and
over all 43 retrieval cases it produced **zero** matches on every jargon, Korean,
planning, review and graph-shape query — which is the `jargon-align-run-repair`
failure (12 violations for zero recall) not being repeated.

Bound worth carrying: candidates come from the post-lane table, so a node whose
name is the query but whose BM25F rank fell outside `laneTopN` is still
unreachable. Closing that needs the anchor tables to carry names — a format
revision, not a tuning change.

### Three more of "built, wired, tested, and never fed" — one of them the lane's own

1. **The lane's own tests passed with half the change deleted.** Six new
   join-level tests were green with the traversal seed-strength consumer removed;
   only mutation testing found it. That is this record's recurring pattern
   appearing *inside the work that was written to fix it*, and it is the argument
   for mutation-testing a guard rather than counting its assertions. Fixed: the
   label test now asserts the named symbol's file outranks every merely-scored
   node (without the bonus it falls to rank 6 of 10).
2. **`QueryPlan.shape` cannot express query shape.** `classifyShape` counts
   *tokenizer segments*, so one-word `compileContextIndex` classifies as
   `natural` (6 segments) and one-word `context_graph_smoke` as `natural` (3),
   while two-word `CSR adjacency` is also `natural`. Anything gating on `shape`
   to mean "the caller typed an identifier" is wrong for both classes. This is
   why the new gate is not built on it.
3. **`exactAnchorPriority` does nothing at the two call sites that appear to
   apply it** (`kernel-lanes.ts:114`, `:188`). Verified directly: `contribute()`
   writes it to `laneScore`, and `scoreIn` — the only reader — has exactly two
   callers, `kernel-select.ts:113` filling a receipt field and one test
   assertion. Fusion is pure RRF on *rank*; the real exact priority is the
   `EXACT_SEED` flag in `kernel-fuse.ts:267`. The constant is not dead, but its
   use reads as the place ranking priority is applied when it is not — so a
   future tuner would change it and measure nothing. Same family as the
   `LaneTelemetry.candidates` misreading already on this record.

## Korean recall: the cause is one discarded field, not i18n

Three explanations were offered and two were wrong. Recording the chain because
the wrong ones are the plausible ones.

`korean` recall is 0 on the real repository — 0 of 26,973 nodes carry a Hangul
character in any indexed field — and 0 on the hermetic benchmark workspace. The
first explanation, that the benchmark workspace "carries a Korean claim so the
floor is measurable there", was inferred from a filename constant without
compiling; the file produces no node. The second, that the extractors emit only
six node kinds with file nodes for `.ts` alone, is also wrong: `.py` produces
both `file:` and `symbol:` nodes, `.json` produces `gate` and `pipeline` nodes
by role, and twelve kinds exist — six were visible only because the other
extractors' input artifacts were absent from that workspace and are listed in
`compiled.skipped` as "not present in this workspace".

The real cause, isolated by adding a Korean context-pack entry and watching the
node appear but stay unretrievable:

```
wiki_claim ko-budget metadata = {"text_hash":"3d4a8c39…","text_length":34, …}
```

**Claim prose is hashed and measured, then discarded. No claim's text is ever
indexed.** The English claim in the same pack fails identically —
`termId('graph')` returns -1 although its text contains "context graph budget".
Korean only made it visible because there is no other route to a Korean node.
The tokenizer is not at fault: Hangul syllables are in `CJK_RANGES` with n-gram
segmentation, and it never receives any Korean to segment.

So this is not "grow the extractor set". It is **one field in
`extractors/evidence/claims.ts`** — whether to store bounded claim text. The
omission looks deliberate rather than accidental (the module already imports
`boundedText` and `safeText`, so leak-safety is the likely motive), and the
lexicon layer already guards that path with `looksLikeSecretToken` and
`redactMachinePaths`. That makes it a decision with a known cost, not a bug.

**A future non-zero is not proof of a fix** until claim text is stored or Korean
content exists in an indexed field. Adding Hangul to a fixture would turn the
number green with the engine unchanged.

## The coarse lane is proven; the zero was the instrument, not the lane

Three explanations were offered for the coarse lane reporting zero candidates on
a 98-node workspace while contributing 41 selections on the real graph. All three
were wrong, including mine, and the resolution is worth more than any of them.

- **Scale** — refuted by a control that held directory shape constant and varied
  node count: 11 coarse-only selections at 100 nodes, flat 90 from 500 to 27,000.
- **Vocabulary overlap** ("coarse fires iff a query token is a directory
  segment") — refuted by running exactly the escalation test its author
  proposed: queries naming real directory segments still reported zero.
- **A miswired field** — my reading, that the writer feeds `COARSE` a path while
  its tuning row says `pathLike: false`. That observation is accurate as code,
  but it was never the explanation, and I inferred a mechanism from a number
  that turned out not to mean what I assumed.

**`LaneTelemetry.candidates` counts nodes a lane admitted *first*, not nodes it
matched.** Lane order is `anchor → lexical → coarse → local_graph`, so coarse
scoring a node lexical already admitted increments nothing while `contribute`
still fires and the score still reaches the ranking. Measured on the same
workspace that reported zero:

```
"runtime-index posting cap"       telemetry coarse:0  →  17 of 40 selected carry a coarse contribution
"context-graph store generation"  telemetry coarse:0  →  50 of 64 selected carry a coarse contribution
"add a lexical retrieval lane"    telemetry coarse:0  →   0 (genuinely none here)
```

The lane was working the whole time. The prove-or-delete verdict is **proved**,
and it never depended on the broken field: `coarseOnlySelected` reads
`SelectedCandidate.contributions`, so the real-graph figure was always sound.

Two independent workers misread that field within a day. It sits beside
`matchedTerms` and `postingsExamined`, which *do* mean "work this lane did".
`firstAdmissions` would have cost nothing, and renaming it is a `query/**`
decision for that lane's owner. The benchmark side now carries
`laneContributions` beside `laneCandidates` with a regression test asserting *a
lane reporting zero candidates may still have contributed* — keeping the
misleading field rather than deleting it, so the misreading has a counterpart in
the same place.

Whether `COARSE` should be `pathLike: true` remains an open, separate question
with no evidence behind it either way.

## A decision the corpus needs, and must not resolve by editing gold

14 of 76 gold targets are unrealized (62/76, 81.6%), so the corpus declares gold
the compiler does not currently produce.

The first diagnosis — that the registry emits only six node kinds — was wrong and
is corrected above: twelve exist, and the six that were visible were simply the
ones whose input artifacts that workspace contained. The remaining shortfall is
narrower than "grow the extractor set", and the largest single piece of it is the
discarded claim text described above.

What has not changed is the rule. The lane that found the shortfall did **not**
rewrite the gold to match engine output, and must not: that is the post-hoc
corpus edit the work order forbids, and it is precisely how a benchmark stops
measuring anything while continuing to report a number. Either the missing data
reaches the index, or the affected cases are re-specified against ids the
compiler can produce — as a decision, on the record, not as a cleanup.

## Closed for claim prose: entropy-shaped secrets no longer reach the bytes

Every shape that previously reached the published index now does not — bare
base62 and hex, JWTs, emails, IPv4 — with retrieval unmoved: 24 of 24 claims
still retrievable, 240 of 380 prose words, index bytes byte-identical before and
after the guard. No claim lost text.

Two things about how it was built are worth more than the fix:

**A shape nobody listed was found by measuring rather than by reviewing.** A
43-character base64url token spends `-` and `_` as payload, so every alphanumeric
run inside it falls under the 20-character floor and walks past a guard that
judges runs as they appear. Catch rate was 87.8%. Rejoining the run before
judging it took that to 99.9% — and the rejoin *shrinks* the false-positive
surface, because a hyphenated identifier rejoins into something short enough to
fall below the floor.

**Then the same defect was found again, one encoding over, by the review that
measured instead of reading.** The rejoin covered `-` and `_` only, which is the
base64url alphabet. Standard base64 spends `+` `/` `=` the same way, and it sat
at **87.0% — its unfixed rate**. It survived the fix, its test, and the report
because the encoding that got tested was the encoding that had just been fixed:
the fix and its evidence shared one blind spot. Rejoining all five encoding
characters takes standard base64 to 99.9% with base64url unchanged, and the
unpunctuated encodings are the control that shows the floor itself was never the
problem:

| encoding | split on punctuation | rejoined |
| --- | --: | --: |
| base62 (no punctuation) | 100.0% | 100.0% |
| hex (no punctuation) | 100.0% | 100.0% |
| base64url (`-` `_`) | 87.8% | **99.9%** |
| base64 (`+` `/` `=`) | 87.0% | **99.9%** |

5,000 random 32-byte secrets per encoding. Reading across `+` and `/` means the
guard now spans the prose that actually contains them — paths and ratios — so
`src/core/search/context.ts`, `a/b`, `3/4` and `1/2` are pinned as passing cases
rather than reasoned about. Cost on this repository's real claim prose: **zero**,
index bytes byte-identical at 673,877, 24 of 24 claims still carrying text.

The general lesson is the one this record keeps re-learning in a new costume: a
guard is only proven against the shapes someone thought to generate, so the
second encoding is not redundancy, it is the test.

**The false positives were left in place deliberately, after checking.** The
proxy flags four plausible identifiers out of nineteen — CamelCase names of 20+
characters embedding a number. The instinct was to tune the rule until they
survived. The lexicon settles it instead: `emitLatinRun` already refuses those
exact tokens whole, before casing and before splitting, so none was ever
searchable. Tuning to save them would have bought no recall and put the extractor
and the index into disagreement — **a token stored but never indexed is exactly
the leak with a clean-looking search path that this finding is about.** The rule
now matches the lexicon's by construction, and the false-positive class is pinned
by a test that names it and states its cost rather than hiding it. Cost on real
prose: 0 of 24.

Residual, and worth a reviewer's eye:

- The collapse is all-or-nothing, so one flagged identifier costs a claim all its
  other words (0 occurrences today).
- A credential under 20 characters or of low entropy is not shape-detectable and
  is caught only by prefix.
- **A four-part version string trips the IPv4 rule.** `8.7.0.1` is four octets in
  range, and nothing distinguishes it from `192.168.10.42` — the module's own
  comment predicted this and a probe confirms it fires. Measured cost on this
  repository's claim prose is 0 of 24, and the alternative is a rule that lets a
  real address through, so it stays. Named here because a release record full of
  version numbers is exactly where it would first bite.

## System-wide, still open: other extractor metadata reaches the bytes unredacted

Found while closing the claim-text gap, and larger than that gap. Measured over
eight hostile shapes placed in extractor metadata:

| shape | reaches node | reaches bytes | becomes a term |
| --- | --- | --- | --- |
| `sk-proj-…`, `ghp_…`, `AKIA…`, `Bearer …`, `key: value` | no | no | no |
| absolute / home / UNC / `../` path | no | no | no |
| bare high-entropy base64 | **yes** | **yes** | no |
| bare 64-char hex | **yes** | **yes** | no |
| JWT (`eyJ…`) | **yes** | **yes** | **yes** |
| email address | **yes** | **yes** | **yes** |
| IPv4 address | **yes** | **yes** | **yes** |

The extractors redact by a prefix and keyword pattern list with no entropy proxy,
so an unprefixed key, a JWT, an email or an IP lands verbatim in node metadata
and therefore in the index string table. The last three are searchable.

This is pre-existing and applies to **every** extractor's `safeText` metadata,
not only to claims. It is recorded as its own item rather than folded into the
claim-text work, because fixing it properly touches every extractor and is a
scheduling decision, not a cleanup. The claim-text lane closes only the exposure
its own change widens.

## A pattern worth naming: built, wired, tested, and never fed

Ten defects in this build share one shape, and none of them could have been
caught by a passing test:

- The **lexicon** was built, tested with 50 passing cases, and imported by
  nothing, so every published index carried four empty dictionary sections.
- A **test fixture** then called the writer without the lexicon config, so a
  whole consumer suite went green against an index with no text in it — and the
  assertions had been written to match, locking zero recall in as expected.
- **Claim prose** is extracted, hashed, measured, and discarded, so the evidence
  lane indexes nothing at all.
- **`changedPaths`** — `KernelRequest.seeds` exists, `admitProvidedSeeds` routes
  it, and neither production caller nor the benchmark's v2 side passed the field.
  Worth 57.7% of the recall gap, and it made every published v2 recall figure a
  comparison between two engines asked different questions.
- **`SearchRequest.tokenBudget`** is documented in the published request type and
  was read by nothing.
- **Slice write scopes** were in hand at the subagent preparation call site and
  the attention query got the goal sentence alone.

In each case the component worked, its tests passed, and the data never arrived.
Unit tests cannot see this class; only an end-to-end measurement against a real
corpus can, which is the argument for the paired run existing at all.

### The pattern nested inside itself — and a correction to the entry above

**`chooseVerificationBudget({ taskProfile, changedFiles: [] })`** was the seventh:
a hardcoded empty array in `official-subagent-preparation.ts`. `changedFiles` is
read three ways — release-surface detection (`package.json`, `CHANGELOG.md`,
`.github/workflows/`, `src/core/release/`, publish scripts), a `tiny-change`
split at >1 file, and a breadth escalation at >=8 — so with `[]` the budget
collapsed to a pure function of `taskProfile`. **`'release'` was unreachable from
that call site for every mission ever prepared**, and breadth never escalated.

Fixing it surfaced the correction. `OfficialSubagentPreparationInput.slices` **is
never populated by any production caller** — verified directly: all three
(`runtime-core.ts:1277`, `:1359`, `naruto-command.ts:385`) omit it, and
`naruto-command.ts` does not contain the word; only tests pass it. So the budget
fix is correct and *latent*: it computes from a field that never arrives.

**Which means the sixth entry above is overstated.** Slice write scopes were
wired into the attention query, and that fix is latent for the same reason — the
scopes are in hand only when `slices` is supplied, and production never supplies
it. The defect was real and the fix is right; what neither report said is that
the data still does not arrive one layer up. A fix for "never fed" that is itself
never fed is the pattern reproducing inside its own repair, and it is worth more
than the individual defects: **the shape survives being fixed** unless someone
follows the value all the way to a production caller.

Behind that one unsupplied input sit slice-safety blockers,
`independentSliceCount`, `readyDagWidth`/`disjointOwnershipCount`, the prompt
slice table, the attention seeds, and the verification budget — the largest
single instance in this build. It is **left deliberately**: populating `slices`
means SKS decomposing the mission itself rather than the parent doing it, which
is a product decision and not wiring.

The live half was fixed instead, in `official-subagent-lifecycle.ts:396`. The
finalizer wrote the *forecast* budget into the completion summary while the
parent's real, schema-validated `changed_files` sat in scope two lines away.
`finalizedVerificationBudget` now recomputes from what actually changed and
**never returns weaker than the plan** — observed breadth may escalate a
forecast, never relax one. A run that turns out to touch `package.json`
finalizes as `release` instead of the `affected` it was planned with.

Three further findings on that path, each left with a reason rather than fixed:
the attention query's `risk` is declared, forwarded, and read in three places
(traversal depth 2→3, rank bonus, protected-gate reservation) but **never passed
by its sole production caller**, which has `taskProfile` in hand — so a
`high-risk` mission traverses exactly as shallowly as a typo fix;
`plan.verification_checks` is written only as `[]`, so every finalized summary
reports no checks while the parent's validated rows sit in
`subagent-parent-summary.json`; and `buildPipelinePlan({ changedFiles })` has the
same empty-array collapse across ten-plus call sites.

One fix was **written and then reverted**, which is the right call recorded so it
is not mistaken for an oversight: `naruto-command.ts:549` passes the forecast
budget into the summary although the parent summary is in scope, but
`runOfficialSubagentWorkflow` spawns the real `codex` binary and has no injection
seam, so no join test could have caught it. Shipping it would have been green by
omission. The consequence to carry: **the two writers of `naruto-summary.json`
now disagree** — the hook finalizer reports the observed budget, `sks naruto run`
still reports the forecast.

Facts the 9.0.0 release notes and readiness docs must carry. Recorded as they
happen, because a release record assembled from memory at the end is a release
record that omits the inconvenient parts.

## Two rulings, one of which corrects the instructions I gave

**The ADR permitted what the lane refused, and the lane was right.** §4's anchor
row listed `basename` as `exact`. The lane was instructed to refuse exact for any
name match and did, leaving doc and implementation disagreeing on paper. Resolved
in favour of the implementation and the ADR amended, because implementing the row
as written contradicts §4's own opening sentence: `index.ts` names many nodes —
the corpus has `basename-index-ts-collision` for exactly this — so an `exact`
basename would claim exact confidence for several nodes at once, at most one of
which the caller meant. The row was aspirational for a format that carried names,
and went untested because revision 1 implemented "basename" as whole-path. The
narrowing cost **zero recall**: every case the name lane recovers reaches 1.000
as a ranking signal. Recorded as settled rather than as a tension only because
nothing was traded away.

**"Existing files are shrink-only" is not the rule, and I asserted it to every
lane in this build.** Reading `check-architecture.ts` directly:
`waiverFailureFor` is reached *only* when a file already exceeds a budget
(`lines >= split_review_lines`, `lines > max_lines`), and shrink-only is the
policy governing files that carry a waiver in
`src/generated/architecture-waivers.json`. The binding rules are 450 lines for
new files — no waiver possible, `new files cannot use architecture waivers` — and
the per-rule `max_lines` for existing ones. An unwaivered existing file under
budget may grow.

Nothing shipped wrong because of it: an over-strict constraint fails safe, and
every lane stayed well inside the real budget. But it is worth correcting rather
than quietly dropping, because a made-up constraint spends real effort — work
gets restructured to satisfy a gate that was never going to object — and the next
reader of this record would otherwise inherit it as fact.

## A gate was committed red

`e7e01bb6` ("add the SKSCG2 binary format") landed with `npm run architecture:check`
failing. `format.ts` was 494 lines against this repo's 450-line cap for new
files, and the cap allows no waiver.

The cause was procedural, not technical: the affected-gate DAG had been run
before those files existed, and I committed without re-running it. It was found
by a worker reporting its own lane's failures rather than by the release
process, which is the wrong order — it would otherwise have surfaced at publish
time, when the cost of a full re-split is highest.

Resolved by `57d40103`, which split every oversized module along real seams and
left the entry points as re-export barrels so no importer moved. The gate has
been green since, and is now run before each CRK2 commit rather than after.

## Format revision 1 reserves the per-edge profile mask

The writer stamps every edge's `profileMask` with all bits set, so the field
excludes nothing. This is deliberate and documented at the write site: profile
membership is ranking configuration, the kernel already excludes an edge with a
single integer test on its type, and precomputing the same answer per edge would
buy nothing while baking a tuning decision into the bytes.

A reader must not treat the field as authoritative until a later revision says
otherwise. Recorded here because "the field exists but means nothing" is exactly
the kind of fact that gets rediscovered as a bug.

## Two kernel limitations, neither a relaxed floor

**Exact-label anchoring is bounded by format revision 1.** The exact table holds
canonical node ids only, so a bare label reachable only as text stays
`text_candidate` — correct under the confidence contract, but recall on
bare-label queries will improve when the anchor tables carry labels. A decision
for a later card, not a kernel change.

**Focus filtering is reachability, not path prefix.** Prefix filtering needs a
path scan, which is the thing this project deletes. Focus paths become anchors
and the flag propagates along the walk; same semantics as v1's `focusMatched`,
bounded.

## BLOCKS CUTOVER: the compact index contains no text

`writer.ts` writes `LEXICON_TABLE`, `LEXICON_POSTINGS`, `COARSE_TERM_TABLE` and
`COARSE_POSTINGS` as zero-length sections. `buildContextLexicon` exists, has 50
passing tests, and is imported by nothing but its own tests. Only the anchor lane
can produce candidates, and revision 1 anchors on canonical node ids and whole
workspace-relative paths.

Measured on identical fixtures through both engines:

| query | v1 | v2 |
| --- | ---: | ---: |
| `src/other/a.ts` (path anchor) | 7 | 8 |
| `runService` (symbol) | 7 | **0** |
| `service` (word) | 7 | **0** |

So `sks search --mode context` would answer a pasted path and return nothing for
every other query. The kernel is not at fault — it has no postings to merge.

**This is a planning failure, not an implementation one, and it is the second of
its exact shape.** The CG2-03 commit message says "the lexical and coarse tables
are declared empty here; CG2-04 fills them" — and CG2-04's brief asked for the
lexicon module without asking anyone to wire it in. The same omission produced
the missing workspace orchestrator: every piece assigned, no join assigned.

## Closed: production now publishes a v2 generation, with text in it

The join above is wired. `compiler/publish-index.ts` is the whole of it —
`beginContextIndexOperation` → `encodeContextIndex` → `stageContextIndexGeneration`
→ `commitContextIndexGeneration` → `cleanContextIndexOperation` — and the align
runner calls it before it builds its pack, so the pack is projected from the
published generation through the query facade rather than from an inline encode.
The `lexicon` config is threaded from `query/ranking-config.ts` at that one call
site; nothing copies a weight.

Align replaces `.sneakoscope/wiki` wholesale and the generation store lives
inside it, so a generation published into the live root before the swap would be
renamed away and one published after it would be too late for the pack. The
staged wiki is therefore built as the `.sneakoscope/wiki` of a **pending
workspace root** and the store publishes into that; promotion moves an
already-published store into place.

Measured on this repository (28,597 nodes, 77,107 edges, 3,102 source files),
publishing to a temp root so the checkout was not swapped:

| fact | value |
| --- | ---: |
| index bytes | 13,200,680 |
| JSON snapshot bytes for the same graph | 48,945,406 |
| lexicon terms / postings | 51,621 / 381,491 |
| coarse terms / postings | 341 / 81,316 |
| publish (encode + fsync + verify + commit) | 2.6 s |

| query | selected |
| --- | ---: |
| `runIncrementalBuild` (symbol) | 22 |
| `publishContextIndexGeneration` (symbol) | 28 |
| `encodeContextIndex` (symbol) | 17 |
| `lexicon` (word) | 8 |
| `src/.../runtime-index/writer.ts` (path anchor) | 4 |

The symbol and word columns were **0** before this seam existed.

Two facts that bound the claim, both measured:

- **A Korean query against this repository returns nothing, and that is the
  corpus, not the index.** Zero nodes in this workspace's graph carry Hangul in
  any indexed field — the lexicon indexes labels, paths and string metadata
  (a file's leading docstring), and this repository's Korean text lives in source
  bodies, which the graph does not index. Republishing the same real snapshot
  with one Korean document added returns it as the top hydrated node for
  `컨텍스트 예산`, `예산 정책` and `검색 결과를 요약`, at `text_candidate`
  confidence.
- **The posting cap fired 102,635 times** on this workspace
  (`omissions.cappedPostings`), alongside 290 secret tokens and 2 redacted spans.
  Recall on the most common terms is bounded by `postingCapPerTerm`, and the
  number is reported rather than left to be discovered.

## Closed: the freshness class no longer reads the snapshot

**This blocker was half stale when it was written, and the wrong half was the
alarming one.** `contextIndexFreshness` — `readContextGraphMeta` plus cache-key
comparison, no snapshot read — already existed, landed in `d53edb7f` alongside
the kernel. What was missing was not the preflight but its **callers**, and a
test of the one property the blocker actually cared about *in the shape
production uses*. A record entry that says "there is no X" when X exists unused
is worth naming: the two failure modes read identically from the outside, and
only one of them is a build task.

The measured cost, on this repository (28,660 nodes, 77,347 edges). The 58 MB in
the original entry was itself wrong — the snapshot is **63,654,542 bytes**, and a
byte-identical `context-graph.prev.json` sat beside it, so the pair was 127.3 MB
(that duplicate is now removed — see below; the snapshot itself stays).
The meta the v2 path reads instead is 489,949 bytes.

| Configuration | | JSON path | v2 preflight |
| --- | --- | --: | --: |
| **Isolated** (neutral key, no source re-hash) | bytes | 64,144,491 | **489,949** |
| | wall | 274–377 ms | **1.9–2.5 ms** |
| | heap | 218 MB | **17.3 MB** |
| **Realistic** (real git, no supplied key) | bytes | 79,577,962 | **15,923,420** |
| | wall | 479–667 ms | **186 ms** |
| **Hooks preflight** (re-hashes 3,740 sources) | bytes | 86,819,814 | **23,654,354** |
| | heap | 239.8 MB | **16.7 MB** |

Every pair reached the same verdict and the same reason list.

**The honest qualification is in the row the headline would skip.** For the hooks
caller the wall-clock win is *inside the noise* — 1,611 ms against 1,418–1,785 ms
— because re-hashing 3,740 recorded sources dominates both sides. The wins there
are bytes (−63.2 MB) and heap (14×). Wall clock only moves where the parse *was*
the cost: 274 ms → 2 ms. Quoting the 274→2 figure for every caller would have
been true of one measurement and false of the deployment.

**A mechanism correction, against the brief this lane was given.**
`computeSourceInventoryFingerprint` was the mechanism I pointed the lane at, and
it is the wrong one: it feeds the fragment manifest, and `expectedSourceFingerprint`
is a *pointer constraint* (`generation-resolve.ts:50`) deciding which generation
may be served — not whether the workspace moved. Freshness comes from
`computeContextGraphCacheKey` / `inspectCodeNavigationSources`, both content-hash
based.

### The test, and why it is not vacuous

`store/__tests__/index-freshness-source-mutation.test.ts`. The existing
`index-freshness.test.ts` compares the two paths but hands every case a
**hand-built cache key** and runs with `verifySources: true` — right for an
equivalence test, wrong here, because it pins as a constant precisely the half
that has to do the detecting, and **no production caller uses that shape**
(`search/context.ts` passes `verifySources: false`, which turns the recorded-input
re-hash off entirely and leaves the cache key as the only thing between a mutated
workspace and a confident answer).

Two independent falsifications, not one:

- A **deliberately corrupt snapshot** is planted on disk. The JSON path reports
  `corrupt` for that file, so a preflight still reading it could not return
  `fresh`. The property is structural rather than argued.
- The preflight was then **mutated in `dist` into the exact shape this record
  refused** — pointer/meta integrity with the cache-key comparison removed — and
  4 of 5 tests failed, the headline one `actual: 'fresh', expected: 'stale'`. The
  regression reproduced verbatim. The 5th correctly still passed: it documents
  non-coverage.

### What it does not cover — stated, because a preflight is only as good as its blind spots

1. **mtime-only change with identical bytes** stays `fresh`. Deliberate, asserted.
2. **New untracked files outside `RELEVANT_EXTENSIONS`** (`.go`, `.java`, `.c`,
   `.sh`) are invisible. New-file-only: tracked-dirty files are not filtered.
3. **`MAX_FINGERPRINT_FILES = 2000`** — past 2,000 dirty paths the fingerprint
   records `truncated:<n>` and stops.
4. **`MAX_FINGERPRINT_FILE_BYTES = 8 MB`** — a larger file fingerprints as
   `oversize:<size>`, so a length-preserving edit is invisible.
5. **`verifySources` sees only *recorded* inputs** (capped at 4,000), so a new
   file can never raise `source_hash_mismatch` — and it is off in
   `search/context.ts`.
6. **`head_changed` can be forgiven** when intervening commits touched only
   code-pack artifacts. Shared verbatim with the JSON path, not new.
7. With an unreadable meta the preflight cannot report a `snapshot_hash` for
   diagnostics, where the JSON path could read it from the snapshot.

### The gate finding that matters more than the migration

The consumer inventory said the deletion gate must run on imports rather than a
bare grep. That is necessary and **not sufficient**: `triwiki-atlas-command.ts`
and `architecture-map-check.ts` both read the snapshot through a hand-built
`path.join(...)` and import nothing from the store. An import-only gate sees
neither. CG2-14 needs an import check **and** a path-literal read check, failing
independently. Corrected in the inventory.

**CG2-15 is not unblocked by this** — the freshness class is cleared, which is
what this blocker asked for, but 4 content readers, 4 compiler write-side sites
and the v1 engine still read the file. Two now-dead surfaces fall out:
`contextGraphStatus()` has zero production call sites, and
`context-graph.prev.json` has no production reader at all — written every
compile, never read back, a byte-identical 63 MB duplicate. **Now removed; see
below.**

## BLOCKS 9.0.0 SCOPE: CG2-15 cannot delete the JSON snapshot

The test-selection consumer migrated cleanly and with real evidence (below). The
other two content readers turned out **not to be migrations at all**, and that
changes what 9.0.0 can claim.

`runContextGraphLint` asserts properties *of the JSON file's bytes* in 2 of its 8
rules — `JSON.stringify` array-and-key ordering, and a hash recomputed from that
serialization. A fixed-stride binary has neither property, and
`ContextIndexMeta` carries no lint verdict to read instead, because publishing is
itself refused on lint failure. `architecture-map-pipeline.ts` embeds the whole
snapshot into a bundle and hashes it into `canonicalHash`, which would require
materializing 28,660 nodes and 77,347 edges — the exact behaviour ADR §3 removed
`getNode()` to prevent — and would not hash identically anyway, changing every
sealed baseline fingerprint.

**Both are contract changes wearing a migration's clothes.** The v1 *engine* can
still be deleted once its importers are gone; the *file* cannot. Recorded as a
scope fact rather than carried as a task, because "delete the JSON runtime store"
is in the work order and 9.0.0 will not do it.

## LIVE DEFECT in test selection: the cap is silent

Found while producing the migration evidence, and **pre-existing in both
engines** — it is not introduced by the migration.

`context-graph-affected.ts` stops adding tests at `maxTests: 128` with a bare
`continue`. Every other cap in that file reports itself: a truncated impact
closure pushes `impact_closure_truncated` into `conservative_reasons`. This one
pushes nothing.

Measured on the real graph for `commit:11265c98`: **275 test suites are reachable
and the walk is not truncated. 128 are returned. 147 are dropped and
`conservative_reasons` is empty** — the caller is told nothing is missing. This
is the function that decides which tests run for a change, so a silent 53% drop
is a release-safety hole, and it reads as a complete answer.

The migration also makes it *visible* in a way it was not before: which 128
survive depends on adjacency traversal order, and v1's sorted-edge-id order and
v2's CSR bucket order differ. Same count, same completeness, different membership
(48 shared of 128, union 176). Not a shrink — but proof the kept set was never
determined by anything meaningful.

The fix is contained and is **not** raising the cap: emit a reason when it bites,
and impose a deterministic order (depth, then path) before truncating, so the
kept set stops depending on index layout. Left as its own change rather than
folded into a migration.

## Closed: a 63.66 MB duplicate nobody ever read, and two premises I got backwards

`context-graph.prev.json` is no longer written. The write and its reader landed
together in `acf504c2` and **the reader was never called, at any commit in the
file's history** — checked with `git grep` at every commit `git log -S` reports,
not by reading the current tree. The incremental compiler's `previousGeneration()`
read the *current* snapshot; `previousSnapshotHash` in the meta is what every
consumer actually wanted, and it derives from the current file's bytes. The
rollback/diff feature the artifact's name implies was never wired.

Measured saving: both files hash identically at 63,654,542 bytes, so **63.66 MB —
48.6% of `.sneakoscope/wiki`**. Deleting the write alone would have stranded the
duplicate forever (it is gitignored, and the retention sweep only reaches it
under age or count pressure), so the commit that used to overwrite it now
reclaims it, best-effort after the rename so a failed unlink cannot fail a
compile.

**The repository was already enforcing that nothing may read this file while
still writing it.** `compiler/__tests__/incremental-json-retirement.test.ts:31`
carries `/context-graph\.prev\.json/` in its FORBIDDEN list. A guard against
reading an artifact that is still being produced is a guard that can only ever
pass — and it did, for the artifact's whole life.

### Two premises of mine were inverted, and the correction is the useful part

**I said `cache-key.ts:49` listed the file as a cache-key input, so removing it
would change the key and invalidate indexes — and argued this was therefore the
cheap moment, because revision 2 already forces a rebuild.** It is an
**exclusion**, not an input: the list is `WIKI_CONTEXT_EXCLUDED`, under the
comment *"Graph artifacts must never feed their own cache key."* Removing the
write changes the cache key by exactly nothing, and the timing window I was
spending did not need to be spent.

The real consequence runs the other way, and the entry was **kept** for it: every
workspace built before this change still holds a 63 MB leftover, and dropping the
name would feed that leftover into `wikiContextHash` and into the `gitState`
clean/dirty decision — moving the cache key on precisely the mid-migration
population that can least afford it. Nothing stops being detected, since the
entry only ever suppressed the graph's own output; a control assertion pins that
an ordinary source edit still moves the key.

**I also paraphrased `snapshot-store.ts:236` as describing a possibly-dead read
path.** It described the current generation being *rotated to* prev only when the
current file is itself readable — accurate, live behaviour. The comment was
right; my reading of it was not.

One residual, reported and left: `contextGraphArtifactPaths` (`paths.ts:141`) has
zero callers repo-wide. It is the natural home for a workspace-cleanup consumer
and is currently dead.

## RESOLVED (format revision 2): metadata values lose their type

`writer.ts` interned a metadata value as `Array.isArray(value) ? value.join(',') : String(value)`,
and the reader handed back `Record<string, string>`. So a boolean `true` written
by an extractor arrived as the string `"true"`, and every consumer asking
`metadata.isTest === true` silently stopped matching. A string array was joined
on a comma that a value may itself contain, and no consumer could reverse it.

**Closed by widening the metadata row 12 → 16 bytes** with a `u16` type tag and a
`u16` ordinal. Six tags: `STRING`, `BOOLEAN`, `NUMBER`, `NULL`, `ARRAY_ELEMENT`,
`ARRAY_EMPTY`. Arrays become one row per element, so `['a,b','c']` is now
distinguishable from `['a','b','c']`, and `ARRAY_EMPTY` stops `checkScripts: []`
from vanishing.

`value` remains **always** a string-table id whatever the tag says. That is the
security property and not a convenience: a corrupt tag can at worst return an
in-bounds string read as the wrong type, and can never cause four bytes to be
taken as an offset.

It is also why this works where the reverted JSON attempt did not. The interned
text stays the value's own canonical serialization — `{ lexeme: 'kernel' }` still
interns `kernel`, not `"kernel"` — so scalars intern byte-identically to revision
1 and the tag carries the type instead of the text. **Recall was unmoved: 0 of 62
cases changed**, v2 `0.481132`, §4 violations 10/3, floors identical. Verified
independently on a clean build.

**A number in the previous entry needs correcting.** It recorded "11 predicate
matches lost across 9 families". Today's corpus measures **949 across 14 of 14
families**, and the growth predates this change — no extractor or compiler file
was touched, and the count is snapshot-side. Post-fix, `preserved` equals
`authored` for every type: string 2521, boolean 1958, number 1849, string_array
575, null 0.

Two facts that bound the damage, both measured rather than assumed:

- `requiredForPublish` and `alwaysOnRelease` appear on **zero** nodes in any
  fixture. Protection travels through `node.risk === 'protected'`, which
  survives. So `isProtectedGateNode`'s metadata arms are dead code against these
  fixtures — a green run there is *not* evidence that arm works — and the
  protected-gate recall floor is untouched.
- The `parallel-write-conflict` family's three `isTest` nodes are all `false`,
  so both sides score zero and the conflict floor cannot move for this reason.

Where it will bite is `command-route-pipeline-gate` and `test-production-binding`,
where test files would start reading as write-scope conflicts.

**Done: revision 2 cleared this, and the migration landed with the evidence it
demanded** — gates identical on 19 of 19 real diffs, zero lost gates, zero lost
tests. `metadata.isTest === true` works under the v2 reader and is genuinely
covered by fixtures carrying both spellings.

**The two protected-gate arms were settled asymmetrically, and the asymmetry is
the point.** `requiredForPublish` and `alwaysOnRelease` are now *predicate-
verified*: a fixture sets each flag on a gate with `risk: 'high'` and manifest
entries false, so the metadata arm is the only thing that can answer, plus a
same-risk control with no flag asserted `protected: false`. Deleting both arms
fails that test.

They remain *unreachable in production*, which is a different claim and is kept
separate rather than blurred into "verified". `buildGateNodes` sets
`requiredForPublish: REQUIRED_FOR_PUBLISH.has(gate.id)` and `risk: gateRisk(...)`
in one `addNode`, and that same predicate is a disjunct of `isProtectedGate` — so
the flag being true *implies* `risk === 'protected'`, and `context-graph-v2:quality`
already reports `protected_metadata_arm_unreachable: true` on the real manifest
(`requiredForPublish:23`, `alwaysOnRelease:14`, zero counterexamples). No fixture
was manufactured to make this look covered; that mistake is elsewhere on this
record and was not repeated.

The original reasoning, kept because it is why the ordering held:
`verification/context-graph-affected.ts` decides which tests run for a change,
and all three of its predicates are metadata equality on a boolean —
`metadata.isTest === true` at line 147, `requiredForPublish === true` and
`alwaysOnRelease === true` at line 151. It still reads the v1 JSON index
(`loadContextGraphIndex`), so it works today and its tests pass today. The moment
CG2-15 moves it to the v2 reader, every one of those arms goes silently false:
the selector stops recognising test nodes and stops recognising release-critical
ones. It selects *fewer* tests and the run gets *faster*, which is the failure
presenting as an improvement — the exact risk the consumer inventory named for
this file. Migrating it on the strength of "it compiles and the suite is green"
would ship that.

`architecture/metrics.ts:130` reads the same shape (`typeof node.metadata.public
=== 'boolean'`) but consumes the compiler's in-memory merged nodes rather than
the reader, so it is unaffected. Checked rather than assumed — the two look
identical at the call site and only the data source separates them.

**Attempted and reverted first.** JSON-encoding the value preserved the type but
quoted strings into the string table, and the kernel fixtures deliberately seed
lexicon terms *through* metadata values, so `termId('kernel')` stopped resolving.
The type code was the recorded correct fix and is what shipped. **Both `todo`
tests are now plain tests with inverted assertions** — not deleted. The gap test
asserts `typePreserved` **and** `lostKeys === []`, so an implementation that
tagged booleans while leaving numbers and arrays flattened still fails.

### Two findings from the mutation pass that outlast the fix

**A revision-1 hole in section validation, found by the fuzz campaign and
reproduced on the pristine tree before being closed.** `validateReferenceRange`
bounded only `count * stride > length`, so an *over*-claimed row count was caught
and an *under*-claimed one silently made the reader stop early — with the section
checksum still valid, because it covers `offset..offset+length` and does not care
how many rows the descriptor claims live there. The campaign only drew that byte
once the new layout shifted its PRNG offsets. Reproduced on `9ea37bab` by
stashing, so it is recorded as a pre-existing defect rather than mis-attributed
to the row widening. Closed by requiring `count * stride === length` exactly
across all 19 fixed-stride sections, with a test asserting the list is complete
so a future section cannot opt out.

**`contextNodeFlag` and `contextNodeCount` must not be narrowed, and two
mutations proved no existing test said so.** Narrowing either helper to a single
spelling survived 294 tests across runtime-index, benchmark, projections, naruto
and query. Extractors author these both ways — `topology/gates.ts` writes a real
boolean, several fixtures write `'true'` — so narrowing to one spelling does not
remove the silent-false failure, it *moves* it to the other set of nodes, which
is the exact failure this revision exists to end. Now pinned by a
projection-parity test that builds a real index carrying both spellings. Recorded
because this is precisely the shape that gets "cleaned up" next round.

### The repair instruction was wrong in the direction every user will take

Shipping revision 2 inverts the common case for `context_index_format_unsupported`.
The rule assumed the artifact is always *ahead* of the reader — an index from a
newer build, repaired by upgrading — and answered `sks update` unconditionally.
On upgrade to 9.0.0, **every existing workspace holds a revision-1 index and a
build that is already current**, so that answer names a command that changes
nothing and never mentions the only repair that works. The user's index stays
unreadable while the tool insists it is up to date.

Fixed in both refusal paths (store pointer and binary reader): the direction is
decided from the two revisions, which are already carried as integers in
`detail`. Older artifact → `sks align run --rebuild-index`; newer artifact, or
any other unsupported-format cause where nothing knows which side is stale →
`sks update`. The public code does not split; the frozen vocabulary is intact and
only the repair differs. Mutation-tested: forcing the branch back to `update`
fails exactly the new test and nothing else. The pre-existing test covered
`REVISION + 1` only, which is why the inverse went unnoticed — **the test and the
bug shared an assumption**, the same shape as the base64url guard that was
measured only against the encoding it had just fixed.

## Withdrawn: the "unverifiable protected-gate arm" was not a gap

An earlier entry here claimed `isProtectedGateNode`'s metadata arm
(`requiredForPublish`, `alwaysOnRelease`) was dead code against the corpus and
needed a new fixture family to close. **That was wrong, and the fixture would
have been worse than nothing.**

`buildGateNodes` sets the metadata flag and `risk: gateRisk(...)` in the same
`addNode` call, and `REQUIRED_FOR_PUBLISH.has(id)` is one of `gateRisk`'s
disjuncts. So the flag being true *implies* `risk === 'protected'`. Verified
exhaustively against the real manifest with the weakest inputs the code allows:

```
requiredForPublish   23 ids | classified NOT protected: 0
alwaysOnRelease      14 ids | classified NOT protected: 0
nonRecursive          8 ids | classified NOT protected: 0
```

It is three flags, not the two originally reported — `nonRecursive` has the same
property, so any future arm on it is born unreachable too.

A fixture named `metadata-only-protected-gate` would therefore emit an ordinary
protected gate and **pass while proving nothing**: precisely the failure this
corpus exists to catch. Two workers had already agreed to build it on the
strength of the original entry, which is why the correction is recorded here
rather than quietly dropped.

This does **not** weaken the `isTest` finding below. That one is live — 11
predicate matches lost across 9 families, and its second arm genuinely fires.
The two look alike and have opposite dispositions, which is the whole reason
each needed measuring rather than reasoning about.

## An arm no run can currently verify (superseded — see above)

`isProtectedGateNode` has a metadata arm — `requiredForPublish` or
`alwaysOnRelease` — and those keys appear on **zero nodes across all fourteen
benchmark fixture families**. Protection travels through `node.risk === 'protected'`
in every case the corpus contains.

So the arm is now normalized against the string/boolean drift, but it is
**unverified by any run either lane can produce**, and a green suite is not
evidence it works. The missing case is a gate protected *only* by metadata, with
`risk !== 'protected'`.

It was not added this round because a new fixture family changes the v1 corpus's
sealed hash and `corpus.test.ts` requires every declared family to be referenced
by `config/context-graph-benchmark.json`, which is outside the benchmark lane's
ownership. **It belongs with the fixture work in CG2-14 and must not evaporate
between rounds** — which is the only reason it is written here rather than left
in a report.

The consumer-level normalization (`contextNodeFlag`) is a workaround, not the
fix. It works only for call sites that remember to use it; the format-level type
preservation above is what makes forgetting impossible.

## Behaviour that changes for the better, and must still be announced

Four states in `verification/context-graph-affected.ts` used to **fail open** and
now fail closed: meta absent, meta corrupt, snapshot/meta hash disagreement, and
schema-revision mismatch. The last of those v1 could not detect at all on the
disk path — it treated any readable snapshot as fresh, which is the silent
downgrade the contract forbids.

This is correct, and it is still a behaviour change: a workspace whose index is
in one of those states now gets an empty `recommended_tests` with `ok: false` and
a repair command, where before it got a confident answer computed from a graph
nobody had verified. Gate selection never shrinks in those states — the error
path returns the exact selector unchanged — but the test recommendation does go
empty, loudly.

Also worth carrying: the `context-graph:*` gates live in the `confidence` preset,
not `release`. The release dynamic selector's 33-gate manifest contains none of
them, so their globs never influence a release plan. That surprised the lane that
found it and will surprise CG2-14.

## Verified with evidence, not assertion

The affected-selector migration was checked against **12 real changed-file sets**
from this repository's history — 1 to 127 files each, spanning docs-only, single
file, release prep, and the 74-file CRK2 commit — captured from v1 sources and
compared against the migrated ones through the same build pipeline.

**Zero shrinks.** Gate sets, publish sets, protected gates, recommended tests,
error codes, warnings and snapshot hashes were byte-identical in all twelve. The
only differences are two additions, from the stale glob table described in the
consumer inventory.

This is the evidence that matters for the release: a selector that quietly picks
fewer gates or fewer tests looks like a speed-up until something ships broken,
and a passing unit test cannot detect it.

## Cross-lane defects found by workers checking each other

Worth carrying into the release notes because they are the ones no single lane
would have found.

- **Anchor receipt named the wrong term.** Rank and score were written
  first-wins, the term id last-wins. A node named by both its canonical id and
  its path reported the first term's rank beside the second term's id — a
  receipt describing a lookup that never happened. The three fields are one
  record and are now written under one rule.
- **Extractor stats were summed from fragments rather than counted from the
  merged graph.** A reused fragment can carry an edge into a since-deleted file;
  summing raw fragments put that pruned edge into stats, which are hashed into
  the snapshot, so an incremental build landed on a different content address
  than a full rebuild. The graph was right and only its name was wrong, which is
  why nothing else caught it.
- **Per-field dedupe flattened BM25F term frequency** to zero or one, silently
  reducing the ranker to a field-weight lookup while every test still passed.
