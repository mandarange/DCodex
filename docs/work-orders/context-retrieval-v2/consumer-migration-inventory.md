# CRK2 Consumer Migration Inventory — CG2-13 / CG2-15

Measured on `57d40103`, before any consumer was migrated.

The card names nine consumer *areas*. The actual surface is **31 production
files** importing a v1 JSON-runtime module. Writing them down before the
migration starts is the difference between a completed cutover and one that
looks complete because nobody counted.

The command that produced this list is the same one the deletion gate should
run, so the inventory and the gate cannot drift:

```bash
grep -rnl "query/load.js\|query/seeds.js\|snapshot-cache.js\|graph-index.js\|context-graph-seeds" src | grep -v "__tests__" | grep -v "\.test\."
```

## Two populations, two fates

**Seven files are the v1 engine itself** and are *deleted* by CG2-15 rather than
migrated. They are in the list because they import each other:

- `query/load.ts`, `query/seeds.ts`, `query/traverse.ts`, `query/rank.ts`,
  `query/explain.ts`, `query/snapshot-cache.ts`, `query/index.ts`
- plus `search/context-graph-seeds.ts`, the second seed engine

**The remaining twenty-three are real consumers** that must move to the
`query/index.ts` facade. Counting them as migrated because their imports
disappeared when the engine was deleted would be the failure mode worth naming:
a consumer whose call site vanished has not been proven to still work.

## By area

| Area | Files | Notes |
| --- | ---: | --- |
| `triwiki/context-graph/projections` | 6 | anchors, attention, code-pack, code-pack-workspace, module-view, node-summary |
| `triwiki/context-graph/query` | 7 | the v1 engine — deleted, not migrated |
| `triwiki/context-graph/lint` | 3 | index, rules, warnings |
| `triwiki/context-graph/benchmark/adapters` | 3 | graph-projection, graph-session, slice-conflicts |
| `search` | 2 | `context.ts` (migrate), `context-graph-seeds.ts` (delete) |
| `naruto` | 2 | advisor, advisor-scope |
| `triwiki` | 2 | code-pack, triwiki-cleanup |
| `release` | 1 | gate-manifest |
| `verification` | 1 | context-graph-affected |
| `align` | 1 | code-navigation-align |
| `subagents` | 1 | triwiki-attention |
| `triwiki/context-graph/compiler` | 1 | index |
| `triwiki/context-graph/extractors/topology` | 1 | gate-edges |

## Correction: the grep over-counts

`release/gate-manifest.ts` is a **false positive**. It imports nothing from the
graph; the grep matched the string literal `'src/core/search/context-graph-seeds.ts'`
inside a glob table (now `release/gate-affected-globs.ts:88`) that *enumerates*
the graph's consumers. A literal naming a file is not a dependency on it.

Two consequences, and the second matters more:

- The real surface is 22 consumers plus 8 engine files, not 23 plus 7.
- **The deletion gate cannot be a bare grep.** Run it on imports, or the glob
  table that lists the engine will keep the gate red forever after the engine is
  deleted — and the obvious fix at that point, deleting the literal, would
  quietly remove the very entry that makes editing the seed engine select the
  context-graph gates.

### Correction: an import-only gate is necessary and not sufficient

The advice above is right about why a bare grep fails and wrong to stop at
imports. Two call sites read `context-graph.json` through a hand-built
`path.join(...)` and import nothing from the store —
`commands/triwiki-atlas-command.ts` and `scripts/architecture-map-check.ts`. An
import-only gate sees neither, and both were live snapshot readers when this
inventory was written.

So the gate needs **two** checks that fail independently: no production import of
a JSON snapshot module, **and** no production path-literal read of
`context-graph.json` / `context-graph.prev.json` outside the store itself. A gate
that runs one of them reports a clean cutover over a file that is still being
read.

That glob table also turned out to be stale: editing
`align/code-navigation-align.ts` or `triwiki/triwiki-cleanup.ts` selected no
`context-graph:*` gate at all. Both are consumers. Fixed as part of CG2-13, and
the superset comparison shows the change is purely additive.

## Two that need care beyond a mechanical import swap

**`release/gate-manifest.ts`** feeds the affected-gate selector. The card is
explicit that the selector may only *add* gates, never shrink the existing exact
set. A migration that changes which gates a change selects is a release-safety
regression wearing a refactor's clothes, so this one needs a before/after
comparison on real diffs rather than a passing unit test.

