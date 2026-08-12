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
- Zero reads of `context-graph.json` / `context-graph.prev.json` on a query path
- Every one of the twenty-three migrated consumers has an integration test that
  exercises it through the facade — not merely that it compiles
