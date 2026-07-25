#!/usr/bin/env node
// @ts-nocheck
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { assertGate, emitGate, importDist } from './gate-lib.js'
import { makeGitFixture } from './lib/git-worktree-fixture.js'

const managerMod = await importDist('core/git/git-worktree-manager.js')
const diffMod = await importDist('core/git/git-worktree-diff.js')
const mergeMod = await importDist('core/git/git-worktree-merge-queue.js')
const repo = makeGitFixture('integration-primary')
process.env.SKS_WORKTREE_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'sks-wt-integration-'))
const allocation = await managerMod.allocateWorkerWorktree({ repoRoot: repo, missionId: 'M-integrate', workerId: 'worker-1', slotId: 'slot-001' })
fs.writeFileSync(path.join(allocation.worktree_path, 'a.txt'), 'alpha\nintegrated\n')
const diff = await diffMod.exportGitWorktreeDiff({ mainRepoRoot: repo, worktreePath: allocation.worktree_path, missionId: 'M-integrate', workerId: 'worker-1' })
const integrationPath = fs.mkdtempSync(path.join(os.tmpdir(), 'sks-integration-'))
fs.rmSync(integrationPath, { recursive: true, force: true })
const integration = await managerMod.allocateWorkerWorktree({ repoRoot: repo, missionId: 'M-integrate', workerId: 'integration', slotId: 'integration' })
const report = await mergeMod.applyGitWorktreeMergeQueue({ integrationWorktreePath: integration.worktree_path, diffs: [diff] })
const mainReport = await mergeMod.applyGitWorktreeMergeQueue({ integrationWorktreePath: repo, diffs: [diff] })
const mainContent = fs.readFileSync(path.join(repo, 'a.txt'), 'utf8')
assertGate(report.ok === true && report.applied_count === 1 && mainReport.ok === true && mainReport.applied_count === 1 && mainContent.includes('integrated'), 'git-worktree-diff must prevalidate in integration worktree and apply to main repo', { report, mainReport, mainContent })
emitGate('git:worktree-integration-primary', { applied_count: report.applied_count, main_applied_count: mainReport.applied_count })
