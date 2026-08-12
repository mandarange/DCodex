# Context Retrieval Kernel v2 (CRK2)

Status: **accepted, implemented through CG2-14**. This is the frozen contract
every CG2 card builds against. Nothing below is negotiable per-worker; a change
here is a change to the ADR first — see the §4 amendment, which is what that rule
looks like when it is followed.

CG2-00 measured the starting point on `9fadd4e2` — see
[baseline-summary.md](../work-orders/context-retrieval-v2/baseline-summary.md).
The graph turned out to be 2.5× the size the work order recorded (55.7 MB, 26,973
nodes, 70,832 edges), which is why byte budgets below are expressed as ratios of
a measured baseline rather than as absolute numbers copied from the order.

## 1. What this replaces, and what it must not become

CRK2 collapses two seed engines, a five-stage exhaustive query pass, the whole
JSON runtime store, pre-selection explanation, and full previous-snapshot
carry-forward into one bounded retrieval kernel reading a compact binary index.

Four properties are load-bearing. They are stated as prohibitions because each
one is a thing a plausible implementation would otherwise drift into:

- **No vectors.** No embedding model, no ANN structure, no cosine anything. Rank
  comes from BM25F, graph proximity, and anchor exactness.
- **No LLM.** Nothing in the query path calls a model. Retrieval is
  deterministic and offline.
- **No fallback.** A missing, stale, or corrupt index is an error with a repair
  command, never a silent downgrade to a slower path. A fallback would make the
  performance floor unobservable and the correctness floor unprovable.
- **No daemon.** No resident process, no background compaction thread. Compile
  happens in the compile command; query happens in the query.

## 2. Versioning

The binary format carries a **format revision**, an integer that starts at `1`
and increments only when the on-disk layout changes incompatibly.

The product version never appears in a schema string, a format revision, or a
generation path. `sneakoscope@9.0.0` shipping CRK2 is a fact about the release,
not about the format; a 9.1.0 that does not touch the layout must produce
byte-identical indexes.

| Artifact | Identifier |
| --- | --- |
| Binary index | magic `SKSCG2`, `formatRevision: u16` — **currently `2`** |
| Operation journal | `sks.context-graph-operation.v2` |
| Fragment manifest | `sks.context-graph-fragment-manifest.v1` |
| Index meta | `sks.context-graph-index-meta.v1` |
| Current pointer | `sks.context-graph-index-pointer.v1` |
| Identifier lexicon | `sks.context-lexicon.v1` |
| Baseline artifact | `sks.context-graph-v2-baseline.v1` |

A reader that meets a `formatRevision` it does not implement fails closed with
`context_index_format_unsupported`. It does not attempt partial reads.

### Revision 2 (2026-08-13, CG2-14): typed metadata, and no backward read

The metadata row goes 12 → 16 bytes, gaining a `u16` type tag and a `u16`
ordinal. `value` remains **always** a string-table id whatever the tag says —
that is a security property, not a convenience: a corrupt tag can at worst yield
a correctly-bounded string read back as the wrong type, and can never cause four
bytes to be interpreted as an offset.

**A revision-2 reader does not read a revision-1 index, and the refusal is
deliberate in both directions of skew.** The index is a content-addressed cache
that `sks align run --rebuild-index` reproduces deterministically, so there is
nothing to migrate and §6 already declines to treat the previous generation as a
rollback target. A stride-conditional decoder would turn "which layout am I
reading" into a per-row question when this section makes it an open-time one —
and accepting the older revision would not fail visibly, it would walk the
metadata section at the wrong stride and return a plausible node assembled from
misaligned columns. `formatRevision` is therefore the first field the pointer
parser evaluates, before the config fingerprint and before any index byte is
read.

**A fixed-stride section's `count` and `length` must agree exactly** —
`count * stride === length`, not merely `<=`. An under-claimed count is invisible
to the section checksum, which covers `offset..offset+length` and does not care
how many rows the descriptor says live there; the reader simply stops early and
answers from a truncated section. This closed a revision-1 hole, not one the row
widening introduced.

## 3. Frozen types

These are the types every card codes against. Field names are part of the
contract.

