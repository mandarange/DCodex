#!/usr/bin/env node
// @ts-nocheck
import { assertGate, emitGate, importDist } from './gate-lib.js'

const envelopeMod = await importDist('core/git/git-worktree-patch-envelope.js')
const schemaMod = await importDist('core/agents/agent-patch-schema.js')
const envelope = envelopeMod.buildGitWorktreePatchEnvelope({
  diff: { schema: 'sks.git-worktree-diff.v1', mission_id: 'M-env', worker_id: 'worker-1', main_repo_root: '.', worktree_path: '.', branch: null, base_head: null, worktree_head: null, changed_files: ['a.txt', 'b.txt'], diff_bytes: 12, diff: 'diff --git a/a.txt b/a.txt\n', clean: false },
  agentId: 'agent-1',
  sessionId: 'session-1',
  slotId: 'slot-001',
  generationIndex: 1
})
const validation = schemaMod.validateAgentPatchEnvelope(schemaMod.normalizeAgentPatchEnvelope(envelope))
assertGate(envelope.operations.length === 1 && envelope.operations[0].op === 'git_apply_patch', 'git worktree envelope must use one git_apply_patch operation', envelope)
assertGate(validation.ok === true, 'git_apply_patch envelope must validate', validation)
emitGate('git:worktree-diff-envelope', { operations: envelope.operations.length, op: envelope.operations[0].op })
