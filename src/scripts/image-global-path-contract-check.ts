#!/usr/bin/env node
// @ts-nocheck
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { assertGate, emitGate, importDist, readText } from './gate-lib.js'
const adapter = readText('src/core/image-ux-review/imagegen-adapter.ts')
const registry = readText('src/core/image/image-artifact-registry.ts')
assertGate(adapter.includes('registerImageArtifact') && registry.includes('image-artifact-path-contract.json'), 'global image generation/edit paths must register saved files in mission path contract registry')
const mod = await importDist('core/image-ux-review/imagegen-adapter.js')
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sks-image-global-root-'))
const subdir = path.join(root, 'subdir')
await fs.mkdir(path.join(root, '.git'), { recursive: true })
await fs.mkdir(subdir, { recursive: true })
const png = path.join(root, 'fixture.png')
await fs.writeFile(png, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgwJ/lp8S2wAAAABJRU5ErkJggg==', 'base64'))
const oldCwd = process.cwd()
process.chdir(subdir)
try {
  const result = await mod.generateGptImage2CalloutReview({
    mission_id: 'M-subdir',
    source_screen_id: 'screen-1',
    source_image_path: png,
    output_dir: path.join(root, 'out'),
    prompt: mod.buildCalloutPrompt('screen-1'),
    requested_fidelity: 'original',
    privacy: 'local-only'
  }, { fake: true })
  assertGate(result.ok === true, 'fixture imagegen must produce a generated image before registry root check', result)
} finally {
  process.chdir(oldCwd)
}
const projectRegistry = await fs.stat(path.join(root, '.sneakoscope', 'missions', 'M-subdir', 'image-artifact-path-contract.json')).then(() => true, () => false)
const subdirRegistry = await fs.stat(path.join(subdir, '.sneakoscope', 'missions', 'M-subdir', 'image-artifact-path-contract.json')).then(() => true, () => false)
assertGate(projectRegistry === true && subdirRegistry === false, 'image generation registry must use project root, not invocation subdirectory', { projectRegistry, subdirRegistry })
emitGate('image:global-path-contract')