**`verification/context-graph-affected.ts`** decides which tests run for a
change. Same shape of risk: silently selecting fewer tests looks like a speed-up
until something ships broken.

## What the deletion gate must assert

- Zero production imports of `context-graph-seeds`
- Zero production imports of any JSON snapshot reader
- Zero **path-literal** reads of `context-graph.json` / `context-graph.prev.json`
  outside the store — a separate check, because the import check does not see one
- Zero reads of either file on a query path
- Every one of the twenty-three migrated consumers has an integration test that
  exercises it through the facade — not merely that it compiles

## Cleared: the freshness class

Every caller that read the snapshot **only** to decide staleness now uses
`contextIndexFreshness` — `hooks-runtime/context-graph-freshness-preflight.ts`,
`commands/wiki-command.ts`, `commands/triwiki-graph-command.ts`,
`commands/triwiki-atlas-command.ts`, `scripts/architecture-map-check.ts`. Same
verdict and same reason list on every measured pair.

Two consequences for the deletion list:

- `store/graph-status.ts` — `contextGraphStatus()` has **zero production call
  sites** and is dead production code.
- `readContextGraphPrevSnapshot` / `context-graph.prev.json` — **removed.** The
  file was written on every compile and never read back, by anything, since the
  commit that introduced it: the write and the reader landed together in
  `acf504c2` and the incremental compiler read the *current* snapshot instead.
  Both are gone, and the commit that used to overwrite the duplicate now
  reclaims it, so the leftover is not stranded on already-built workspaces.
  Measured saving on this repository: **63.66 MB, 48.6% of `.sneakoscope/wiki`**.
  Its name stays on `WIKI_CONTEXT_EXCLUDED` deliberately — see the release
  record.

## The four content readers are now one migrated and three blocked

`verification/context-graph-affected.ts` is **migrated** and is the one that
mattered — it decides which tests run for a change. Evidence is a before/after
on 19 real diffs through both engines against the same graph, not a passing
suite: **gates identical in 19 of 19**, recommended tests identical in 17 of 19,
zero lost gates and zero lost tests anywhere.

The remaining three are **not migrations**, and calling them that would have
produced a broken cutover:

- **`triwiki-graph-command.ts:83` and `wiki-command.ts:229` (lint).**
  `runContextGraphLint` is not a graph query: 2 of its 8 rules assert things
  about *the JSON file's bytes*. `determinismIssues` compares
  `JSON.stringify(snapshot.nodes)` against a canonical sort — array order and key
  order — and `hashIssues` recomputes `snapshotHash` from that serialization.
  Neither property exists in a fixed-stride binary whose integrity is per-section
  checksums plus pointer/meta fingerprint agreement. Nor is there a recorded
  verdict to read instead: `ContextIndexMeta` carries no lint field, because
  `commitContextIndexGeneration` refuses to publish on lint failure — under CRK2,
  *the index existing and opening* is the verdict. Migrating means writing
  different assertions, which is a contract change and needs its own card.
- **`architecture-map-pipeline.ts:123,164`.** `sealBaseline` / `buildAfterReview`
  embed the **whole snapshot** into `ArchitectureInputBundleV1.graph` and hash it
  into `canonicalHash`. The reader deliberately offers no bulk enumeration — ADR
  §3 removed `getNode()` — so this would mean materializing 28,660 nodes and
  77,347 edges, the exact thing CRK2 exists to stop. And the rebuilt bundle would
  not hash identically (`ContextGraphNodeView` and `ContextGraphNode` are
  different shapes), changing every sealed baseline fingerprint. That is a
  baseline-identity decision, not a migration.

**So the JSON snapshot cannot be deleted in this release.** The v1 *engine* can
go once its last importers do, but the file itself still has two legitimate
readers whose contracts have to change first.

What still reads the snapshot, and why:

| Reason | Sites |
| --- | --- |
| Needs nodes/edges | `triwiki-graph-command.ts:83`, `wiki-command.ts:229`, `architecture-map-pipeline.ts:123,164`, `verification/context-graph-affected.ts:387` |
| Compiler write-side | `compiler/index.ts:270,334`, `store/snapshot-store.ts:244,287` |
| v1 engine (deleted, not migrated) | `query/load.ts:166`, `query/index.ts:220` |
