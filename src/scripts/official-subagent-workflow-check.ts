#!/usr/bin/env node
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { assertGate, emitGate, root } from './gate-lib.js'
import { buildOfficialSubagentPrompt } from '../core/subagents/official-subagent-prompt.js'
import {
  SUBAGENT_PARENT_SUMMARY_FILENAME,
  persistOrReuseTrustworthySubagentParentSummary,
  writeSubagentEvidence
} from '../core/subagents/subagent-evidence.js'
import { DEFAULT_NARUTO_REQUESTED_SUBAGENTS, resolveSubagentThreadBudget } from '../core/subagents/thread-budget.js'
import { runOfficialSubagentWorkflow } from '../core/subagents/official-subagent-runner.js'

const counts = [4, 8, 12, 20, 100].map((requested) => resolveSubagentThreadBudget({
  requested,
  configuredMaxThreads: requested === 20 ? 12 : undefined
}))
const implicitCount = resolveSubagentThreadBudget()
assertGate(
  implicitCount.requestedSubagents === DEFAULT_NARUTO_REQUESTED_SUBAGENTS,
  `implicit Naruto must default to ${DEFAULT_NARUTO_REQUESTED_SUBAGENTS} independent children (automatic bounded-work fan-out)`,
  implicitCount
)
assertGate(counts[0]?.requestedSubagents === 4, 'requested 4 must remain 4', counts)
assertGate(counts[1]?.requestedSubagents === 8, 'requested 8 must remain 8', counts)
assertGate(counts[2]?.requestedSubagents === 12, 'requested 12 must remain 12', counts)
assertGate(counts[3]?.requestedSubagents === 20 && counts[3]?.firstWave === 12 && counts[3]?.waveCount === 2, 'requested 20/maxThreads 12 must expose all 12 child slots and plan two waves', counts)
assertGate(counts[4]?.requestedSubagents === 100, 'requested 100 must remain within the official absolute hard frame cap of 256', counts)

const prompt = buildOfficialSubagentPrompt({
  goal: 'Review independent packages and report one parent summary.',
  slices: [],
  requestedSubagents: 12,
  maxThreads: 12,
  decompositionStatus: 'parent_required'
})
assertGate(/worker/i.test(prompt) && /expert/i.test(prompt), 'official delegation prompt must include worker and expert policy', { prompt })
assertGate(/wait|await/i.test(prompt) && /all/i.test(prompt), 'official delegation prompt must require waiting for every requested subagent', { prompt })
assertGate(/max.depth|max_depth|depth\s*1/i.test(prompt), 'official delegation prompt must keep max depth at 1', { prompt })
assertGate(/cap, never a utilization target/i.test(prompt) && /C_t = min/i.test(prompt), 'official delegation prompt must carry the dynamic capacity contract', { prompt })

