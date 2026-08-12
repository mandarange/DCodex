// First import: preparation resolves managed config under $HOME and would
// otherwise read the operator's real home.
import '../../__tests__/helpers/isolated-test-home.js'
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { prepareOfficialSubagentMission } from '../official-subagent-preparation.js'
import { SUBAGENT_PLAN_FILENAME } from '../official-subagent-preparation.js'
import type { OfficialSubagentSlice } from '../official-subagent-prompt.js'

/**
 * Join-level cover for the mission change surface reaching the verification
 * budget.
 *
 * A unit test of `chooseVerificationBudget` cannot see this: it passes the
 * changed-file list itself, so it passes identically whether or not any caller
 * ever supplies one. These assertions read the committed `subagent-plan.json`
 * and assert the *budget the plan advertises*, which is only reachable through
 * a real preparation run.
 */

const GOAL = 'fix the report formatter and update its bundled defaults'

async function prepare(missionId: string, options: {
  slices: OfficialSubagentSlice[]
  readOnly?: boolean
}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sks-verification-surface-'))
  const dir = path.join(root, '.sneakoscope', 'missions', missionId)
  await fs.mkdir(dir, { recursive: true })
  const prepared = await prepareOfficialSubagentMission({
    root,
    dir,
    missionId,
    goal: GOAL,
    route: '$Naruto',
    mode: 'naruto',
    slices: options.slices,
    ...(options.readOnly === undefined ? {} : { readOnly: options.readOnly })
  })
  const committedPlan = JSON.parse(await fs.readFile(path.join(dir, SUBAGENT_PLAN_FILENAME), 'utf8'))
  return { root, prepared, committedPlan, cleanup: () => fs.rm(root, { recursive: true, force: true }) }
}

function writeSlice(id: string, paths: string[]): OfficialSubagentSlice {
  return {
    id,
    title: `write ${id}`,
    description: `own and change ${paths.join(', ')}`,
    kind: 'worker',
    paths
  }
}

function reviewSlice(id: string, paths: string[]): OfficialSubagentSlice {
  return {
    id,
    title: `review ${id}`,
    description: `read ${paths.join(', ')} without changing it`,
    kind: 'expert',
    paths,
    readOnly: true
  }
}

test('a declared release-surface write scope plans release verification', async () => {
  const fixture = await prepare('M-release-surface', {
    slices: [
      writeSlice('slice-a', ['src/core/report/formatter.ts']),
      writeSlice('slice-b', ['package.json'])
    ]
  })
  try {
    assert.equal(fixture.prepared.taskProfile, 'bounded-work')
    // With the changed-file list withheld the same mission plans 'affected':
    // the release surface is only reachable through a populated list.
    assert.equal(fixture.committedPlan.verification_budget, 'release')
    assert.equal(fixture.committedPlan.verification.budget, 'release')
    assert.equal(fixture.prepared.verification, 'release')
  } finally {
    await fixture.cleanup()
  }
})

test('a broad declared write surface escalates the planned budget to confidence', async () => {
  const paths = Array.from({ length: 8 }, (_, index) => `src/core/report/part-${index}.ts`)
  const fixture = await prepare('M-broad-surface', {
    slices: paths.map((entry, index) => writeSlice(`slice-${index}`, [entry]))
  })
  try {
    assert.equal(fixture.committedPlan.verification_budget, 'confidence')
  } finally {
    await fixture.cleanup()
  }
})

test('a narrow declared write surface still plans affected verification', async () => {
  const fixture = await prepare('M-narrow-surface', {
    slices: [
      writeSlice('slice-a', ['src/core/report/formatter.ts']),
      writeSlice('slice-b', ['src/core/report/defaults.ts'])
    ]
  })
  try {
    assert.equal(fixture.committedPlan.verification_budget, 'affected')
  } finally {
    await fixture.cleanup()
  }
})

test('a read-only slice scope is not a change surface', async () => {
  // The reviewer reads package.json; nobody writes it. Feeding the attention
  // query's `sliceWriteScopes` here instead would plan release verification for
  // a mission whose only writes are two source files.
  const fixture = await prepare('M-read-only-slice', {
    slices: [
      writeSlice('slice-a', ['src/core/report/formatter.ts']),
      reviewSlice('slice-review', ['package.json', 'CHANGELOG.md'])
    ]
  })
  try {
    assert.equal(fixture.committedPlan.verification_budget, 'affected')
  } finally {
    await fixture.cleanup()
  }
})

test('a read-only mission changes nothing regardless of declared scopes', async () => {
  const fixture = await prepare('M-read-only-mission', {
    readOnly: true,
    slices: [
      writeSlice('slice-a', ['package.json']),
      writeSlice('slice-b', ['CHANGELOG.md'])
    ]
  })
  try {
    assert.equal(fixture.committedPlan.read_only, true)
    assert.equal(fixture.committedPlan.verification_budget, 'affected')
  } finally {
    await fixture.cleanup()
  }
})
