#!/usr/bin/env node
// @ts-nocheck
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { assertGate, emitGate, importDist } from './gate-lib.js'
import { makeGitFixture } from './lib/git-worktree-fixture.js'

const managerMod = await importDist('core/git/git-worktree-manager.js')
const diffMod = await importDist('core/git/git-worktree-diff.js')
const integrationMod = await importDist('core/git/git-integration-worktree.js')
const queueMod = await importDist('core/git/git-worktree-merge-queue.js')
const repo = makeGitFixture('worktree-merge')
process.env.SKS_WORKTREE_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'sks-wt-merge-'))

const a = await managerMod.allocateWorkerWorktree({ repoRoot: repo, missionId: 'M-merge', workerId: 'a', slotId: 'slot-001' })
const b = await managerMod.allocateWorkerWorktree({ repoRoot: repo, missionId: 'M-merge', workerId: 'b', slotId: 'slot-002' })
fs.writeFileSync(path.join(a.worktree_path, 'a.txt'), 'alpha\nfrom-a\n')
fs.writeFileSync(path.join(b.worktree_path, 'b.txt'), 'bravo\nfrom-b\n')
const diffA = await diffMod.exportGitWorktreeDiff({ mainRepoRoot: repo, worktreePath: a.worktree_path, missionId: 'M-merge', workerId: 'a' })
const diffB = await diffMod.exportGitWorktreeDiff({ mainRepoRoot: repo, worktreePath: b.worktree_path, missionId: 'M-merge', workerId: 'b' })
const integration = await integrationMod.createGitIntegrationWorktree({ repoRoot: repo, missionId: 'M-merge' })
const report = await queueMod.applyGitWorktreeMergeQueue({ integrationWorktreePath: integration.worktree_path, diffs: [diffA, diffB] })

assertGate(report.ok === true && report.applied_count === 2, 'merge queue must apply non-conflicting worktree diffs', report)
assertGate((report.strategy_results || []).every((row) => row.strategy === 'diff-apply-3way'), 'merge queue must record the diff apply strategy for worktree diffs', report.strategy_results || [])
assertGate(fs.readFileSync(path.join(integration.worktree_path, 'a.txt'), 'utf8').includes('from-a'), 'integration worktree must include first diff')
assertGate(fs.readFileSync(path.join(integration.worktree_path, 'b.txt'), 'utf8').includes('from-b'), 'integration worktree must include second diff')
assertGate(fs.readFileSync(path.join(repo, 'a.txt'), 'utf8') === 'alpha\n', 'main worktree must remain unchanged before integration commit')

emitGate('git:worktree-merge-queue', {
  applied_count: report.applied_count,
  changed_files: report.changed_files
})
