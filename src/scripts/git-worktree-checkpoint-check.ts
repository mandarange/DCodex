#!/usr/bin/env node
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { assertGate, emitGate } from './gate-lib.js'
import { checkpointWorkerWorktree } from '../core/git/git-worktree-checkpoint.js'
import { runGitCommand } from '../core/git/git-worktree-runner.js'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sks-worktree-checkpoint-'))
await runGitCommand(root, ['init'])
await runGitCommand(root, ['config', 'user.email', 'sks@example.test'])
await runGitCommand(root, ['config', 'user.name', 'SKS Test'])
fs.writeFileSync(path.join(root, 'a.txt'), 'a\n')
await runGitCommand(root, ['add', 'a.txt'])
await runGitCommand(root, ['commit', '-m', 'base'])
fs.writeFileSync(path.join(root, 'a.txt'), 'a2\n')
fs.writeFileSync(path.join(root, 'b.txt'), 'b\n')
const report = await checkpointWorkerWorktree({ worktreePath: root, repoRoot: root, workerId: 'W1', taskId: 'T1', mode: 'auto' })
assertGate(report.ok && report.mode_applied === 'checkpoint-commit' && Boolean(report.commit_hash), 'Git worktree checkpoint must create checkpoint commits for multi-file changes', report)
emitGate('git:worktree-checkpoint', report)
