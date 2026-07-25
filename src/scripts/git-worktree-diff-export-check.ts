#!/usr/bin/env node
// @ts-nocheck
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { assertGate, emitGate, importDist } from './gate-lib.js'
import { makeGitFixture, run } from './lib/git-worktree-fixture.js'

const managerMod = await importDist('core/git/git-worktree-manager.js')
const diffMod = await importDist('core/git/git-worktree-diff.js')
const envelopeMod = await importDist('core/git/git-worktree-patch-envelope.js')
const schemaMod = await importDist('core/agents/agent-patch-schema.js')
const cleanupMod = await importDist('core/git/git-worktree-cleanup.js')
const repo = makeGitFixture('worktree-diff')
process.env.SKS_WORKTREE_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'sks-wt-diff-'))

const allocation = await managerMod.allocateWorkerWorktree({ repoRoot: repo, missionId: 'M-diff', workerId: 'worker-1', slotId: 'slot-001' })
fs.writeFileSync(path.join(allocation.worktree_path, 'a.txt'), 'alpha\nchanged\n')
const diff = await diffMod.exportGitWorktreeDiff({
  mainRepoRoot: repo,
  worktreePath: allocation.worktree_path,
  missionId: 'M-diff',
  workerId: 'worker-1'
})
const envelope = envelopeMod.buildGitWorktreePatchEnvelope({
  diff,
  agentId: 'agent-1',
  sessionId: 'session-1',
  slotId: 'slot-001',
  generationIndex: 1
})
const validation = schemaMod.validateAgentPatchEnvelope(schemaMod.normalizeAgentPatchEnvelope(envelope))

assertGate(diff.ok === true && diff.clean === false, 'diff export must detect changed worktree', diff)
assertGate(diff.changed_files.includes('a.txt'), 'diff export must include changed file', diff)
assertGate(/index [0-9a-f]{40}\.\.[0-9a-f]{40}/.test(diff.diff), 'diff export must use full-index diff hashes', { diff: diff.diff })
assertGate(envelope.source === 'git-worktree-diff' && validation.ok === true, 'git worktree diff patch envelope must validate', { envelope, validation })
assertGate(run('git', ['status', '--porcelain=v1'], repo).trim() === '', 'main repo must stay clean after diff export')

run('git', ['checkout', '--', 'a.txt'], allocation.worktree_path)
await cleanupMod.cleanupGitWorktree({ repoRoot: repo, worktreePath: allocation.worktree_path, branch: allocation.branch, deleteBranch: true })

emitGate('git:worktree-diff-export', {
  changed_files: diff.changed_files,
  diff_bytes: diff.diff_bytes,
  envelope_source: envelope.source
})
