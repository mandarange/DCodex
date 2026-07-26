#!/usr/bin/env node
// @ts-nocheck
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { assertGate, emitGate, importDist } from './gate-lib.js'

const research = await importDist('core/research.js')
const workGraph = await importDist('core/research/research-work-graph.js')
const cycleRunner = await importDist('core/research/research-cycle-runner.js')
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sks-research-blueprint-'))
const plan = await research.writeResearchPlan(dir, 'blueprint densifier blackbox', { missionId: 'M-BLUEPRINT' })
const graph = workGraph.buildResearchWorkGraph(plan)
await cycleRunner.runResearchCycle({ root: process.cwd(), dir, plan, graph, cycle: 1, backend: 'mock', timeoutMs: 120000, maxParallelStages: 4, mock: true })
const blueprint = JSON.parse(fs.readFileSync(path.join(dir, 'implementation-blueprint.json'), 'utf8'))

assertGate(
  blueprint.repository_aware === true || (blueprint.domain_research === true && blueprint.handoff_route === 'research_validation'),
  'blueprint must preserve either a repository-aware implementation boundary or an explicit domain-research validation boundary',
  blueprint
)
assertGate((blueprint.existing_files || []).length > 0, 'blueprint must list concrete existing files', blueprint)
assertGate((blueprint.sections || []).length >= 8, 'blueprint must keep required sections', blueprint)
assertGate((blueprint.test_commands || []).some((cmd) => /^(?:procedure:|npm |node |cargo )/.test(String(cmd))), 'blueprint must include concrete verification commands or procedures', blueprint)
assertGate(fs.existsSync(path.join(dir, 'naruto-handoff-goal.md')), 'Naruto handoff goal must exist')

emitGate('research:blueprint-densifier', { dir, sections: blueprint.sections.length, files: blueprint.existing_files.length })
