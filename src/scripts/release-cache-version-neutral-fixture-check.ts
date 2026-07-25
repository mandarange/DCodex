#!/usr/bin/env node
// @ts-nocheck
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { releaseGateCacheKey } from '../core/release/release-gate-cache-v2.js'
import { assertGate, emitGate } from './gate-lib.js'

const gate = {
  id: 'fixture:release-cache',
  command: 'node fixture.js',
  deps: [],
  resource: ['cpu-light'],
  side_effect: 'hermetic',
  timeout_ms: 1000,
  cache: { enabled: true, inputs: ['package.json', 'package-lock.json', 'src/**', 'dist/build-manifest.json'] },
  isolation: { home: 'temp', codex_home: 'temp', report_dir: 'per-gate' },
  preset: ['release']
}

const fixtures = [
  ['package version only', (f) => f.pkg.version = '3.0.2', true],
  ['package script changes', (f) => f.pkg.scripts.test = 'node changed.js', false],
  ['package dependency changes', (f) => f.pkg.dependencies.left = '2.0.0', false],
  ['package files changes', (f) => f.pkg.files.push('extra'), false],
  ['package-lock root version only', (f) => { f.lock.version = '3.0.2'; f.lock.packages[''].version = '3.0.2' }, true],
  ['package-lock dependency version changes', (f) => f.lock.packages['node_modules/left'].version = '2.0.0', false],
  ['version.ts const only', (f) => f.versionTs = "export const PACKAGE_VERSION = '3.0.2';\n", true],
  ['version.ts logic change', (f) => f.versionTs += 'export const EXTRA = true;\n', false],
  ['sks.ts fast version only', (f) => f.sksTs = "const FAST_PACKAGE_VERSION = '3.0.2';\n", true],
  ['sks.ts CLI logic change', (f) => f.sksTs += 'console.log(\"changed\");\n', false],
  ['build manifest version only', (f) => { f.manifest.version = '3.0.2'; f.manifest.package_version = '3.0.2' }, true],
  ['build manifest artifact hash change', (f) => f.manifest.files['dist/bin/sks.js'] = 'hash-b', false]
]

for (const [name, mutate, shouldMatch] of fixtures) {
  const beforeRoot = await writeFixture()
  const afterRoot = await writeFixture(mutate)
  const beforeKey = releaseGateCacheKey(beforeRoot, gate)
  const afterKey = releaseGateCacheKey(afterRoot, gate)
  assertGate((beforeKey === afterKey) === shouldMatch, `release cache key fixture mismatch: ${name}`, { name, shouldMatch, beforeKey, afterKey })
}

emitGate('release:cache-version-neutral-fixtures', { fixtures: fixtures.length })

async function writeFixture(mutate) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sks-release-cache-'))
  const f = {
    pkg: { name: 'sneakoscope', version: '3.0.0', scripts: { test: 'node test.js' }, dependencies: { left: '1.0.0' }, files: ['dist'] },
    lock: { name: 'sneakoscope', version: '3.0.0', lockfileVersion: 3, packages: { '': { name: 'sneakoscope', version: '3.0.0', dependencies: { left: '1.0.0' } }, 'node_modules/left': { version: '1.0.0' } } },
    versionTs: "export const PACKAGE_VERSION = '3.0.0';\n",
    fsxTs: "export const PACKAGE_VERSION = '3.0.0';\n",
    sksTs: "const FAST_PACKAGE_VERSION = '3.0.0';\n",
    manifest: { version: '3.0.0', package_version: '3.0.0', files: { 'dist/bin/sks.js': 'hash-a' } }
  }
  if (mutate) mutate(f)
  await fs.mkdir(path.join(root, 'src/core'), { recursive: true })
  await fs.mkdir(path.join(root, 'src/bin'), { recursive: true })
  await fs.mkdir(path.join(root, 'dist'), { recursive: true })
  await fs.writeFile(path.join(root, 'package.json'), JSON.stringify(f.pkg, null, 2))
  await fs.writeFile(path.join(root, 'package-lock.json'), JSON.stringify(f.lock, null, 2))
  await fs.writeFile(path.join(root, 'release-gates.v2.json'), JSON.stringify({ schema: 'sks.release-gates.v2', gates: [gate] }, null, 2))
  await fs.writeFile(path.join(root, 'src/core/version.ts'), f.versionTs)
  await fs.writeFile(path.join(root, 'src/core/fsx.ts'), f.fsxTs)
  await fs.writeFile(path.join(root, 'src/bin/sks.ts'), f.sksTs)
  await fs.writeFile(path.join(root, 'dist/build-manifest.json'), JSON.stringify(f.manifest, null, 2))
  return root
}
