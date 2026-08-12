/**
 * The affected-glob table is a floor, and this suite is what makes that a rule
 * rather than a comment.
 *
 * `selectGates` decides which gates a release actually runs. A glob removed from
 * `affectedGlobsFor` does not fail anything — it silently stops selecting a gate
 * for a change that used to select it, which reads as a faster release right up
 * until the change that needed it. So the entries that existed before the CRK2
 * consumer migration are frozen here by value: adding is free, removing one has
 * to break a test first.
 *
 * The second half asserts the property the frozen list exists to protect: every
 * file that reaches the context graph at runtime selects the gates that prove the
 * context graph. That set grew during CG2-13, because two consumers were reaching
 * the graph without any `context-graph:*` gate noticing.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { affectedGlobsFor, buildGateManifest, selectGates } from '../gate-manifest.js'

const CONTEXT_GRAPH_GATES = [
  'context-graph:contract',
  'context-graph:quality',
  'context-graph:performance',
  'context-graph:legacy-closure'
]

/**
 * The CG2-14 gates measure the same engine from the other side — index bytes,
 * corrupt-input rejection, crash recovery. They deliberately share the v1 gates'
 * affected set: a narrower copy would drift, and the drift would surface as a v2
 * gate that quietly stops running for a change the v1 gates still cover.
 */
const CONTEXT_GRAPH_V2_GATES = [
  'context-graph-v2:contract',
  'context-graph-v2:quality',
  'context-graph-v2:performance',
  'context-graph-v2:legacy-closure'
]

/**
 * The `context-graph` globs as they stood on `57d40103`, before any consumer was
 * migrated. Every one of these must still be selectable; the list is never edited
 * down, only appended to.
 */
const FROZEN_CONTEXT_GRAPH_GLOBS = [
  'src/core/triwiki/context-graph/**',
  'src/core/search/context.ts',
  'src/core/search/context-graph-seeds.ts',
  'src/core/subagents/triwiki-attention.ts',
  'src/core/triwiki/code-pack.ts',
  'src/core/naruto/context-graph-advisor.ts',
  'src/core/naruto/context-graph-advisor-scope.ts',
  'src/core/verification/context-graph-affected.ts',
  'src/core/commands/wiki-command.ts',
  'src/core/commands/triwiki-graph-command.ts',
  'config/context-graph-benchmark.json',
  'schemas/triwiki/context-graph.schema.json',
  'src/scripts/context-graph-check.ts',
  'package.json'
]

const gates = buildGateManifest(CONTEXT_GRAPH_GATES).gates

function selected(changedFiles: string[]): string[] {
  return selectGates([...gates], changedFiles, {}).selected.map((entry) => entry.id).sort()
}

test('every glob the table carried before the consumer migration is still there', () => {
  for (const id of [...CONTEXT_GRAPH_GATES, ...CONTEXT_GRAPH_V2_GATES]) {
    const globs = affectedGlobsFor(id)
    for (const glob of FROZEN_CONTEXT_GRAPH_GLOBS) {
      assert.equal(globs.includes(glob), true, `${id} lost the affected glob ${glob}`)
    }
  }
})

test('the v2 gates select on the same changes as the v1 gates', () => {
  // Asserted as set equality rather than "the v2 set is non-empty": a v2 gate
  // with its own narrower list would pass a non-emptiness check while covering
  // strictly less than the gates it sits beside.
  for (const id of CONTEXT_GRAPH_V2_GATES) {
    assert.deepEqual(affectedGlobsFor(id), affectedGlobsFor('context-graph:contract'), `${id} carries its own glob list`)
  }
  assert.equal(affectedGlobsFor('context-graph-v2:contract').includes('src/scripts/context-graph-v2-check.ts'), true)
})

test('affectedGlobsFor stays reachable from the manifest module its callers import', () => {
  assert.equal(typeof affectedGlobsFor, 'function')
  assert.deepEqual(affectedGlobsFor('context-graph:quality'), affectedGlobsFor('context-graph:contract'))
  assert.equal(gates.every((entry) => entry.affected_by.length > 0), true)
})

test('every runtime consumer of the context graph selects the gates that prove it', () => {
  const consumers = [
    'src/core/search/context.ts',
    'src/core/subagents/triwiki-attention.ts',
    'src/core/triwiki/code-pack.ts',
    'src/core/triwiki/triwiki-cleanup.ts',
    'src/core/naruto/context-graph-advisor.ts',
    'src/core/verification/context-graph-affected.ts',
    'src/core/align/code-navigation-align.ts',
    'src/core/align/align-context-index.ts',
    'src/core/commands/wiki-command.ts',
    'src/core/triwiki/context-graph/query/kernel.ts',
    'src/core/triwiki/context-graph/query/hydrate.ts',
    'src/core/triwiki/context-graph/runtime-index/reader.ts',
    'src/core/triwiki/context-graph/store/generation-store.ts'
  ]
  for (const file of consumers) {
    assert.deepEqual(selected([file]), [...CONTEXT_GRAPH_GATES].sort(), `${file} selected the wrong context-graph gates`)
  }
})

test('a file that never touches the graph selects none of its gates', () => {
  assert.deepEqual(selected(['src/core/codex/bridge.ts']), [])
  assert.deepEqual(selected(['README.md']), [])
  assert.deepEqual(selected([]), [])
})

test('a gate with no table entry still gets its own check script, never an empty set', () => {
  assert.deepEqual(affectedGlobsFor('secret:preservation'), [
    'src/scripts/secret-*.ts',
    'src/scripts/secret-preservation-*.ts'
  ])
})
