#!/usr/bin/env node
// @ts-nocheck
import { assertGate, emitGate, readText } from './gate-lib.js'

const source = readText('src/core/commands/research-command.ts')
const defaultIndex = source.indexOf('const cycleResult = await runResearchCycle({')

assertGate(defaultIndex > 0, 'default research run must call runResearchCycle with object input')
for (const removed of ['SKS_RESEARCH_LEGACY_CYCLE', 'legacy_final_md_loop', 'runCodexExec({', 'runNativeAgentOrchestrator']) {
  assertGate(!source.includes(removed), `legacy Research runtime token must be absent: ${removed}`)
}
assertGate(
  source.includes('REMOVED_RESEARCH_RUNTIME_FLAGS')
    && source.includes('Unsupported legacy Research runtime option:'),
  'removed Research flags must fail closed'
)
for (const removedFlag of ['--legacy-research-cycle', '--native-proof-only']) {
  assertGate(source.includes(removedFlag), `removed Research flag blocker missing: ${removedFlag}`)
}
assertGate(source.includes("source_acquisition: 'super-search'"), 'Research run must record Super Search acquisition')
assertGate(source.includes("reviewer_workflow: 'official_codex_subagent'"), 'Research run must record official subagent review')

emitGate('research:real-cycle-no-legacy-final-md', { defaultIndex, legacy_runtime_removed: true, official_subagents: true, super_search: true })
