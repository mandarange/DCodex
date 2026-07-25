#!/usr/bin/env node
// @ts-nocheck
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { assertGate, emitGate, importDist } from './gate-lib.js'
const mod = await importDist('core/image/image-artifact-path-contract.js')
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sks-image-followup-'))
const png = path.join(root, 'followup.png')
await fs.writeFile(png, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgwJ/lp8S2wAAAABJRU5ErkJggg==', 'base64'))
const contract = await mod.buildImageArtifactPathContract(root, { missionId: 'M-followup', images: [{ id: 'followup', kind: 'edited_image', filePath: png }] })
assertGate(contract.images[0].followup_edit_hint.includes(png), 'follow-up edit hint must include exact saved local image path', contract.images[0])
emitGate('image:followup-edit-path')
