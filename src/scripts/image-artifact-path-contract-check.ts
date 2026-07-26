#!/usr/bin/env node
// @ts-nocheck
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { assertGate, emitGate, importDist } from './gate-lib.js'
const mod = await importDist('core/image/image-artifact-path-contract.js')
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sks-image-contract-'))
const png = path.join(root, 'fixture.png')
await fs.writeFile(png, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgwJ/lp8S2wAAAABJRU5ErkJggg==', 'base64'))
const result = await mod.writeImageArtifactPathContract(root, { missionId: 'M-image', images: [{ id: 'fixture', kind: 'generated_image', filePath: png }] })
assertGate(result.contract.images[0].exists === true && result.contract.images[0].model_visible_path === png && result.contract.blockers.length === 0, 'image artifact path contract must expose real saved model-visible paths', result.contract)
emitGate('image:artifact-path-contract', { image_count: result.contract.images.length })
