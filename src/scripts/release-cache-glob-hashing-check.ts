#!/usr/bin/env node
// @ts-nocheck
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { assertGate, emitGate } from './gate-lib.js'
import { expandGlob, releaseGateCacheKey } from '../core/release/release-gate-cache-v2.js'

delete process.env.SKS_RELEASE_GATE_CACHE_MEMOIZE

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sks-cache-glob-'))
fs.mkdirSync(path.join(tmp, 'src/core/release'), { recursive: true })
fs.writeFileSync(path.join(tmp, 'package.json'), JSON.stringify({ version: '0.0.0' }))
fs.writeFileSync(path.join(tmp, 'release-gates.v2.json'), JSON.stringify({ schema: 'sks.release-gates.v2', gates: [] }))
fs.writeFileSync(path.join(tmp, 'src/core/release/a.ts'), 'a')
const gate = {
  id: 'release:cache-glob-hashing-fixture',
  command: 'node fixture',
  deps: [],
  resource: ['cpu-light'],
  side_effect: 'hermetic',
  timeout_ms: 1000,
  output_contract: 'sks.gate-result.v2',
  cache: { enabled: true, inputs: ['src/core/release/**'] },
  isolation: { home: 'temp', codex_home: 'temp', report_dir: 'per-gate' },
  preset: ['release']
}
const before = releaseGateCacheKey(tmp, gate)
const expandedBefore = expandGlob(tmp, 'src/core/release/**')
fs.writeFileSync(path.join(tmp, 'src/core/release/b.ts'), 'b')
const afterAdd = releaseGateCacheKey(tmp, gate)
fs.writeFileSync(path.join(tmp, 'src/core/release/a.ts'), 'changed')
const afterChange = releaseGateCacheKey(tmp, gate)
const expandedAfter = expandGlob(tmp, 'src/core/release/**')
const report = {
  schema: 'sks.release-cache-glob-hashing-check.v1',
  ok: expandedBefore.length === 1 && expandedAfter.length === 2 && before !== afterAdd && afterAdd !== afterChange,
  expanded_before: expandedBefore.map((file) => path.basename(file)),
  expanded_after: expandedAfter.map((file) => path.basename(file)),
  before,
  after_add: afterAdd,
  after_change: afterChange
}
assertGate(report.ok, 'release cache key must hash recursive glob file paths and contents', report)
emitGate('release:cache-glob-hashing', report)
