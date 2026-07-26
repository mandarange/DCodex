#!/usr/bin/env node
// @ts-nocheck
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { assertGate, emitGate, importDist } from './gate-lib.js'
import { makeGitFixture } from './lib/git-worktree-fixture.js'

const managerMod = await importDist('core/git/git-worktree-manager.js')
const cleanupMod = await importDist('core/git/git-worktree-cleanup.js')
const repo = makeGitFixture('dirty-lock')
process.env.SKS_WORKTREE_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'sks-wt-lock-'))
const allocation = await managerMod.allocateWorkerWorktree({ repoRoot: repo, missionId: 'M-lock', workerId: 'worker-1', slotId: 'slot-001' })
fs.writeFileSync(path.join(allocation.worktree_path, 'a.txt'), 'dirty\n')
const cleanup = await cleanupMod.cleanupGitWorktree({ repoRoot: repo, worktreePath: allocation.worktree_path, branch: allocation.branch })
assertGate(cleanup.action === 'retained_dirty' && cleanup.git_locked === true, 'dirty retained worktree must be git locked', cleanup)
emitGate('git:worktree-dirty-lock', { git_locked: cleanup.git_locked, unlock_command: cleanup.unlock_command })
