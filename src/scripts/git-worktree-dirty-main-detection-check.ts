#!/usr/bin/env node
// @ts-nocheck
import fs from 'node:fs'
import path from 'node:path'
import { assertGate, emitGate, importDist } from './gate-lib.js'
import { makeGitFixture } from './lib/git-worktree-fixture.js'

const detectionMod = await importDist('core/git/git-repo-detection.js')
const repo = makeGitFixture('dirty-main-detection')
fs.writeFileSync(path.join(repo, 'dirty.txt'), 'dirty\n')
const detection = await detectionMod.detectGitRepo(repo)
assertGate(detection.main_worktree_dirty === true, 'dirty main worktree must be detected', detection)
assertGate(String(detection.status_porcelain).includes('dirty.txt'), 'status_porcelain must include dirty file', detection)
emitGate('git:worktree-dirty-main-detection', { dirty: detection.main_worktree_dirty })
