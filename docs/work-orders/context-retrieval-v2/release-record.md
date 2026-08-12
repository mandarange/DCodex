# CRK2 Release Record

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

## An arm no run can currently verify

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
