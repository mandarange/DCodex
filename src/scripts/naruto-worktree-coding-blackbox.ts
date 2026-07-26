#!/usr/bin/env node
// @ts-nocheck
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { assertGate, emitGate, importDist } from './gate-lib.js'
import { makeGitFixture, run } from './lib/git-worktree-fixture.js'

const managerMod = await importDist('core/git/git-worktree-manager.js')
const diffMod = await importDist('core/git/git-worktree-diff.js')
const mergeMod = await importDist('core/git/git-worktree-merge-queue.js')
const repo = makeGitFixture('naruto-worktree-blackbox')
process.env.SKS_WORKTREE_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'sks-naruto-blackbox-'))
const allocations = []
for (const file of ['a.txt', 'b.txt']) {
  const allocation = await managerMod.allocateWorkerWorktree({ repoRoot: repo, missionId: 'M-naruto-blackbox', workerId: file.replace('.txt', ''), slotId: file.replace('.txt', '') })
  fs.writeFileSync(path.join(allocation.worktree_path, file), `${file}\nworker-change\n`)
  allocations.push(allocation)
}
assertGate(run('git', ['status', '--porcelain=v1'], repo).trim() === '', 'main worktree must remain unchanged before integration')
const diffs = []
for (const allocation of allocations) {
  diffs.push(await diffMod.exportGitWorktreeDiff({ mainRepoRoot: repo, worktreePath: allocation.worktree_path, missionId: 'M-naruto-blackbox', workerId: allocation.worker_id }))
}
const integration = await managerMod.allocateWorkerWorktree({ repoRoot: repo, missionId: 'M-naruto-blackbox', workerId: 'integration', slotId: 'integration' })
const report = await mergeMod.applyGitWorktreeMergeQueue({ integrationWorktreePath: integration.worktree_path, diffs })
assertGate(report.ok === true && report.applied_count === 2, 'integration worktree merge report must apply worker diffs', report)
assertGate(run('git', ['status', '--porcelain=v1'], repo).trim() === '', 'main worktree must remain unchanged after integration queue')
emitGate('naruto:worktree-coding:blackbox', { allocations: allocations.length, applied_count: report.applied_count })
