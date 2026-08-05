import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {
  canonicalTestCorpus,
  canonicalTestFiles,
  canonicalTestProofPath,
  allCanonicalTestFiles,
  readCurrentCanonicalTestProof,
  writeCanonicalTestProof
} from '../canonical-test-proof.js'
import { releaseAuthorizationSnapshot } from '../release-authorization-snapshot.js'

test('canonical test proof validates the current package, corpus, and authorization state', async () => {
  const root = await fixtureRoot()
  try {
    const pkg = JSON.parse(await fsp.readFile(path.join(root, 'package.json'), 'utf8'))
    const startedAt = new Date(Date.now() - 25).toISOString()
    const completedAt = new Date().toISOString()
    await writeCanonicalTestProof(root, {
      started_at: startedAt,
      completed_at: completedAt,
      corpus: canonicalTestCorpus(root),
      release_authorization_snapshot: releaseAuthorizationSnapshot(root, pkg)
    })
    const result = readCurrentCanonicalTestProof(root)
    assert.equal(result.ok, true, JSON.stringify(result.blockers))
    assert.equal(result.proof?.total_tests, 3)
    assert.match(String(result.proof_sha256), /^[a-f0-9]{64}$/)
    assert.equal(result.proof_path, canonicalTestProofPath(root))
    const selected = canonicalTestFiles(root)
    assert.deepEqual(selected.compiled.map((file) => path.basename(file)), ['fixture.test.js'])
    assert.deepEqual(selected.unit.map((file) => path.basename(file)), ['regression-fixture.test.mjs', 'release-fixture.test.mjs'])
    const exhaustive = allCanonicalTestFiles(root)
    assert.deepEqual(exhaustive.compiled.map((file) => path.basename(file)), ['removed-compat.test.js', 'fixture.test.js'])
    assert.deepEqual(exhaustive.unit.map((file) => path.basename(file)), [
      'regression-fixture.test.mjs',
      'release-check-stamp.test.mjs',
      'release-fixture.test.mjs',
      'removed-feature.test.mjs'
    ])
  } finally {
    await fsp.rm(root, { recursive: true, force: true })
  }
})

test('canonical test proof rejects tampering and stale package identity', async () => {
  const root = await fixtureRoot()
  try {
    await writeProof(root)
    const file = canonicalTestProofPath(root)
    const proof = JSON.parse(await fsp.readFile(file, 'utf8'))
    proof.total_tests = 99
    proof.package_version = '0.0.0-stale'
    await fsp.writeFile(file, JSON.stringify(proof))
    const result = readCurrentCanonicalTestProof(root)
    assert.equal(result.ok, false)
    assert.ok(result.blockers.includes('canonical_test_proof_counts_invalid'))
    assert.ok(result.blockers.includes('canonical_test_proof_corpus_stale'))
    assert.ok(result.blockers.includes('canonical_test_proof_package_version_mismatch'))
  } finally {
    await fsp.rm(root, { recursive: true, force: true })
  }
})

test('canonical test proof rejects test corpus and authorization drift', async () => {
  const root = await fixtureRoot()
  try {
    await writeProof(root)
    await fsp.appendFile(path.join(root, 'test', 'unit', 'release-fixture.test.mjs'), '\n// drift\n')
    const result = readCurrentCanonicalTestProof(root)
    assert.equal(result.ok, false)
    assert.ok(result.blockers.includes('canonical_test_proof_corpus_stale'))
    assert.ok(result.blockers.includes('canonical_test_proof_authorization_stale'))
  } finally {
    await fsp.rm(root, { recursive: true, force: true })
  }
})

async function writeProof(root: string): Promise<void> {
  const pkg = JSON.parse(await fsp.readFile(path.join(root, 'package.json'), 'utf8'))
  const now = new Date().toISOString()
  await writeCanonicalTestProof(root, {
    started_at: now,
    completed_at: now,
    corpus: canonicalTestCorpus(root),
    release_authorization_snapshot: releaseAuthorizationSnapshot(root, pkg)
  })
}

async function fixtureRoot(): Promise<string> {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'sks-canonical-proof-'))
  await Promise.all([
    fsp.mkdir(path.join(root, 'dist', 'core', 'release', '__tests__'), { recursive: true }),
    fsp.mkdir(path.join(root, 'dist', 'core', 'historical', '__tests__'), { recursive: true }),
    fsp.mkdir(path.join(root, 'test', 'unit'), { recursive: true }),
    fsp.mkdir(path.join(root, 'test', 'regression'), { recursive: true }),
    fsp.mkdir(path.join(root, 'src'), { recursive: true })
  ])
  await Promise.all([
    fsp.writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'fixture', version: '1.2.3', files: ['dist', 'src', 'test'] })),
    fsp.writeFile(path.join(root, 'release-gates.v2.json'), '{}'),
    fsp.writeFile(path.join(root, 'infra-harness-gates.json'), '{}'),
    fsp.writeFile(path.join(root, 'src', 'index.ts'), 'export const value = 1\n'),
    fsp.writeFile(path.join(root, 'dist', 'core', 'release', '__tests__', 'fixture.test.js'), 'export {}\n'),
    fsp.writeFile(path.join(root, 'dist', 'core', 'historical', '__tests__', 'removed-compat.test.js'), 'export {}\n'),
    fsp.writeFile(path.join(root, 'test', 'unit', 'release-fixture.test.mjs'), 'export {}\n'),
    fsp.writeFile(path.join(root, 'test', 'unit', 'removed-feature.test.mjs'), 'export {}\n'),
    fsp.writeFile(path.join(root, 'test', 'regression', 'regression-fixture.test.mjs'), 'export {}\n'),
    fsp.writeFile(path.join(root, 'test', 'regression', 'release-check-stamp.test.mjs'), 'export {}\n')
  ])
  git(root, ['init', '-q'])
  git(root, ['config', 'user.email', 'fixture@example.invalid'])
  git(root, ['config', 'user.name', 'Fixture'])
  git(root, ['add', '.'])
  git(root, ['commit', '-qm', 'fixture'])
  return root
}

function git(root: string, args: string[]): void {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' })
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`)
}
