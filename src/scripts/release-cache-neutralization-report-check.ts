#!/usr/bin/env node
// @ts-nocheck
import { spawnSync } from 'node:child_process'
import { assertGate, emitGate, root } from './gate-lib.js'

const result = spawnSync(process.execPath, ['dist/scripts/release-speed-summary.js'], { cwd: root, encoding: 'utf8', timeout: 30000 })
assertGate(result.status === 0, 'release speed summary script failed', { stderr: result.stderr })
const summary = JSON.parse(result.stdout)
assertGate(summary.cache_key_policy === 'version-neutral-safe-v1', 'release speed summary missing cache key policy', summary)
assertGate(Array.isArray(summary.version_neutralized_inputs), 'release speed summary missing neutralized inputs', summary)
assertGate(Array.isArray(summary.behavior_affecting_inputs), 'release speed summary missing behavior-affecting inputs', summary)
assertGate(String(summary.cache_message || '').includes('Version correctness gates still ran uncached'), 'release speed summary missing neutralization operator message', summary)
emitGate('release:cache-neutralization-report', summary)
