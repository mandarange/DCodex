/**
 * The mission's declared risk reaches the traversal, or it does not exist.
 *
 * `risk` was declared on the attention options, forwarded through the projection
 * and read by the kernel — and the one production caller never passed it, so
 * every mission got the profile's ordinary 2-hop traversal. A test that asserted
 * "the parameter was forwarded" is exactly the shape of test that let that live
 * for ten builds. So the property here is a *reach* property, measured on a real
 * published generation: a node that sits three hops from the seed is in a
 * high-risk mission's answer and absent from a normal one's.
 *
 * The fixture is a bare import chain and nothing else:
 *
 *   alpha/aardvark.ts -> bravo/bandicoot.ts -> charlie/capybara.ts -> delta/dugong.ts
 *
 * Three properties of that shape are load-bearing and none of them is incidental:
 *
 * - **No module nodes.** A `module` that `contains` every file would put the last
 *   file two hops from the first through the module, and the test would pass at
 *   depth 2 while proving nothing.
 * - **The query is a bare distinctive token, never the seed's path.** Querying
 *   `alpha/aardvark.ts` normalizes to the terms `alpha`, `aardvark`, `ts` — and
 *   `ts` is a basename token of *every* file in the chain, so the lexical lane
 *   seeds all four at depth 0 and both risks return the whole graph. That is not
 *   a quirk of the fixture: any path-shaped query carries its extension as a
 *   term. `aardvark` matches one node, which is what leaves the traversal as the
 *   only way to reach the rest.
 * - **`dugong` is `risk: 'low'` and reached over `imports`.** `imports` is not a
 *   safety relation, so the safety closure — which runs on every query — cannot
 *   reach it; and a low-risk node earns nothing from the doubled risk-relevance
 *   bonus. Depth is left as the only thing that can explain its appearance.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { sha256 } from '../../fsx.js'
import {
  TASK_PROFILE_GATE_PROFILES,
  attentionRiskForTask,
  classifyTaskProfile,
  type TaskProfile
} from '../../runtime/task-profile.js'
import { readBoundedTriwikiAttention } from '../triwiki-attention.js'
import { prepareOfficialSubagentMission } from '../official-subagent-preparation.js'
import type { ContextGraphEdge, ContextGraphNode } from '../../triwiki/context-graph/contracts.js'
import { buildContextGraphSnapshot } from '../../triwiki/context-graph/compiler/serialize.js'
import {
  publishFixtureContextIndex,
  resetContextIndexCache
} from '../../triwiki/context-graph/query/__tests__/workspace-fixtures.js'

const CHAIN = [
  'alpha/aardvark.ts',
  'bravo/bandicoot.ts',
  'charlie/capybara.ts',
  'delta/dugong.ts'
] as const

/** The query. A bare basename token, so exactly one node is seeded — see the header. */
const SEED_TOKEN = 'aardvark'
const SEED_ID = `file:${CHAIN[0]}`
/** Two hops out: present in every answer, so a failure is truncation and not an empty result. */
const DEPTH_TWO_ID = `file:${CHAIN[2]}`
/** Three hops out: reachable only when the plan takes `maxDepthHighRisk`. */
const DEPTH_THREE_ID = `file:${CHAIN[3]}`

const OBSERVED_AT = '2026-02-02T00:00:00.000Z'
/** Anchor limit held constant across risks, so `triwikiAttentionLimit` cannot explain a difference. */
const ANCHOR_LIMIT = 6

interface ChainWorkspace {
  readonly root: string
}

function fileNode(relative: string, hash: string, body: string): ContextGraphNode {
  return {
    id: `file:${relative}`,
    kind: 'file',
    label: path.posix.basename(relative),
    path: relative,
    contentHash: hash,
    trust: 1,
    freshness: 'fresh',
    // Deliberately uniform and low: a node that earned its place from the
    // doubled risk-relevance bonus would not prove anything about depth.
    risk: 'low',
    tokenCost: Math.ceil(body.length / 4),
    metadata: { language: 'typescript', lines: body.split('\n').length, bytes: body.length, fanIn: 1, isTest: false }
  }
}

function importEdge(from: string, to: string, provenancePath: string, hash: string): ContextGraphEdge {
  return {
    id: `edge:imports:${from}->${to}`,
    from,
    to,
    type: 'imports',
    confidence: 'syntactic',
    provenance: { path: provenancePath, line: 1, hash, extractor: 'attention-risk-fixture' },
    observedAt: OBSERVED_AT
  }
}

/** A real temp workspace with a real published CRK2 generation. Nothing touches HOME. */
async function createChainWorkspace(prefix: string): Promise<ChainWorkspace> {
  resetContextIndexCache()
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  const nodes: ContextGraphNode[] = []
  const edges: ContextGraphEdge[] = []
  const hashes: string[] = []

  CHAIN.forEach((relative, ordinal) => {
    const name = path.posix.basename(relative, '.ts')
    const body = `export function ${name}(): string {\n  return '${name}';\n}\n`
    const absolute = path.join(root, relative)
    fs.mkdirSync(path.dirname(absolute), { recursive: true })
    fs.writeFileSync(absolute, body)
    const hash = sha256(body)
    hashes.push(hash)
    nodes.push(fileNode(relative, hash, body))
    if (ordinal > 0) {
      const previous = CHAIN[ordinal - 1] as string
      edges.push(importEdge(`file:${previous}`, `file:${relative}`, previous, hashes[ordinal - 1] as string))
    }
  })

  const snapshot = buildContextGraphSnapshot({
    nodes,
    edges,
    cycles: [],
    extractors: [{
      id: 'attention-risk-fixture',
      revision: '1.0.0',
      nodeCount: nodes.length,
      edgeCount: edges.length,
      issueCount: 0,
      skippedCount: 0
    }]
  })
  await publishFixtureContextIndex(root, snapshot)
  return { root }
}

