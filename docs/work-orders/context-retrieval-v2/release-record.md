# CRK2 Release Record

## CUTOVER IS BLOCKED: v2 recall is below v1

First paired run against real engines, 62 cases, 3 repeats:

```
              mustIncl  recall@k  prot.gate  conflict  reject  p50/p95/p99 ms
v1              0.461     0.359     0.636      0.000    0/9    0.31/0.59/0.80
v2              0.338     0.247     0.727      0.667    1/9    0.83/1.82/2.62

verdicts: 37 unchanged · 12 recall_regression · 9 rejection_mismatch · 4 improved
```

**v2 finds less than v1 and is slower.** CG2-15 must not cut over on these
numbers, and no threshold may be moved to make them acceptable.

The shape is not uniform, and the split is informative: v2 is *better* on the
safety lanes (protected gate 0.727 vs 0.636, conflict 0.667 vs 0.000 — v1 detects
no write-scope conflicts at all) and *worse* on general recall. The most likely
cause is the one another lane measured independently: v1 resolved symbol names
**structurally**, returning `exact_definition`, while CRK2 has BM25F lanes and
**no anchor-grade symbol table**. Format revision 1's exact table holds canonical
node ids only. So a symbol query that v1 answered exactly now goes through BM25F,
which ranks differently and misses more.

That is a coherent functional gap with a known cause, not a mystery — and it is
the thing to fix before cutover, not to tune around.

**A second candidate cause, from the publish run on the real repository:**
`omissions.cappedPostings` fired **102,635 times** while indexing 28,597 nodes.
`postingCapPerTerm` is 4,096, so on a graph this size the commonest terms lose
most of their matches before the query ever runs. That is a recall ceiling built
into the index rather than into the ranker, and it would not show up on a small
fixture — which is exactly why the paired run had to be against a real corpus.

Whether the cap or the missing symbol table dominates is unmeasured. Both are
plausible, they are independent, and fixing one will not reveal the other's size
unless each is measured on its own. Do that before changing either.

Two caveats on the numbers, both from the lane that produced them:

- **The latency comparison is not like-for-like yet.** v1 answers from an
  in-process cached index; v2 opens the workspace index per call. The p50 gap is
  partly measurement setup.
- **Gold realization is 62/76 (81.6%)**, which caps both engines but not equally.

**The one case the baseline warned about went the right way.**
`jargon-naruto-fanout`: v1 recall 0.00 at 0.50 ms → v2 recall **1.00 at 0.51 ms**.
Same latency, real answer. Five other Korean and jargon cases are still 0.00 on
both sides, and the `fast_but_empty` verdict fired during the run — so that guard
is live against real engines rather than only against the stub.

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

## A pattern worth naming: built, wired, tested, and never fed

Three defects in this build share one shape, and none of them could have been
caught by a passing test:

- The **lexicon** was built, tested with 50 passing cases, and imported by
  nothing, so every published index carried four empty dictionary sections.
- A **test fixture** then called the writer without the lexicon config, so a
  whole consumer suite went green against an index with no text in it — and the
  assertions had been written to match, locking zero recall in as expected.
- **Claim prose** is extracted, hashed, measured, and discarded, so the evidence
  lane indexes nothing at all.

In each case the component worked, its tests passed, and the data never arrived.
Unit tests cannot see this class; only an end-to-end measurement against a real
corpus can, which is the argument for the paired run existing at all.

Facts the 9.0.0 release notes and readiness docs must carry. Recorded as they
happen, because a release record assembled from memory at the end is a release
record that omits the inconvenient parts.

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

## BLOCKS RETIREMENT: there is no v2 freshness preflight

`search/context.ts` no longer queries the JSON snapshot, but `contextGraphStatus`
still parses all 58 MB of it as its first act, because it is the only source of
git-derived staleness. That was kept deliberately: replacing it with pointer/meta
integrity alone would let a workspace whose sources changed answer from a stale
index **with no error**, which is a worse regression than the byte cost.

Until a v2 preflight exists — `readContextGraphMeta` plus cache-key comparison,
without the snapshot read — the JSON runtime store cannot be deleted and the
retirement gate cannot pass.

## MUST FIX before 9.0.0: metadata values lose their type

`writer.ts` interns a metadata value as `Array.isArray(value) ? value.join(',') : String(value)`,
and the reader hands back `Record<string, string>`. So a boolean `true` written
by an extractor arrives as the string `"true"`, and every consumer asking
`metadata.isTest === true` silently stops matching. A string array is joined on
a comma that a value may itself contain, and no consumer can reverse it.

Measured across the fourteen benchmark fixture families: **11 predicate matches
lost across 9 families**, v1 `=== true` count 11, v2 count 0. `isTestNode`'s
`metadata.isTest === true` arm is dead under v2.

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

**Attempted and reverted.** JSON-encoding the value preserves the type, but it
also quotes strings into the string table, and the kernel fixtures deliberately
seed lexicon terms *through* metadata values (`metadata: { lexeme: 'kernel' }`),
so `termId('kernel')` stopped resolving. The correct fix needs a type code in
the metadata row — a 12→16 byte layout change — which is not something to land
in a tree with active lanes. The regression test is committed as a `todo` so it
reports on every run rather than living in someone's memory.

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
