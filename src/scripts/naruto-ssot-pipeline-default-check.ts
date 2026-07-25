#!/usr/bin/env node
import { assertGate, emitGate, readText } from './gate-lib.js'

const runtimeCore = readText('src/core/pipeline-internals/runtime-core.ts')
const agentPlan = readText('src/core/agents/agent-plan.ts')
const routes = readText('src/core/routes.ts')

assertGate(runtimeCore.includes('prepareNaruto') && runtimeCore.includes('naruto-gate.json'), 'pipeline runtime must prepare Naruto missions and gates')
assertGate(runtimeCore.includes('prepare subagent-plan.json') && !runtimeCore.includes('clone roster') && !runtimeCore.includes('full Team artifacts'), 'pipeline next-actions must describe only official-subagent Naruto artifacts')
assertGate(agentPlan.includes('Naruto') || agentPlan.includes('naruto'), 'agent intake planning must include Naruto route')
assertGate(routes.includes('routeRequiresSubagents') && routes.includes('Naruto'), 'route defaults must require subagents for Naruto')
emitGate('naruto:ssot-pipeline-default', { pipeline_default: 'Naruto' })
