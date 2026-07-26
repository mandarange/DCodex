#!/usr/bin/env node
// @ts-nocheck
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { assertGate, emitGate, importDist } from './gate-lib.js'
process.env.SKS_CODEX_0138_FAKE = '1'
const mod = await importDist('core/codex-control/codex-0138-capability.js')
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sks-codex-0138-cap-'))
const result = await mod.writeCodex0138CapabilityArtifacts(root, { missionId: 'M-fixture' })
const rootArtifact = JSON.parse(await fs.readFile(result.root_artifact, 'utf8'))
const missionArtifact = JSON.parse(await fs.readFile(result.mission_artifact, 'utf8'))
assertGate(rootArtifact.schema === 'sks.codex-0138-capability.v1' && missionArtifact.ok === true, 'capability artifacts must be written at root and mission scope', result)
emitGate('codex:0138-capability-artifact', { root_artifact: path.basename(result.root_artifact), mission_artifact: path.basename(result.mission_artifact) })
