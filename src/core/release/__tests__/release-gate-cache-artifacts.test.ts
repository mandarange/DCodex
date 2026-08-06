import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { currentNpmPackInputDigest, readCurrentNpmPackProof, writeNpmPackProof } from '../npm-pack-proof.js'
import { readReleaseGateCacheRecord, writeReleaseGateCacheHit } from '../release-gate-cache-v2.js'
import type { ReleaseGateNode } from '../release-gate-node.js'

test('packlist cache hits require current proof and related reports', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sks-pack-cache-artifacts-'))
  const gate: ReleaseGateNode = {
    id: 'publish:packlist-performance',
    command: 'node packlist-performance-check.js',
    deps: [],
    resource: ['cpu-light'],
    side_effect: 'hermetic',
    timeout_ms: 1_000,
    cache: { enabled: true, inputs: ['package.json', 'package-lock.json', 'dist/**'] },
    isolation: { home: 'temp', codex_home: 'temp', report_dir: 'per-gate' },
    preset: ['release'],
    output_contract: 'sks.gate-result.v2'
  }
  const info = {
    entryCount: 2,
    size: 120,
    unpackedSize: 240,
    files: [{ path: 'package.json' }, { path: 'dist/index.js' }]
  }

  try {
    fs.mkdirSync(path.join(root, 'dist'), { recursive: true })
    fs.writeFileSync(path.join(root, 'package.json'), '{"name":"fixture","version":"1.0.0","files":["dist"]}\n')
    fs.writeFileSync(path.join(root, 'package-lock.json'), '{"name":"fixture","version":"1.0.0","packages":{"":{"version":"1.0.0"}}}\n')
    fs.writeFileSync(path.join(root, 'release-gates.v2.json'), '{"schema":"sks.release-gates.v2","gates":[]}\n')
    fs.writeFileSync(path.join(root, 'dist', 'index.js'), 'export const ready = true\n')
    writePackArtifacts(root, info)
    writeReleaseGateCacheHit(root, gate, 25)
    assert.equal(readReleaseGateCacheRecord(root, gate)?.duration_ms, 25)

    fs.rmSync(path.join(root, '.sneakoscope', 'reports', 'npm-pack-proof.json'))
    assert.equal(readReleaseGateCacheRecord(root, gate), null, 'missing npm pack proof must force gate execution')

    writePackArtifacts(root, info)
    fs.writeFileSync(path.join(root, '.sneakoscope', 'reports', 'packlist-performance.json'), '{"schema":"broken"}\n')
    assert.equal(readReleaseGateCacheRecord(root, gate), null, 'invalid related report must force gate execution')

    writePackArtifacts(root, info)
    const packageGate = { ...gate, id: 'package:published-contract', command: 'node package-published-contract-check.js' }
    writeReleaseGateCacheHit(root, packageGate, 10)
    assert.equal(readReleaseGateCacheRecord(root, packageGate)?.duration_ms, 10)
    const surfacePath = path.join(root, '.sneakoscope', 'reports', 'package-surface-budget.json')
    const surface = JSON.parse(fs.readFileSync(surfacePath, 'utf8'))
    surface.pack_proof_id = 'tampered'
    fs.writeFileSync(surfacePath, `${JSON.stringify(surface)}\n`)
    assert.equal(readReleaseGateCacheRecord(root, packageGate), null, 'dependent package gate must share the exact pack proof id')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('npm pack input digest ignores in-flight atomic temp files', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sks-pack-digest-atomic-temp-'))
  try {
    fs.mkdirSync(path.join(root, 'dist'), { recursive: true })
    fs.writeFileSync(path.join(root, 'package.json'), '{"name":"fixture","version":"1.0.0","files":["dist"]}\n')
    fs.writeFileSync(path.join(root, 'dist', 'index.js'), 'export const ready = true\n')
    const before = currentNpmPackInputDigest(root)
    const atomicTemp = path.join(root, 'dist', 'release-proof-truth.json.12345.a1b2c3.tmp')
    fs.writeFileSync(atomicTemp, '{"partial":true}\n')
    assert.equal(currentNpmPackInputDigest(root), before)

    assert.throws(() => writeNpmPackProof(root, {
      entryCount: 3,
      size: 140,
      unpackedSize: 280,
      files: [{ path: 'package.json' }, { path: 'dist/index.js' }, { path: 'dist/release-proof-truth.json.12345.a1b2c3.tmp' }]
    }, 25), /npm_pack_info_contains_atomic_temp/)

    fs.rmSync(atomicTemp)
    const proof = writeNpmPackProof(root, {
      entryCount: 2,
      size: 120,
      unpackedSize: 240,
      files: [{ path: 'package.json' }, { path: 'dist/index.js' }]
    }, 25)
    proof.info.files.push({ path: 'dist/release-proof-truth.json.12345.a1b2c3.tmp' })
    fs.writeFileSync(path.join(root, '.sneakoscope', 'reports', 'npm-pack-proof.json'), `${JSON.stringify(proof)}\n`)
    assert.ok(readCurrentNpmPackProof(root).blockers.includes('npm_pack_proof_atomic_temp_present'))

    fs.writeFileSync(path.join(root, 'dist', 'customer-data.12345.production.tmp'), 'customer bytes\n')
    assert.notEqual(currentNpmPackInputDigest(root), before, 'similar customer files outside the exact SKS atomic suffix must remain digest inputs')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('npm pack proof ignores files excluded from the recorded pack surface', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sks-pack-digest-excluded-'))
  try {
    fs.mkdirSync(path.join(root, 'dist'), { recursive: true })
    fs.writeFileSync(path.join(root, 'package.json'), '{"name":"fixture","version":"1.0.0","files":["dist","!dist/*.json"]}\n')
    fs.writeFileSync(path.join(root, 'dist', 'index.js'), 'export const ready = true\n')
    writeNpmPackProof(root, {
      entryCount: 2,
      size: 120,
      unpackedSize: 240,
      files: [{ path: 'package.json' }, { path: 'dist/index.js' }]
    }, 25)

    fs.writeFileSync(path.join(root, 'dist', 'release-proof-truth.json'), '{"generated_at":"later"}\n')
    assert.equal(readCurrentNpmPackProof(root).ok, true, 'excluded dist JSON must not stale the npm pack proof')

    fs.writeFileSync(path.join(root, 'dist', 'index.js'), 'export const ready = false\n')
    assert.ok(readCurrentNpmPackProof(root).blockers.includes('npm_pack_proof_stale'), 'included package bytes must still stale the proof')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

function writePackArtifacts(root: string, info: Record<string, any>) {
  const proof = writeNpmPackProof(root, info, 25)
  const reports = path.join(root, '.sneakoscope', 'reports')
  fs.writeFileSync(path.join(reports, 'packlist-performance.json'), `${JSON.stringify({
    schema: 'sks.packlist-performance.v1',
    ok: true,
    entryCount: info.entryCount,
    size: info.size,
    unpackedSize: info.unpackedSize,
    pack_proof_id: proof.proof_id,
    pack_info_sha256: proof.info_digest,
    pack_file_list_sha256: proof.file_list_digest,
    runtime_required_missing: [],
    forbidden: [],
    blockers: []
  })}\n`)
  fs.writeFileSync(path.join(reports, 'package-surface-budget.json'), `${JSON.stringify({
    schema: 'sks.package-surface-budget.v1',
    ok: true,
    actual_tarball_bytes: info.size,
    actual_file_count: info.entryCount,
    pack_proof_id: proof.proof_id,
    pack_info_sha256: proof.info_digest,
    pack_file_list_sha256: proof.file_list_digest,
    forbidden_findings: [],
    blockers: []
  })}\n`)
}