function anchorIds(attention: { anchors: ReadonlyArray<{ id: string }> }): string[] {
  return attention.anchors.map((anchor) => anchor.id).sort()
}

test('the mapping escalates exactly the profiles whose gate battery is full', () => {
  const profiles = Object.keys(TASK_PROFILE_GATE_PROFILES) as TaskProfile[]
  const escalated = profiles.filter((profile) => attentionRiskForTask(profile) === 'high')
  // Pinned, not derived. The mapping reads `TASK_PROFILE_GATE_PROFILES` on
  // purpose — one classifier for "this mission is dangerous" rather than two
  // that drift — and that coupling means a future edit to the gate table also
  // moves traversal depth. This assertion is where that edit has to be noticed.
  assert.deepEqual(escalated, ['high-risk'])
  for (const profile of profiles) {
    assert.equal(attentionRiskForTask(profile), profile === 'high-risk' ? 'high' : 'normal', profile)
  }
})

test('a high-risk mission reaches a third hop that a normal one never sees', async () => {
  const workspace = await createChainWorkspace('sks-attention-risk-depth-')
  try {
    // One query string for both calls. Risk is the only input that differs, and
    // it comes from the shipped mapping rather than from a literal — so a
    // mapping that answered `normal` everywhere would fail here too.
    const high = await readBoundedTriwikiAttention(workspace.root, ANCHOR_LIMIT, SEED_TOKEN, {
      risk: attentionRiskForTask('high-risk')
    })
    const normal = await readBoundedTriwikiAttention(workspace.root, ANCHOR_LIMIT, SEED_TOKEN, {
      risk: attentionRiskForTask('bounded-work')
    })

    assert.equal(high.available, true)
    assert.equal(normal.available, true)
    assert.equal(high.anchor_limit, normal.anchor_limit)

    const highIds = anchorIds(high)
    const normalIds = anchorIds(normal)
    // The depth-2 node in both is what makes the depth-3 absence a truncation
    // rather than a query that simply failed under one of the two risks.
    assert.ok(normalIds.includes(DEPTH_TWO_ID), `normal risk lost the depth-2 node: ${normalIds.join(', ')}`)
    assert.ok(highIds.includes(DEPTH_TWO_ID), `high risk lost the depth-2 node: ${highIds.join(', ')}`)

    assert.ok(highIds.includes(DEPTH_THREE_ID), `high risk did not reach depth 3: ${highIds.join(', ')}`)
    assert.equal(
      normalIds.includes(DEPTH_THREE_ID),
      false,
      `normal risk reached depth 3, so this fixture proves nothing: ${normalIds.join(', ')}`
    )
    // The high-risk answer is a strict superset: deeper reach adds, it does not
    // reorder something out of the budget.
    assert.deepEqual(normalIds, highIds.filter((id) => id !== DEPTH_THREE_ID))
    // Bounded, and the cost of the extra hop is the extra node's tokens only.
    assert.ok(high.token_cost <= high.token_budget, `${high.token_cost} exceeded ${high.token_budget}`)
    assert.ok(high.token_cost > normal.token_cost)
    // §1.4: the deeper reach must not widen what a result may carry. Everything
    // the extra hop brought back is still a workspace-relative POSIX path.
    for (const anchor of high.anchors) {
      for (const ref of anchor.provenance) {
        assert.ok(
          !path.isAbsolute(ref.path) && !ref.path.startsWith('~') && !ref.path.includes('\\'),
          `leaky provenance path ${ref.path} on ${anchor.id}`
        )
      }
    }
  } finally {
    fs.rmSync(workspace.root, { recursive: true, force: true })
  }
})

test('mission preparation feeds the profile risk, so a migration mission gets the deeper answer', async () => {
  const workspace = await createChainWorkspace('sks-attention-risk-mission-')
  // Same anchor token in both goals, and the words that differ appear nowhere in
  // the graph, so the seed set cannot be what separates the two answers.
  const highGoal = `apply the database migration to the ${SEED_TOKEN} module`
  const boundedGoal = `refactor the loader in the ${SEED_TOKEN} module`
  assert.equal(classifyTaskProfile(highGoal), 'high-risk')
  assert.equal(classifyTaskProfile(boundedGoal), 'bounded-work')

  try {
    const prepare = async (missionId: string, goal: string) => {
      const dir = path.join(workspace.root, '.sneakoscope', 'missions', missionId)
      await fsp.mkdir(dir, { recursive: true })
      const prepared = await prepareOfficialSubagentMission({
        root: workspace.root,
        dir,
        missionId,
        goal,
        route: '$Naruto',
        mode: 'naruto'
      })
      return prepared.triwikiAttention
    }

    const high = await prepare('M-risk-high', highGoal)
    const bounded = await prepare('M-risk-bounded', boundedGoal)

    assert.equal(high.available, true)
    assert.equal(bounded.available, true)
    assert.ok(
      anchorIds(high).includes(DEPTH_THREE_ID),
      `the migration mission never saw the third hop: ${anchorIds(high).join(', ')}`
    )
    assert.equal(
      anchorIds(bounded).includes(DEPTH_THREE_ID),
      false,
      `the bounded mission reached depth 3: ${anchorIds(bounded).join(', ')}`
    )
    // Both still resolved the same seed, which is what makes the difference above
    // attributable to risk rather than to the two goal sentences.
    assert.ok(anchorIds(high).includes(SEED_ID))
    assert.ok(anchorIds(bounded).includes(SEED_ID))
    assert.ok(high.token_cost <= high.token_budget)
  } finally {
    fs.rmSync(workspace.root, { recursive: true, force: true })
  }
})
