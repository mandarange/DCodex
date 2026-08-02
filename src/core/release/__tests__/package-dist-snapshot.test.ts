import test from 'node:test'
import assert from 'node:assert/strict'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { packageDistSnapshot, packageFilesSnapshot } from '../package-dist-snapshot.js'

test('package snapshots include brace-reincluded runtime scripts in release authorization', async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'sks-package-snapshot-'))
  t.after(() => fsp.rm(root, { recursive: true, force: true }))
  const pkg = {
    files: [
      'dist',
      '!dist/scripts/**',
      'dist/scripts/{required-a.js,required-b.js}'
    ]
  }
  await write(root, 'dist/core/runtime.js', 'runtime\n')
  await write(root, 'dist/scripts/required-a.js', 'required-a-v1\n')
  await write(root, 'dist/scripts/required-b.js', 'required-b\n')
  await write(root, 'dist/scripts/excluded.js', 'excluded-v1\n')

  const beforeDist = packageDistSnapshot(root, pkg)
  const beforePackage = packageFilesSnapshot(root, pkg)
  assert.equal(beforeDist.file_count, 3)
  assert.equal(beforePackage.file_count, 3)

  await write(root, 'dist/scripts/required-a.js', 'required-a-v2\n')
  const requiredChangedDist = packageDistSnapshot(root, pkg)
  const requiredChangedPackage = packageFilesSnapshot(root, pkg)
  assert.notEqual(requiredChangedDist.digest, beforeDist.digest)
  assert.notEqual(requiredChangedPackage.digest, beforePackage.digest)

  await write(root, 'dist/scripts/excluded.js', 'excluded-v2\n')
  assert.equal(packageDistSnapshot(root, pkg).digest, requiredChangedDist.digest)
  assert.equal(packageFilesSnapshot(root, pkg).digest, requiredChangedPackage.digest)
})

async function write(root: string, relative: string, value: string): Promise<void> {
  const file = path.join(root, relative)
  await fsp.mkdir(path.dirname(file), { recursive: true })
  await fsp.writeFile(file, value)
}
