#!/usr/bin/env node
// @ts-nocheck
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { assertGate, emitGate, importDist } from './gate-lib.js'
const mod = await importDist('core/image/image-artifact-registry.js')
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sks-image-registry-'))
const png = path.join(root, 'fixture.png')
await fs.writeFile(png, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgwJ/lp8S2wAAAABJRU5ErkJggg==', 'base64'))
const contract = await mod.registerImageArtifact(root, { missionId: 'M-image', id: 'img-1', kind: 'generated_image', filePath: png, route: '$Image-UX-Review', stage: 'fixture' })
assertGate(contract.images[0].model_visible_path === png && contract.images[0].route === '$Image-UX-Review' && contract.blockers.length === 0, 'image artifact registry must append saved model-visible paths with route/stage metadata', contract)
emitGate('image:artifact-registry')
