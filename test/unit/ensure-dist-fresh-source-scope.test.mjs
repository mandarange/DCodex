import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

test('dist freshness source snapshot includes native and config build inputs', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sks-dist-source-scope-'))
  t.after(async () => {
    delete process.env.SKS_BUILD_SOURCE_ROOT
    await fs.rm(root, { recursive: true, force: true })
  })
  await write(root, 'src/core/runtime.ts', 'export {}\n')
  await write(root, 'native/sks-menubar/App.swift', 'struct App {}\n')
  await write(root, 'config/skills-hash-ledger.v1.json', '{"schema":"fixture"}\n')
  await write(root, 'other/ignored.txt', 'ignored\n')
  process.env.SKS_BUILD_SOURCE_ROOT = root
  const moduleUrl = new URL(`../../dist/scripts/lib/ensure-dist-fresh.js?scope=${Date.now()}`, import.meta.url)
  const { sourceSnapshot } = await import(moduleUrl.href)

  const snapshot = sourceSnapshot()
  assert.deepEqual(snapshot.files, [
    'config/skills-hash-ledger.v1.json',
    'native/sks-menubar/App.swift',
    'src/core/runtime.ts'
  ])
  const before = snapshot.digest
  await write(root, 'native/sks-menubar/App.swift', 'struct App { let version = 2 }\n')
  assert.notEqual(sourceSnapshot().digest, before)
})

async function write(root, relative, value) {
  const file = path.join(root, relative)
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, value)
}
