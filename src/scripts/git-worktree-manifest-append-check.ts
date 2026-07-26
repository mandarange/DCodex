#!/usr/bin/env node
// @ts-nocheck
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { assertGate, emitGate, importDist } from './gate-lib.js'
import { makeGitFixture } from './lib/git-worktree-fixture.js'

const managerMod = await importDist('core/git/git-worktree-manager.js')
const repo = makeGitFixture('worktree-manifest-append')
process.env.SKS_WORKTREE_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'sks-wt-manifest-'))
const allocations = []
for (let index = 0; index < 4; index += 1) {
  allocations.push(await managerMod.allocateWorkerWorktree({ repoRoot: repo, missionId: 'M-manifest', workerId: `worker-${index}`, slotId: `slot-${index}` }))
}
const manifest = JSON.parse(fs.readFileSync(allocations[0].manifest_path, 'utf8'))
assertGate(manifest.allocations.length >= allocations.length, 'manifest append must preserve allocations', manifest)
emitGate('git:worktree-manifest-append', { allocations: manifest.allocations.length })
