import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  readReleaseGateCacheRecord,
  releaseGateCacheFile,
  releaseGateCacheKey,
  releaseGateProofBankFile,
  writeReleaseGateCacheHit
} from '../../dist/core/release/release-gate-cache-v2.js'

function fixtureRoot(version) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sks-cache-vn-'))
  fs.mkdirSync(path.join(root, 'src/core'), { recursive: true })
  fs.mkdirSync(path.join(root, 'src/bin'), { recursive: true })
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'fixture', version }))
  fs.writeFileSync(path.join(root, 'package-lock.json'), JSON.stringify({ name: 'fixture', version, packages: { '': { version } } }))
  fs.writeFileSync(path.join(root, 'release-gates.v2.json'), JSON.stringify({ schema: 'sks.release-gates.v2', gates: [] }))
  fs.writeFileSync(path.join(root, 'src/core/version.ts'), `export const PACKAGE_VERSION = '${version}';\n`)
  fs.writeFileSync(path.join(root, 'src/core/fsx.ts'), `export const PACKAGE_VERSION = '${version}';\nexport const OTHER = 1;\n`)
  fs.writeFileSync(path.join(root, 'src/bin/sks.ts'), `const FAST_PACKAGE_VERSION = '${version}';\n`)
  fs.writeFileSync(path.join(root, 'src/core/behavior.ts'), 'export const behavior = () => 42\n')
  return root
}

function bump(root, from, to) {
  for (const rel of ['package.json', 'package-lock.json', 'src/core/version.ts', 'src/core/fsx.ts', 'src/bin/sks.ts']) {
    const file = path.join(root, rel)
    fs.writeFileSync(file, fs.readFileSync(file, 'utf8').split(from).join(to))
  }
}

const gate = {
  id: 'fixture:behavior-gate',
  command: 'node fixture',
  deps: [],
  resource: ['cpu-light'],
  side_effect: 'hermetic',
  timeout_ms: 1000,
  output_contract: 'sks.gate-result.v2',
  cache: { enabled: true, inputs: ['package.json', 'src/**'] },
  isolation: { home: 'temp', codex_home: 'temp', report_dir: 'per-gate' },
  preset: ['release']
}

test('a pure version bump does not invalidate behavior gate cache keys', () => {
  delete process.env.SKS_RELEASE_CACHE_VERSION_SENSITIVE
  const root = fixtureRoot('1.0.0')
  const before = releaseGateCacheKey(root, gate)
  bump(root, '1.0.0', '1.0.1')
  const after = releaseGateCacheKey(root, gate)
  assert.equal(before, after, 'version-only bump must keep the cache key stable')
})

test('behavior changes still invalidate the cache key', () => {
  delete process.env.SKS_RELEASE_CACHE_VERSION_SENSITIVE
  const root = fixtureRoot('1.0.0')
  const before = releaseGateCacheKey(root, gate)
  fs.writeFileSync(path.join(root, 'src/core/behavior.ts'), 'export const behavior = () => 43\n')
  const afterBehavior = releaseGateCacheKey(root, gate)
  assert.notEqual(before, afterBehavior, 'src behavior change must change the key')
  // non-version content change inside a version-neutral file must also invalidate
  const fsx = path.join(root, 'src/core/fsx.ts')
  fs.writeFileSync(fsx, fs.readFileSync(fsx, 'utf8').replace('OTHER = 1', 'OTHER = 2'))
  const afterNeutralFileEdit = releaseGateCacheKey(root, gate)
  assert.notEqual(afterBehavior, afterNeutralFileEdit, 'non-version edits in version-neutral files must change the key')
})

test('SKS_RELEASE_CACHE_VERSION_SENSITIVE=1 restores version-sensitive hashing', () => {
  process.env.SKS_RELEASE_CACHE_VERSION_SENSITIVE = '1'
  try {
    const root = fixtureRoot('1.0.0')
    const before = releaseGateCacheKey(root, gate)
    bump(root, '1.0.0', '1.0.1')
    const after = releaseGateCacheKey(root, gate)
    assert.notEqual(before, after)
  } finally {
    delete process.env.SKS_RELEASE_CACHE_VERSION_SENSITIVE
  }
})

test('gates without declared inputs stay conservatively version-sensitive', () => {
  delete process.env.SKS_RELEASE_CACHE_VERSION_SENSITIVE
  const root = fixtureRoot('1.0.0')
  const inputless = { ...gate, id: 'fixture:no-inputs', cache: { enabled: true, inputs: [] } }
  const before = releaseGateCacheKey(root, inputless)
  bump(root, '1.0.0', '1.0.1')
  const after = releaseGateCacheKey(root, inputless)
  assert.notEqual(before, after, 'input-less gates must fall back to global digests')
})

test('successful gate proof is mirrored into the proof bank cache', () => {
  const root = fixtureRoot('1.0.0')
  writeReleaseGateCacheHit(root, gate, 4321)
  assert.equal(fs.existsSync(releaseGateCacheFile(root)), true)
  assert.equal(fs.existsSync(releaseGateProofBankFile(root)), true)

  fs.rmSync(releaseGateCacheFile(root), { force: true })
  const hit = readReleaseGateCacheRecord(root, gate)
  assert.equal(hit?.ok, true)
  assert.equal(hit?.gate_id, gate.id)
  assert.equal(hit?.duration_ms, 4321)
})
