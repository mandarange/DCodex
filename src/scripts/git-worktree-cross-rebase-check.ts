#!/usr/bin/env node
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { assertGate, emitGate } from './gate-lib.js'
import { crossRebaseIdleWorktrees } from '../core/git/git-worktree-cross-rebase.js'
import { runGitCommand, gitOutputLine } from '../core/git/git-worktree-runner.js'

const suiteRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sks-worktree-cross-rebase-'))
const root = path.join(suiteRoot, 'repo')
fs.mkdirSync(root, { recursive: true })
await runGitCommand(root, ['init'])
await runGitCommand(root, ['config', 'user.email', 'sks@example.test'])
await runGitCommand(root, ['config', 'user.name', 'SKS Test'])
fs.writeFileSync(path.join(root, 'base.txt'), 'base\n')
await runGitCommand(root, ['add', 'base.txt'])
await runGitCommand(root, ['commit', '-m', 'base'])
const workerPath = path.join(suiteRoot, 'worker')
const dirtyWorkerPath = path.join(suiteRoot, 'worker-dirty')
const runningWorkerPath = path.join(suiteRoot, 'worker-running')
await runGitCommand(root, ['worktree', 'add', workerPath, 'HEAD'])
await runGitCommand(root, ['worktree', 'add', dirtyWorkerPath, 'HEAD'])
await runGitCommand(root, ['worktree', 'add', runningWorkerPath, 'HEAD'])
fs.writeFileSync(path.join(dirtyWorkerPath, 'dirty.txt'), 'dirty\n')
fs.writeFileSync(path.join(root, 'integration.txt'), 'integration\n')
await runGitCommand(root, ['add', 'integration.txt'])
await runGitCommand(root, ['commit', '-m', 'integration'])
const head = gitOutputLine(await runGitCommand(root, ['rev-parse', 'HEAD']))
const report = await crossRebaseIdleWorktrees({
  integrationHead: head,
  workers: [
    { worker_id: 'W1', worktree_path: workerPath, state: 'idle' },
    { worker_id: 'W-dirty', worktree_path: dirtyWorkerPath, state: 'idle' },
    { worker_id: 'W-running', worktree_path: runningWorkerPath, state: 'running' }
  ]
})
assertGate(report.ok && report.applied_count === 1, 'Idle worktrees must cross-rebase to the integration head', report)
assertGate(report.skipped_count === 2, 'Dirty and running worktrees must be skipped during cross-rebase', report)
assertGate(report.records.some((row) => row.worker_id === 'W-dirty' && row.status === 'skipped' && row.reason === 'dirty_worktree_skipped'), 'Dirty worktree must skip cross-rebase', report)
assertGate(report.records.some((row) => row.worker_id === 'W-running' && row.status === 'skipped' && row.reason === 'worker_not_idle'), 'Running worktree must skip cross-rebase', report)
emitGate('git:worktree-cross-rebase', report)