```ts
/** Resolved before any lane runs; lanes never re-derive it. */
interface QueryPlan {
  readonly profile: ContextRetrievalProfile;
  readonly shape: QueryShape;
  readonly termIds: readonly number[];
  readonly fieldMask: number;
  readonly profileMask: number;
  readonly maxDepth: number;
  readonly frontierBudget: number;
  readonly postingCapPerTerm: number;
  readonly candidateBudget: number;
  readonly tokenBudget: number;
}

/** Integer-only until the final API boundary. No node objects in the hot path. */
interface CompactCandidate {
  readonly node: number;
  readonly score: bigint;
  readonly seed: number;
  readonly parentNode: number;
  readonly parentEdge: number;
  readonly depth: number;
  readonly flags: number;
}

/** One lane's contribution to a fused candidate, kept for the receipt. */
interface LaneContribution {
  readonly lane: RetrievalLane;
  readonly rank: number;
  readonly score: bigint;
  readonly termIds: readonly number[];
}

type RetrievalLane = 'anchor' | 'lexical' | 'coarse' | 'local_graph';
```

`ContextIndexReader` is fixed as written in §5.5 of the work order. Two
consequences that implementations get wrong if left implicit:

- `EdgeCursor` iterates index/target/type/confidence **without allocating** a
  per-edge object or an intermediate array.
- There is no `getNode()`. Whole-node materialization exists only as
  `hydrateNode`, and only selected nodes reach it (§6).

## 4. Confidence mapping

Confidence is a claim about *why* a node was retrieved, not how highly it
scored. The mapping is total and exclusive:

| Lane | Confidence | Rule |
| --- | --- | --- |
| `anchor` | `exact` | Stable node ID, exact path, exact label, command/route/pipeline/gate/schema ID, ~~basename~~ (amended below), caller-verified seed, focus path |
| `lexical` | `text_candidate` | BM25F match. **A BM25F score alone never yields `exact`**, at any magnitude |
| `coarse` | `text_candidate` | Same ceiling as lexical |
| `local_graph` | inherited, demoted one step | A neighbour of an `exact` seed is a candidate, not an exact match |

An unsupported-language result is never promoted to an exact relation. This is
the rule that the current engine's `korean` and `jargon` cases would otherwise
be "fixed" by violating.

### Amendment (2026-08-13, CG2-14): a name match is a ranking signal, not a confidence claim

**`basename` is removed from the `anchor`/`exact` row.** A name match — node
label, path basename, or that basename's stem — may raise a candidate's rank and
may seed the walk, and it may **not** set `exact`, `file_path`, or
`exact_definition`. It claims `text_candidate` like any other scored match.

The row was written for a format that carried names, before one did; when
revision 1 shipped, "basename" was implemented as whole-path and the row went
untested. Implementing it as written turns out to contradict this section's own
first sentence — *confidence is a claim about why a node was retrieved, not how
highly it scored*. A basename does not uniquely identify a node: the benchmark
carries `basename-index-ts-collision` precisely because `index.ts` names many.
An `exact` basename would assert exact confidence for every colliding node at
once, at most one of which the caller meant, which empties `exact` of the
distinction it exists to draw. A caller-supplied verbatim path stays `exact`
because the caller resolved it; a name the *engine* matched was resolved by
nobody.

The narrowing was measured, not assumed. Every case the name lane recovers
reaches **1.000** must-include recall as a pure ranking signal, and §4 violations
held at 3 across the change. The conservative reading cost zero recall, so no
trade was made — which is the only reason it can be recorded as settled rather
than as a tension.

Left open: an exact **label** match that resolves to exactly one node would
satisfy the "why" test and could be `exact`. It is not implemented, because
nothing measured requires it and an unmeasured confidence promotion is the
failure this section exists to prevent.

## 5. Errors and repair

Every failure names one command. No error is advisory.

| Code | Meaning | Repair |
| --- | --- | --- |
| `context_index_missing` | No current pointer | `sks align run` |
| `context_index_stale` | Pointer's snapshot hash ≠ workspace fingerprint | `sks align run` |
| `context_index_format_unsupported` | `formatRevision` **newer** than reader, bad magic, unknown section kind | `sks update` |
| `context_index_format_unsupported` | `formatRevision` **older** than reader — the build is current, the artifact is stale | `sks align run --rebuild-index` |
| `context_index_checksum_mismatch` | Section checksum failed | `sks align run --rebuild-index` |
| `context_index_truncated` | Declared count/offset/length exceeds file | `sks align run --rebuild-index` |
| `context_index_pointer_meta_divergent` | Pointer and meta disagree on snapshot/config/source fingerprint | `sks align run --rebuild-index` |
| `context_operation_journal_corrupt` | Journal unparseable | `sks align run --rebuild-index` |

Corrupt input is rejected, never repaired in place. There is no best-effort
byte-salvaging reader — a reader that guesses is a reader whose output nothing
can attest to.

