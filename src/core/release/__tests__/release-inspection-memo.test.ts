import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { spawnSync } from 'node:child_process'
import {
  RELEASE_INSPECTION_MEMO_ENV,
  clearReleaseInspectionMemo,
  fileIdentity,
  inspectionKey,
  memoizeReleaseInspection,
  toolIdentity
} from '../release-inspection-memo.js'
import { tarInventory, tarPackageJson } from '../release-pack-tarball.js'

test('the inspection memo reuses a verdict only for provably identical inputs', () => {
  clearReleaseInspectionMemo()
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sks-inspection-memo-'))
  try {
    const file = path.join(root, 'input.txt')
    fs.writeFileSync(file, 'first')
    let computed = 0
    const inspect = () => memoizeReleaseInspection('test-bucket', inspectionKey(file, fileIdentity(file)), () => {
      computed += 1
      return { value: fs.readFileSync(file, 'utf8') }
    })

    assert.deepEqual(inspect(), { value: 'first' })
    assert.deepEqual(inspect(), { value: 'first' })
    assert.equal(computed, 1, 'identical bytes must not be re-inspected')

    // A caller must never be handed the memo's own object: mutating what it
    // returns cannot be allowed to rewrite a later inspection's answer.
    const returned = inspect()
    returned.value = 'tampered'
    assert.deepEqual(inspect(), { value: 'first' })

    fs.writeFileSync(file, 'second')
    assert.deepEqual(inspect(), { value: 'second' }, 'changed bytes must re-inspect')
    assert.equal(computed, 2)

    // An unaddressable input (missing file) must never be memoized at all.
    fs.rmSync(file)
    assert.equal(fileIdentity(file), null)
    assert.equal(inspectionKey(file, fileIdentity(file)), null)
    let unkeyed = 0
    for (let index = 0; index < 3; index += 1) {
      memoizeReleaseInspection('test-bucket', null, () => { unkeyed += 1 })
    }
    assert.equal(unkeyed, 3)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
    clearReleaseInspectionMemo()
  }
})

test('SKS_RELEASE_INSPECTION_MEMO=0 disables reuse without changing any verdict', () => {
  clearReleaseInspectionMemo()
  const previous = process.env[RELEASE_INSPECTION_MEMO_ENV]
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sks-inspection-memo-off-'))
  try {
    const file = path.join(root, 'input.txt')
    fs.writeFileSync(file, 'payload')
    let computed = 0
    const inspect = () => memoizeReleaseInspection('test-bucket-off', inspectionKey(file, fileIdentity(file)), () => {
      computed += 1
      return { value: 'payload' }
    })
    process.env[RELEASE_INSPECTION_MEMO_ENV] = '0'
    assert.deepEqual(inspect(), { value: 'payload' })
    assert.deepEqual(inspect(), { value: 'payload' })
    assert.equal(computed, 2, 'the kill switch must force a real inspection every time')
  } finally {
    if (previous === undefined) delete process.env[RELEASE_INSPECTION_MEMO_ENV]
    else process.env[RELEASE_INSPECTION_MEMO_ENV] = previous
    fs.rmSync(root, { recursive: true, force: true })
    clearReleaseInspectionMemo()
  }
})

test('tarball facts are addressed by archive bytes, not by archive path', () => {
  clearReleaseInspectionMemo()
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sks-inspection-memo-tar-'))
  try {
    const stage = path.join(root, 'package')
    const tarball = path.join(root, 'archive.tgz')
    fs.mkdirSync(stage)
    fs.writeFileSync(path.join(stage, 'package.json'), JSON.stringify({ name: 'fixture', version: '1.0.0' }))
    pack(root, tarball)
    assert.deepEqual(tarInventory(tarball).files, ['package/package.json'])
    assert.equal(tarPackageJson(tarball)?.version, '1.0.0')

    // Same path, different bytes: a path-addressed cache would answer with the
    // previous archive's contents and let a changed package pass as inspected.
    fs.writeFileSync(path.join(stage, 'added.txt'), 'added')
    fs.writeFileSync(path.join(stage, 'package.json'), JSON.stringify({ name: 'fixture', version: '2.0.0' }))
    fs.rmSync(tarball)
    pack(root, tarball)
    assert.deepEqual(tarInventory(tarball).files.sort(), ['package/added.txt', 'package/package.json'])
    assert.equal(tarPackageJson(tarball)?.version, '2.0.0')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
    clearReleaseInspectionMemo()
  }
})

test('a swapped tool on PATH re-inspects instead of replaying the old tool verdict', () => {
  clearReleaseInspectionMemo()
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sks-inspection-memo-tool-'))
  const priorPath = process.env.PATH
  try {
    const binA = path.join(root, 'bin-a')
    const binB = path.join(root, 'bin-b')
    for (const [dir, exitCode] of [[binA, 0], [binB, 1]] as const) {
      fs.mkdirSync(dir)
      const tool = path.join(dir, 'sks-memo-fixture-tool')
      fs.writeFileSync(tool, `#!/bin/sh\nexit ${exitCode}\n`)
      fs.chmodSync(tool, 0o755)
    }
    const inspect = () => memoizeReleaseInspection(
      'tool-swap',
      inspectionKey('fixed-input', toolIdentity('sks-memo-fixture-tool')),
      () => spawnSync('sks-memo-fixture-tool', [], { encoding: 'utf8' }).status
    )

    process.env.PATH = `${binA}${path.delimiter}${priorPath || ''}`
    assert.equal(inspect(), 0)
    // Same inputs, different tool: a memo that ignored the resolved binary
    // would report the first tool's success and let a failing check pass.
    process.env.PATH = `${binB}${path.delimiter}${priorPath || ''}`
    assert.equal(inspect(), 1)
  } finally {
    if (priorPath === undefined) delete process.env.PATH
    else process.env.PATH = priorPath
    fs.rmSync(root, { recursive: true, force: true })
    clearReleaseInspectionMemo()
  }
})

function pack(root: string, tarball: string): void {
  const result = spawnSync('tar', ['-czf', tarball, '-C', root, 'package'], { encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr || result.stdout)
}
