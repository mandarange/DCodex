#!/usr/bin/env node
import { assertGate, emitGate, readText } from './gate-lib.js'

const proofPolicy = readText('src/core/proof/route-proof-policy.ts')
const proofGate = readText('src/core/proof/route-proof-gate.ts')
const runtimeGates = readText('src/core/pipeline-internals/runtime-gates.ts')

assertGate(proofPolicy.includes('$Naruto') && !proofPolicy.includes("'$Agent',") && !proofPolicy.includes("'$Team',") && !proofPolicy.includes("'$ShadowClone',") && !proofPolicy.includes("'$Kagebunshin',"), 'proof policy must expose only the current Naruto route identity')
assertGate(proofGate.includes('officialSubagentsRequired') && proofGate.includes('official_subagent_evidence_missing') && proofGate.includes('official_subagent_parent_summary_missing'), 'Naruto proof gate must require official-subagent evidence and a parent summary')
assertGate(runtimeGates.includes('naruto-gate.json'), 'runtime gates must recognize naruto-gate.json')
emitGate('naruto:ssot-gate-aliases', { current_route_only: true })