`context_index_format_unsupported` appears twice on purpose. The code is frozen
vocabulary and does not split; the **repair** differs by direction, because only
one of the two directions is fixed by updating. The original rule assumed the
artifact was always ahead of the reader. Revision 2 inverted the common case:
on upgrade every existing workspace holds a revision-1 index and a build that is
already current, and answering `sks update` there names a command that changes
nothing while never mentioning the repair that works. Both revisions are known
integers at the refusal site, so the direction is decided from evidence rather
than assumed. Any *other* unsupported-format cause keeps `sks update`, since bad
magic says nothing about which side is stale.

The table above is reader-facing: every code tells a user their index is
damaged and names the command that rebuilds it. The compile side needs one more,
because refusing to *publish* an index is not the same event:

| Code | Meaning | Repair |
| --- | --- | --- |
| `context_index_commit_blocked` | The compiler declined to publish — lint failed, a stale writer tried to commit, or another operation holds the pointer | Resolve the reported blocker; the current index is intact and still serving |

Mapping a refusal-to-publish onto a reader code would tell a user to rebuild an
index that is not damaged — a wrong instruction, not merely an imprecise one.

## 6. Current pointer and meta

The pointer is small, atomically replaced, and written last.

- Generation path is `<snapshotHash>.idx` — content-addressed, so a given
  snapshot always names the same file.
- The pointer is replaced only after every lint and checksum passes.
- Pointer and meta must agree on snapshot hash, config fingerprint, and source
  fingerprint. Divergence is `context_index_pointer_meta_divergent`, not a
  preference for one of them.
- The pointer is written **last**, which puts meta before it and opens a window
  where a crash could manufacture a false divergence. Meta is therefore written
  twice: an immutable per-generation sidecar staged with the index, and the
  mirror readers use. Recovery re-derives the mirror from the pointed
  generation's sidecar — deterministic re-derivation from checksum-verified
  bytes, never a choice between two disagreeing records. If the sidecar is gone,
  the mirror is left alone and the divergence stays visible.
  (The work order numbers meta after the pointer; this ADR takes precedence.)
- Exactly two generations are retained: current and previous. Older generations
  are removed at compile end.
- **The previous generation is not a rollback target.** It exists for
  incremental merge and audit. Offering it as a fallback would reintroduce the
  silent-downgrade path §1 forbids.
- Queries never read the operation journal, and never read a partial index.

## 7. `hydrated` changes meaning

In v1, `hydrated` asserted a per-node `stat` at query time. In CRK2 it asserts
that the node came from a **fresh index whose compile-time source hash was
verified**, with no per-node syscall on the hot path.

This is a semantic change to an existing field, so it is recorded in the schema,
the tests, and the docs together. Strict diagnostics and `validate` still do real
filesystem verification — deduped by unique provenance path, batched through a
bounded `Promise.all` — but on the validation path, never the query path.

## 8. JSON runtime retirement

The JSON runtime store and previous store are **deleted**, not deprecated. On the
measured baseline they are 108 MB per workspace and cost 175 MB heap to parse.

Retirement policy:

- No production code path reads `context-graph.json` or `context-graph.prev.json`
  at query time after CG2-15.
- A gate asserts no JSON runtime reader remains (CG2-14).
- The compiler may still *write* human-readable diagnostics; those are outputs,
  not a runtime store, and nothing may read them back into a query.

## 9. External compatibility

Retrieval profiles and response shapes visible to callers do not change in this
work. Nine consumers migrate to the kernel (CG2-13) without their own contracts
moving.

| Surface | v1 | CRK2 |
| --- | --- | --- |
| Retrieval profiles | unchanged | unchanged |
| Response candidate shape | unchanged | unchanged |
| `hydrated` semantics | per-node stat | fresh-index + compile-time hash (§7) |
| Explanation | computed for all ranked candidates | computed for selected only |
| Confidence values | unchanged set | unchanged set, mapping tightened (§4) |

## 10. Test-only v1/v2 comparison seam

v1 and v2 must be runnable side by side to prove the quality floors — and that
seam must not become a runtime fallback.

- The seam lives in test/bench code and takes both engines as explicit
  arguments. No environment variable, no config flag, no runtime branch.
- Production code contains no reference to a v1 engine after CG2-15; the
  comparison harness holds the last references and is deleted with it.
- Floors it proves, all hard: `provenanceCoverage = 1.0`,
  `protectedGateRecall = 1.0`, `conflictRecall = 1.0`, determinism 0 mismatch,
  corrupt-input rejection 100%.
- Latency comparisons must be quoted alongside recall for the same case. The
  baseline's fast-but-empty `korean`/`jargon` results are a quality floor to
  beat, not a latency budget to preserve.

## 11. Open questions

None. Anything unresolved blocks the cards that depend on it, so it is resolved
here or the card does not start.
