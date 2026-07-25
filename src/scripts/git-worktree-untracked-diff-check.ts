#!/usr/bin/env node
// @ts-nocheck
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { assertGate, emitGate, importDist } from './gate-lib.js'
import { makeGitFixture } from './lib/git-worktree-fixture.js'

const managerMod = await importDist('core/git/git-worktree-manager.js')
const diffMod = await importDist('core/git/git-worktree-diff.js')
const repo = makeGitFixture('untracked-diff')
process.env.SKS_WORKTREE_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'sks-wt-untracked-'))
const allocation = await managerMod.allocateWorkerWorktree({ repoRoot: repo, missionId: 'M-untracked', workerId: 'worker-1', slotId: 'slot-001' })
fs.writeFileSync(path.join(allocation.worktree_path, 'new-file.txt'), 'new content\n')
const diff = await diffMod.exportGitWorktreeDiff({ mainRepoRoot: repo, worktreePath: allocation.worktree_path, missionId: 'M-untracked', workerId: 'worker-1' })
assertGate(diff.changed_files.includes('new-file.txt'), 'changed files must include untracked file', diff)
assertGate(diff.diff.includes('new file mode') && diff.diff.includes('+new content'), 'git diff must include untracked file content', { diff: diff.diff })
emitGate('git:worktree-untracked-diff', { changed_files: diff.changed_files })