const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'sks-official-subagent-gate-'))
try {
  const events = [
    { event: 'SubagentStart', agent: 'worker', thread_id: 'a1' },
    { event: 'SubagentStart', agent: 'worker', thread_id: 'a2' },
    { event: 'SubagentStart', agent: 'expert', thread_id: 'a3' },
    { event: 'SubagentStop', agent: 'worker', thread_id: 'a1' },
    { event: 'SubagentStop', agent: 'worker', thread_id: 'a2' },
    { event: 'SubagentStop', agent: 'expert', thread_id: 'a3' }
  ]
  const structuredParentSummary = {
    schema: 'sks.subagent-parent-summary.v1',
    status: 'completed',
    summary: 'All three official subagents completed and the parent integrated their findings.',
    thread_outcomes: ['a1', 'a2', 'a3'].map((thread_id) => ({ thread_id, status: 'completed', summary: `${thread_id} complete` })),
    changed_files: [],
    verification: [],
    blockers: []
  }
  const persistedParentSummary = await persistOrReuseTrustworthySubagentParentSummary(fixture, structuredParentSummary)
  const persistedParentSummaryFile = JSON.parse(fs.readFileSync(path.join(fixture, SUBAGENT_PARENT_SUMMARY_FILENAME), 'utf8'))
  assertGate(persistedParentSummaryFile.schema === 'sks.subagent-parent-summary.v1' && persistedParentSummaryFile.thread_outcomes.length === 3, 'structured parent summary must persist under the canonical artifact name', persistedParentSummaryFile)
  const reusedParentSummary = await persistOrReuseTrustworthySubagentParentSummary(fixture, 'prose retry must not replace durable structured evidence')
  assertGate(JSON.stringify(reusedParentSummary) === JSON.stringify(structuredParentSummary), 'untrusted prose must not downgrade a persisted trustworthy parent summary', { reusedParentSummary })
  const explicitFailure = 'The parent integration failed with an error and did not complete.'
  const failedParentSummary = await persistOrReuseTrustworthySubagentParentSummary(fixture, explicitFailure)
  assertGate(failedParentSummary === explicitFailure && !fs.existsSync(path.join(fixture, SUBAGENT_PARENT_SUMMARY_FILENAME)), 'explicit failure prose must invalidate persisted successful parent evidence', { failedParentSummary })
  const contradictedParentSummary = await persistOrReuseTrustworthySubagentParentSummary(fixture, structuredParentSummary, { workflowStatus: 'parent_failed' })
  assertGate(contradictedParentSummary === null && !fs.existsSync(path.join(fixture, SUBAGENT_PARENT_SUMMARY_FILENAME)), 'failed parent workflow must override and invalidate a contradictory completed summary', { contradictedParentSummary })
  const restoredParentSummary = await persistOrReuseTrustworthySubagentParentSummary(fixture, structuredParentSummary)
  const evidence = await writeSubagentEvidence(fixture, {
    requestedSubagents: 3,
    events,
    parentSummary: restoredParentSummary,
    workflowStatus: 'completed',
    preparationOnly: false
  })
  assertGate(evidence.ok === true && evidence.parent_summary_trustworthy === true, 'matched official SubagentStart/SubagentStop events plus a structured parent summary must pass', evidence)
  assertGate(evidence.started_threads === 3 && evidence.completed_threads === 3 && evidence.failed_threads === 0, 'official event counts must be normalized without PID evidence', evidence)
  assertGate(Array.isArray(evidence.event_sources) && evidence.event_sources.includes('SubagentStart') && evidence.event_sources.includes('SubagentStop'), 'official hook event sources must be retained', evidence)

  const proseOnly = await writeSubagentEvidence(fixture, {
    requestedSubagents: 3,
    events,
    parentSummary: 'All subagents stopped successfully.',
    workflowStatus: 'completed',
    preparationOnly: false
  })
  assertGate(proseOnly.ok === false && proseOnly.parent_summary_trustworthy === false && proseOnly.ambiguous_stop_thread_ids.length === 3, 'prose-only parent output must fail closed', proseOnly)

  const ambiguous = await writeSubagentEvidence(fixture, {
    requestedSubagents: 3,
    events,
    parentSummary: { ...structuredParentSummary, status: 'success' },
    workflowStatus: 'completed',
    preparationOnly: false
  })
  assertGate(ambiguous.ok === false && ambiguous.blockers.includes('parent_summary_status_ambiguous'), 'ambiguous parent status must fail closed', ambiguous)

  const blocked = await writeSubagentEvidence(fixture, {
    requestedSubagents: 3,
    events,
    parentSummary: {
      ...structuredParentSummary,
      status: 'blocked',
      summary: 'Integration is blocked on a required result.',
      thread_outcomes: structuredParentSummary.thread_outcomes.map((row) => ({ ...row, status: 'blocked', summary: `${row.thread_id} blocked` })),
      blockers: ['fixture_blocker']
    },
    workflowStatus: 'blocked',
    preparationOnly: false
  })
  assertGate(blocked.ok === false && blocked.parent_summary_status === 'failed', 'blocked parent outcomes must fail closed', blocked)

  const failedResultText = await writeSubagentEvidence(fixture, {
    requestedSubagents: 3,
    events: events.map((row) => row.event === 'SubagentStop' && row.thread_id === 'a2'
      ? { ...row, last_assistant_message: 'The delegated slice failed with an error.' }
      : row),
    parentSummary: structuredParentSummary,
    workflowStatus: 'completed',
    preparationOnly: false
  })
  assertGate(failedResultText.ok === false && failedResultText.failed_thread_ids.includes('a2'), 'unambiguous failed result text must override a contradictory completed claim', failedResultText)

  let nestedLaunch = false
  const appPreparationPrompt = 'Review repository code and report findings.'
  const appResult = await runOfficialSubagentWorkflow({
    root,
    goal: appPreparationPrompt,
    prompt: appPreparationPrompt,
    requestedSubagents: 3,
    maxThreads: 12,
    appSession: true,
    runProcessImpl: async () => {
      nestedLaunch = true
      throw new Error('nested launch forbidden')
    }
  })
  assertGate(nestedLaunch === false && appResult.ok === false && appResult.status === 'delegation_context_ready' && appResult.completion_evidence === false, 'in-app preparation must not launch nested codex or count as completion', appResult)

  const facade = fs.readFileSync(path.join(root, 'src', 'core', 'commands', 'naruto-command.ts'), 'utf8')
  const preparationOwner = fs.readFileSync(path.join(root, 'src', 'core', 'subagents', 'official-subagent-preparation.ts'), 'utf8')
  assertGate(!facade.includes('naruto-command-legacy') && !fs.existsSync(path.join(root, 'src', 'core', 'commands', 'naruto-command-legacy.ts')), 'legacy Naruto process swarm command must be removed and unreachable')
  assertGate(!facade.includes("from '../agents/agent-orchestrator.js'") && !facade.includes("from '../agents/native-cli-worker-runtime.js'"), 'default Naruto facade must not eager-import the process orchestrator')
  assertGate(facade.includes('prepareOfficialSubagentMission'), 'Naruto facade must delegate preparation to the shared official-subagent owner')
  assertGate(preparationOwner.includes('delegation_prompt: delegationPrompt'), 'canonical subagent plan must persist the official delegation prompt required by the stop gate')

  emitGate('naruto:official-subagent-workflow', {
    requested_counts: counts.map((row) => row.requestedSubagents),
    max_threads: counts.map((row) => row.maxThreads),
    event_evidence: {
      started: evidence.started_threads,
      completed: evidence.completed_threads,
      failed: evidence.failed_threads
    },
    app_nested_launch: nestedLaunch,
    native_process_proof_required: false
  })
} finally {
  fs.rmSync(fixture, { recursive: true, force: true })
}
