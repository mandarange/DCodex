#!/usr/bin/env node
// @ts-nocheck
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { assertGate, emitGate, importDist } from './gate-lib.js'
import { makeGitFixture } from './lib/git-worktree-fixture.js'

const managerMod = await importDist('core/git/git-worktree-manager.js')
const cleanupMod = await importDist('core/git/git-worktree-cleanup.js')
const repo = makeGitFixture('worktree-cleanup')
process.env.SKS_WORKTREE_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'sks-wt-cleanup-'))

const cleanAllocation = await managerMod.allocateWorkerWorktree({ repoRoot: repo, missionId: 'M-cleanup', workerId: 'clean', slotId: 'slot-001' })
const clean = await cleanupMod.cleanupGitWorktree({ repoRoot: repo, worktreePath: cleanAllocation.worktree_path, branch: cleanAllocation.branch, deleteBranch: true })
assertGate(clean.ok === true && clean.action === 'removed', 'clean worktree must be removed by cleanup manager', clean)
assertGate(!fs.existsSync(cleanAllocation.worktree_path), 'removed clean worktree path should be gone')

const dirtyAllocation = await managerMod.allocateWorkerWorktree({ repoRoot: repo, missionId: 'M-cleanup', workerId: 'dirty', slotId: 'slot-002' })
fs.writeFileSync(path.join(dirtyAllocation.worktree_path, 'a.txt'), 'dirty\n')
const dirty = await cleanupMod.cleanupGitWorktree({ repoRoot: repo, worktreePath: dirtyAllocation.worktree_path, branch: dirtyAllocation.branch, deleteBranch: true })
assertGate(dirty.ok === true && dirty.action === 'retained_dirty', 'dirty worktree must be retained', dirty)
assertGate(fs.existsSync(dirtyAllocation.worktree_path), 'dirty worktree path must still exist')
assertGate(dirty.retention_lock_path && fs.existsSync(dirty.retention_lock_path), 'dirty retention lock must be written outside the retained worktree', dirty)

emitGate('git:worktree-cleanup', {
  clean_action: clean.action,
  dirty_action: dirty.action,
  retention_lock_path: dirty.retention_lock_path
})
