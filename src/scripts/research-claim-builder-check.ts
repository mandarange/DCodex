#!/usr/bin/env node
// @ts-nocheck
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { assertGate, emitGate, importDist } from './gate-lib.js'

const research = await importDist('core/research.js')
const workGraph = await importDist('core/research/research-work-graph.js')
const cycleRunner = await importDist('core/research/research-cycle-runner.js')
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sks-research-claim-builder-'))
const plan = await research.writeResearchPlan(dir, 'claim builder blackbox', { missionId: 'M-CLAIM-BUILDER' })
const graph = workGraph.buildResearchWorkGraph(plan)
await cycleRunner.runResearchCycle({ root: process.cwd(), dir, plan, graph, cycle: 1, backend: 'mock', timeoutMs: 120000, maxParallelStages: 4, mock: true })
const matrix = JSON.parse(fs.readFileSync(path.join(dir, 'claim-evidence-matrix.json'), 'utf8'))

assertGate(matrix.key_claim_ids.length >= 8, 'claim builder must produce key claims', matrix)
assertGate(matrix.triangulated_claim_count >= 6, 'claim builder must triangulate claims', matrix)
assertGate((matrix.unsupported_claims || []).length === 0, 'claim builder must not leave important claims unsupported in complete fixture', matrix)

emitGate('research:claim-builder', { dir, key_claims: matrix.key_claim_ids.length, triangulated: matrix.triangulated_claim_count })
