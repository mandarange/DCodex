import path from 'node:path'
import { appendJsonlBounded, exists, nowIso, readJson, readText, writeJsonAtomic, writeTextAtomic } from '../fsx.js'
import { runCodexTask } from '../codex-control/codex-task-runner.js'
import type { CodexControlBackend } from '../codex-control/codex-control-plane.js'
import { buildClaimEvidenceMatrixFromSourceShards } from './research-claim-builder.js'
import { writeClaimEvidenceMatrix, validateClaimEvidenceMatrix } from './claim-evidence-matrix.js'
import { synthesizeResearchClaimEvidenceMatrix } from './research-claim-synthesizer.js'
import { defaultExperimentPlan, writeExperimentPlan } from './experiment-plan.js'
import { defaultReplicationPack, writeReplicationPack } from './replication-pack.js'
import { densifyImplementationBlueprint } from './implementation-blueprint-densifier.js'
import { renderImplementationBlueprintMarkdown } from './implementation-blueprint-markdown.js'
import { readImplementationBlueprint, validateImplementationBlueprint, writeImplementationBlueprint } from './implementation-blueprint.js'
import { writeResearchHandoffArtifacts } from './research-handoff.js'
import { runResearchFinalReviewer, runResearchStaticFinalReview } from './research-final-reviewer.js'
import { runResearchCodexSynthesisWriter, validateResearchSynthesisOutput, type ResearchSynthesisOutput } from './research-synthesis-writer.js'
import { buildResearchSourceShardPrompt, defaultResearchSourceShardOutput, researchSourceLayerById, researchSourceShardOutputSchema, validateResearchSourceShardOutput } from './research-source-shards.js'
import { linkSourceLedgerToClaimMatrix, mergeResearchSourceShards } from './research-source-ledger-merge.js'
import { writeSourceQualityReport } from './source-quality-report.js'
import { runResearchFalsification } from './research-falsification-runner.js'
import { evaluateResearchGate, researchPaperArtifactForPlan, RESEARCH_PAPER_SECTION_GROUPS } from '../research.js'
import { runResearchSuperSearchShard } from './research-super-search.js'
import {
  RESEARCH_ADVERSARIAL_PLAN_ARTIFACT,
  RESEARCH_ADVERSARIAL_REVIEW_ARTIFACT,
  RESEARCH_CONVERGENCE_GATE_ARTIFACT,
  RESEARCH_HONEST_MODE_ARTIFACT,
  RESEARCH_REVISION_LEDGER_ARTIFACT,
  runResearchAdversarialReviewLoop
} from './research-adversarial-review.js'

export type ResearchStageKind =
  | 'source_shard'
  | 'source_merge'
  | 'claim_matrix_build'
  | 'falsification'
  | 'implementation_blueprint'
  | 'experiment_plan'
  | 'synthesis'
  | 'final_review'
  | 'verification'

export type ResearchStageBackend = 'codex-sdk' | 'python-codex-sdk' | 'deterministic' | 'mock'

export interface ResearchStageResult {
  schema: 'sks.research-stage-result.v1'
  mission_id: string
  cycle: number
  stage_id: string
  stage_kind: ResearchStageKind
  status: 'passed' | 'blocked' | 'skipped' | 'failed'
  started_at: string
  completed_at: string
  input_artifacts: string[]
  output_artifacts: string[]
  backend: ResearchStageBackend
  worker_result_path?: string | null
  blockers: string[]
  metrics: Record<string, unknown>
}

export async function runResearchStage(inputOrDir: {
  root: string
  dir: string
  plan: any
  graph: any
  stage: any
  cycle: number
  backend: ResearchStageBackend
  timeoutMs: number
  cycleDeadlineMs?: number
  maxReviewCycles?: number
  maxReviewThreads?: number
  mock?: boolean
} | string, legacyStage: any = null, legacyOpts: any = {}): Promise<ResearchStageResult> {
  let input = typeof inputOrDir === 'string'
    ? {
        root: process.cwd(),
        dir: inputOrDir,
        plan: null,
        graph: null,
        stage: legacyStage,
        cycle: Number(legacyOpts.cycle || 0),
        backend: legacyOpts.mock ? 'mock' as const : 'deterministic' as const,
        timeoutMs: Number(legacyOpts.timeoutMs || 120000),
        mock: legacyOpts.mock === true
      }
    : inputOrDir
  if (Number.isFinite(Number(input.cycleDeadlineMs))) {
    input = {
      ...input,
      timeoutMs: Math.max(0, Math.min(Number(input.timeoutMs || 0), Number(input.cycleDeadlineMs) - Date.now()))
    }
  }
  const startedAt = nowIso()
  const stageKind = inferStageKind(input.stage)
  const stageId = String(input.stage?.id || `${stageKind}-${input.cycle}`)
  let result: ResearchStageResult
  if (input.timeoutMs <= 0) {
    result = baseResult(input, startedAt, stageKind, 'failed', [], ['research_cycle_timeout_exceeded'])
  } else {
    try {
      switch (stageKind) {
      case 'source_shard':
        result = await runSourceShardStage(input, startedAt)
        break
      case 'source_merge':
        result = await runSourceMergeStage(input, startedAt)
        break
      case 'claim_matrix_build':
        result = await runClaimMatrixStage(input, startedAt)
        break
      case 'falsification':
        result = await runFalsificationStage(input, startedAt)
        break
      case 'implementation_blueprint':
        result = await runImplementationBlueprintStage(input, startedAt)
        break
      case 'experiment_plan':
        result = await runExperimentPlanStage(input, startedAt)
        break
      case 'synthesis':
        result = await runSynthesisStage(input, startedAt)
        break
      case 'final_review':
        result = await runFinalReviewStage(input, startedAt)
        break
      case 'verification':
        result = await runVerificationStage(input, startedAt)
        break
      default:
        result = baseResult(input, startedAt, stageKind, 'blocked', [], [`unknown_stage_kind:${stageKind}`])
      }
    } catch (err: unknown) {
      result = baseResult(input, startedAt, stageKind, 'failed', [], [err instanceof Error ? err.message : String(err)])
    }
  }
  if (result.status === 'passed' && result.output_artifacts.length === 0) {
    result = { ...result, status: 'blocked', blockers: [...result.blockers, 'stage_output_artifacts_missing'] }
  }
  await writeJsonAtomic(path.join(input.dir, 'research', `cycle-${input.cycle}`, 'stages', `${stageId}.json`), result)
  await appendJsonlBounded(path.join(input.dir, 'events.jsonl'), {
    ts: nowIso(),
    type: 'research.stage.completed',
    cycle: input.cycle,
    stage_id: stageId,
    stage_kind: stageKind,
    status: result.status
  })
  return result
}

async function runSourceShardStage(input: StageInput, startedAt: string): Promise<ResearchStageResult> {
  const layerId = String(input.stage?.layer_id || input.stage?.source_layer_id || String(input.stage?.id || '').replace(/^source_shard_/, ''))
  const layer = researchSourceLayerById(layerId)
  const artifact = `research/cycle-${input.cycle}/source-shards/${layer.id}.json`
  if (input.mock || input.backend === 'mock' || input.backend === 'deterministic') {
    const output = defaultResearchSourceShardOutput(input.plan, layer, input.cycle)
    const validation = validateResearchSourceShardOutput(output)
    await writeJsonAtomic(path.join(input.dir, artifact), output)
    await writeTextAtomic(path.join(input.dir, 'research', `cycle-${input.cycle}`, 'source-notes', `${layer.id}.md`), `# Source shard: ${layer.label}\n\n${output.sources.map((source) => `- ${source.id}: ${source.title}`).join('\n')}\n`)
    return baseResult(input, startedAt, 'source_shard', validation.ok ? 'passed' : 'blocked', [artifact, `research/cycle-${input.cycle}/source-notes/${layer.id}.md`], validation.blockers, { layer_id: layer.id, source_count: output.sources.length, source_tool_route: researchSourceToolRoute(input.plan) })
  }
  if (layer.id !== 'local_project_evidence') {
    const output = await runResearchSuperSearchShard({
      root: input.root,
      dir: input.dir,
      plan: input.plan,
      layer,
      cycle: input.cycle,
      timeoutMs: input.timeoutMs,
      ...(input.cycleDeadlineMs === undefined ? {} : { deadlineMs: input.cycleDeadlineMs })
    })
    const validation = validateResearchSourceShardOutput(output)
    const blockers = [...new Set([...validation.blockers, ...output.blockers])]
    await writeJsonAtomic(path.join(input.dir, artifact), output)
    await writeTextAtomic(
      path.join(input.dir, 'research', `cycle-${input.cycle}`, 'source-notes', `${layer.id}.md`),
      `# Super Search source shard: ${layer.label}\n\n${output.sources.map((source) => `- ${source.id}: ${source.title} (${source.locator})`).join('\n')}\n\nBlockers: ${blockers.join(', ') || 'none'}\n`
    )
    return baseResult(
      input,
      startedAt,
      'source_shard',
      blockers.length ? 'blocked' : 'passed',
      [artifact, `research/cycle-${input.cycle}/source-notes/${layer.id}.md`, output.super_search?.proof_artifact || ''].filter(Boolean),
      blockers,
      {
        layer_id: layer.id,
        source_count: output.sources.length,
        verified_source_count: output.super_search?.verified_sources || 0,
        source_tool_route: output.super_search?.provider_independent
          ? 'super-search-provider-independent'
          : 'super-search-verified-runtime'
      }
    )
  }
  const codex = await runResearchCodexStage({
    root: input.root,
    dir: input.dir,
    plan: input.plan,
    stage: input.stage,
    prompt: buildResearchSourceShardPrompt(input.plan, layer),
    outputSchema: researchSourceShardOutputSchema,
    outputArtifact: artifact,
    backendPreference: input.backend === 'python-codex-sdk' ? ['python-codex-sdk', 'codex-sdk'] : ['codex-sdk', 'python-codex-sdk'],
    timeoutMs: input.timeoutMs,
    ...(input.cycleDeadlineMs === undefined ? {} : { deadlineMs: input.cycleDeadlineMs })
  })
  return codex
}

async function runSourceMergeStage(input: StageInput, startedAt: string): Promise<ResearchStageResult> {
  const merge = await mergeResearchSourceShards({ dir: input.dir, cycle: input.cycle, plan: input.plan })
  return baseResult(input, startedAt, 'source_merge', merge.ok ? 'passed' : 'blocked', ['source-ledger.json', 'source-quality-report.json'], merge.blockers, { ...merge })
}

async function runClaimMatrixStage(input: StageInput, startedAt: string): Promise<ResearchStageResult> {
  const sourceLedger = await readJson(path.join(input.dir, 'source-ledger.json'), null)
  const noveltyLedger = await readJson(path.join(input.dir, 'novelty-ledger.json'), null)
  const falsificationLedger = await readJson(path.join(input.dir, 'falsification-ledger.json'), null)
  const generated = input.mock || input.backend === 'mock' || input.backend === 'deterministic'
    ? {
        matrix: await buildClaimEvidenceMatrixFromSourceShards({ dir: input.dir, cycle: input.cycle, plan: input.plan, sourceLedger, noveltyLedger, falsificationLedger }),
        blockers: [] as string[],
        worker_result_path: null as string | null
      }
    : await synthesizeResearchClaimEvidenceMatrix({
        root: input.root,
        dir: input.dir,
        plan: input.plan,
        sourceLedger,
        timeoutMs: input.timeoutMs,
        ...(input.cycleDeadlineMs === undefined ? {} : { deadlineMs: input.cycleDeadlineMs }),
        backendPreference: input.backend === 'python-codex-sdk' ? ['python-codex-sdk', 'codex-sdk'] : ['codex-sdk', 'python-codex-sdk']
      })
  const matrix = generated.matrix
  await writeClaimEvidenceMatrix(input.dir, matrix)
  const linkedSourceLedger = linkSourceLedgerToClaimMatrix(sourceLedger, matrix)
  await writeJsonAtomic(path.join(input.dir, 'source-ledger.json'), linkedSourceLedger)
  await writeSourceQualityReport(input.dir, linkedSourceLedger, matrix)
  const validation = validateClaimEvidenceMatrix(matrix, linkedSourceLedger, falsificationLedger)
  const blockers = [...new Set([...(generated.blockers || []), ...validation.blockers])]
  return baseResult(input, startedAt, 'claim_matrix_build', blockers.length ? 'blocked' : 'passed', ['claim-evidence-matrix.json', 'source-ledger.json', 'source-quality-report.json'], blockers, {
    key_claims: matrix.key_claim_ids.length,
    triangulated_claims: matrix.triangulated_claim_count,
    semantic_claim_synthesis: !(input.mock || input.backend === 'mock' || input.backend === 'deterministic'),
    worker_result_path: generated.worker_result_path
  })
}

async function runFalsificationStage(input: StageInput, startedAt: string): Promise<ResearchStageResult> {
  const matrix = await readJson(path.join(input.dir, 'claim-evidence-matrix.json'), null)
  const sourceLedger = await readJson(path.join(input.dir, 'source-ledger.json'), null)
  if (!(input.mock || input.backend === 'mock' || input.backend === 'deterministic')) {
    const ledger = await runResearchFalsification({
      root: input.root,
      dir: input.dir,
      plan: input.plan,
      claimMatrix: matrix,
      sourceLedger,
      timeoutMs: input.timeoutMs,
      ...(input.cycleDeadlineMs === undefined ? {} : { deadlineMs: input.cycleDeadlineMs }),
      backendPreference: input.backend === 'python-codex-sdk' ? ['python-codex-sdk', 'codex-sdk'] : ['codex-sdk', 'python-codex-sdk']
    })
    await writeJsonAtomic(path.join(input.dir, 'falsification-ledger.json'), ledger)
    return baseResult(input, startedAt, 'falsification', ledger.blockers.length ? 'blocked' : 'passed', ['falsification-ledger.json'], ledger.blockers, {
      cases: ledger.cases.length,
      execution_class: 'real',
      worker_result_path: ledger.worker_result_path
    })
  }
  const counterIds = (Array.isArray(sourceLedger?.counterevidence_sources) ? sourceLedger.counterevidence_sources : []).map((source: any) => source.id).filter(Boolean)
  const claims = Array.isArray(matrix?.claims) ? matrix.claims : []
  const cases = claims.slice(0, 4).map((claim: any, index: number) => ({
    id: `stage-falsification-${index + 1}`,
    target_claim: claim.id,
    attack: `Stress ${claim.id} against missing layer coverage, counterevidence absence, and replication failure.`,
    source_ids: [counterIds[index % Math.max(1, counterIds.length)] || claim.counterevidence_ids?.[0] || claim.source_ids?.[0]].filter(Boolean),
    result: 'survives',
    reasoning: 'Deterministic mock fixture only; no live scientific conclusion is implied.',
    limitations: ['mock_fixture'],
    next_decisive_test: claim.test_or_probe || `Run decisive falsification probe ${index + 1}.`
  }))
  const ledger = {
    schema_version: 1,
    schema: 'sks.falsification-ledger.v1',
    created_at: nowIso(),
    execution_class: 'mock_fixture',
    cases,
    unresolved_failures: [],
    next_decisive_tests: cases.map((row: any) => row.next_decisive_test)
  }
  await writeJsonAtomic(path.join(input.dir, 'falsification-ledger.json'), ledger)
  return baseResult(input, startedAt, 'falsification', cases.length >= 4 ? 'passed' : 'blocked', ['falsification-ledger.json'], cases.length >= 4 ? [] : ['falsification_cases_below_contract'], { cases: cases.length, execution_class: 'mock_fixture' })
}

async function runImplementationBlueprintStage(input: StageInput, startedAt: string): Promise<ResearchStageResult> {
  const claimMatrix = await readJson(path.join(input.dir, 'claim-evidence-matrix.json'), null)
  const sourceLedger = await readJson(path.join(input.dir, 'source-ledger.json'), null)
  const existingBlueprint = await readImplementationBlueprint(input.dir)
  const blueprint = await densifyImplementationBlueprint({
    root: input.root,
    dir: input.dir,
    plan: input.plan,
    claimMatrix,
    sourceLedger,
    existingBlueprint,
    backend: input.backend === 'mock' ? 'deterministic' : input.backend === 'python-codex-sdk' ? 'python-codex-sdk' : 'codex-sdk'
  })
  await writeImplementationBlueprint(input.dir, blueprint)
  await writeTextAtomic(path.join(input.dir, 'implementation-blueprint.md'), renderImplementationBlueprintMarkdown(blueprint))
  await writeResearchHandoffArtifacts(input.dir, input.plan, blueprint)
  const validation = validateImplementationBlueprint(blueprint, await readJson(path.join(input.dir, 'research-quality-contract.json'), null))
  return baseResult(input, startedAt, 'implementation_blueprint', validation.ok ? 'passed' : 'blocked', ['implementation-blueprint.json', 'implementation-blueprint.md', 'naruto-handoff-goal.md'], validation.blockers, validation)
}

async function runExperimentPlanStage(input: StageInput, startedAt: string): Promise<ResearchStageResult> {
  const claimMatrix = await readJson(path.join(input.dir, 'claim-evidence-matrix.json'), null)
  const sourceLedger = await readJson(path.join(input.dir, 'source-ledger.json'), null)
  const experimentPlan = defaultExperimentPlan(input.plan, { claimMatrix, sourceLedger })
  const replicationPack = defaultReplicationPack(input.plan, { experimentPlan, claimMatrix })
  await writeExperimentPlan(input.dir, experimentPlan)
  await writeReplicationPack(input.dir, replicationPack)
  return baseResult(input, startedAt, 'experiment_plan', 'passed', ['experiment-plan.json', 'experiment-plan.md', 'replication-pack.json'], [], { steps: experimentPlan.steps.length, replication_commands: replicationPack.commands.length })
}

async function runSynthesisStage(input: StageInput, startedAt: string): Promise<ResearchStageResult> {
  const claimMatrix = await readJson(path.join(input.dir, 'claim-evidence-matrix.json'), null)
  const sourceLedger = await readJson(path.join(input.dir, 'source-ledger.json'), null)
  const contract = await readJson(path.join(input.dir, 'research-quality-contract.json'), null)
  const claims = Array.isArray(claimMatrix?.claims) ? claimMatrix.claims : []
  const sourceIds = [
    ...(Array.isArray(sourceLedger?.sources) ? sourceLedger.sources : []),
    ...(Array.isArray(sourceLedger?.counterevidence_sources) ? sourceLedger.counterevidence_sources : [])
  ].map((source: any) => String(source?.id || '')).filter(Boolean)
  const noveltyLedger = {
    schema_version: 1,
    entries: claims.slice(0, 8).map((claim: any, index: number) => ({
      id: claim.id,
      claim: claim.claim,
      type: claim.claim_type,
      novelty: 2,
      confidence: claim.confidence === 'high' ? 3 : 2,
      falsifiability: 3,
      source_ids: claim.source_ids || [],
      counterevidence_ids: claim.counterevidence_ids || [],
      counterevidence_links: claim.counterevidence_links || [],
      evidence: claim.source_ids || [],
      falsifiers: claim.counterevidence_ids || [],
      next_experiment: claim.test_or_probe || `Replicate ${claim.id} against source shard evidence.`
    }))
  }
  await writeJsonAtomic(path.join(input.dir, 'novelty-ledger.json'), noveltyLedger)
  if (input.mock || input.backend === 'mock' || input.backend === 'deterministic') {
    return runDeterministicMockSynthesisStage(input, startedAt, { claimMatrix, sourceLedger, contract, claims, sourceIds })
  }
  const synthesis = await runResearchCodexSynthesisWriter({
    root: input.root,
    dir: input.dir,
    plan: input.plan,
    cycle: input.cycle,
    timeoutMs: input.timeoutMs,
    ...(input.cycleDeadlineMs === undefined ? {} : { deadlineMs: input.cycleDeadlineMs }),
    backendPreference: input.backend === 'python-codex-sdk' ? ['python-codex-sdk', 'codex-sdk'] : ['codex-sdk', 'python-codex-sdk']
  })
  const validation = validateResearchSynthesisOutput(synthesis, contract, claimMatrix, sourceLedger)
  return synthesisStageResult(input, startedAt, synthesis, validation, 'codex')
}

async function runDeterministicMockSynthesisStage(input: StageInput, startedAt: string, artifacts: any): Promise<ResearchStageResult> {
  const synthesis = await runResearchCodexSynthesisWriter({
    root: input.root,
    dir: input.dir,
    plan: { ...input.plan, backend: input.backend },
    cycle: input.cycle,
    timeoutMs: input.timeoutMs,
    ...(input.cycleDeadlineMs === undefined ? {} : { deadlineMs: input.cycleDeadlineMs }),
    mock: true
  })
  const validation = validateResearchSynthesisOutput(synthesis, artifacts.contract, artifacts.claimMatrix, artifacts.sourceLedger)
  return synthesisStageResult(input, startedAt, synthesis, validation, input.backend === 'deterministic' ? 'deterministic' : 'mock')
}

function synthesisStageResult(input: StageInput, startedAt: string, synthesis: ResearchSynthesisOutput, validation: { ok: boolean; blockers: string[] }, writer: 'codex' | 'mock' | 'deterministic'): ResearchStageResult {
  const artifacts = ['research-synthesis-output.json', 'research-report.md', researchPaperArtifactForPlan(input.plan), 'novelty-ledger.json']
  const blockers = [...new Set([...(validation.blockers || []), ...(synthesis.blockers || [])])]
  return baseResult(input, startedAt, 'synthesis', validation.ok && blockers.length === 0 ? 'passed' : 'blocked', artifacts, blockers, {
    synthesis_writer: writer === 'codex' ? 'codex-sdk' : writer,
    claims: synthesis.synthesis_summary.key_claim_ids.length,
    sources: synthesis.synthesis_summary.source_ids_used.length,
    ...synthesis.quality_signals
  })
}

async function runFinalReviewStage(input: StageInput, startedAt: string): Promise<ResearchStageResult> {
  const staticReview = await runResearchStaticFinalReview(input.dir, { plan: input.plan })
  const adversarial = await runResearchAdversarialReviewLoop({
    root: input.root,
    dir: input.dir,
    plan: input.plan,
    timeoutMs: input.timeoutMs,
    ...(input.cycleDeadlineMs === undefined ? {} : { deadlineMs: input.cycleDeadlineMs }),
    ...(input.maxReviewCycles === undefined ? {} : { maxCycles: input.maxReviewCycles }),
    ...(input.maxReviewThreads === undefined ? {} : { maxThreads: input.maxReviewThreads }),
    mock: input.mock || input.backend === 'mock' || input.backend === 'deterministic',
    preliminaryBlockers: staticReview.approved === true ? [] : staticReview.blockers
  })
  const merged = await runResearchFinalReviewer(input.dir, { plan: input.plan, root: input.root, mock: input.mock || input.backend === 'mock' || input.backend === 'deterministic' })
  const status = merged.approved === true && adversarial.gate?.passed === true ? 'passed' : 'blocked'
  return baseResult(input, startedAt, 'final_review', status, [
    'research-final-review.static.json',
    'research-final-review.codex.json',
    'research-final-review.json',
    RESEARCH_ADVERSARIAL_PLAN_ARTIFACT,
    RESEARCH_ADVERSARIAL_REVIEW_ARTIFACT,
    RESEARCH_REVISION_LEDGER_ARTIFACT,
    RESEARCH_CONVERGENCE_GATE_ARTIFACT,
    RESEARCH_HONEST_MODE_ARTIFACT,
    'agent-ledger.json',
    'debate-ledger.json'
  ], merged.blockers || [], {
    approved: merged.approved === true,
    official_subagent_review: true,
    review_cycles: adversarial.gate?.review_cycles || 0,
    revision_cycles: adversarial.gate?.revision_cycles || 0,
    unresolved_critical_objections: adversarial.gate?.unresolved_critical_objections ?? null,
    unresolved_major_objections: adversarial.gate?.unresolved_major_objections ?? null,
    advisory_objections: adversarial.gate?.advisory_objections ?? null
  })
}

async function runVerificationStage(input: StageInput, startedAt: string): Promise<ResearchStageResult> {
  const gateSeed = await buildResearchGateSeed(input.dir, input.plan, input)
  await writeJsonAtomic(path.join(input.dir, 'research-gate.json'), gateSeed)
  const evaluated = await evaluateResearchGate(input.dir)
  return baseResult(input, startedAt, 'verification', evaluated.passed ? 'passed' : 'blocked', ['research-gate.json', 'research-gate.evaluated.json'], evaluated.reasons || [], evaluated.metrics || {})
}

export async function runResearchCodexStage(input: {
  root: string
  dir: string
  plan: any
  stage: any
  prompt: string
  outputSchema: any
  outputArtifact: string
  backendPreference: Array<'codex-sdk' | 'python-codex-sdk'>
  timeoutMs: number
  deadlineMs?: number
}): Promise<ResearchStageResult> {
  const startedAt = nowIso()
  const stageKind = inferStageKind(input.stage)
  const stageId = String(input.stage?.id || stageKind)
  const result = await runCodexTask({
    route: '$Research',
    tier: 'worker',
    missionId: String(input.plan?.mission_id || 'research-stage'),
    workItemId: stageId,
    cwd: input.root,
    prompt: input.prompt,
    outputSchema: input.outputSchema,
    outputSchemaId: `sks.research-stage.${stageId}.v1`,
    sandboxPolicy: 'read-only',
    requestedScopeContract: {
      id: `research-stage-${stageId}`,
      route: '$Research',
      read_only: true,
      allowed_paths: [`.sneakoscope/missions/${input.plan?.mission_id || ''}/`],
      write_paths: [],
      allowed_write_prefixes: [`.sneakoscope/missions/${input.plan?.mission_id || ''}/`],
      source_mutation_allowed: false
    },
    backendPreference: input.backendPreference as CodexControlBackend[],
    mutationLedgerRoot: path.join(input.dir, 'research', 'codex-stage-control', stageId),
    reliabilityPolicy: {
      timeoutClass: 'standard',
      idleTimeoutMs: input.timeoutMs,
      hardTimeoutMs: input.timeoutMs,
      ...(input.deadlineMs === undefined ? {} : { deadlineEpochMs: input.deadlineMs })
    }
  })
  const worker = await readJson(result.workerResultPath, null)
  if (Array.isArray(worker?.patch_envelopes) && worker.patch_envelopes.length) {
    return baseResult({ ...input, graph: null, cycle: 0, backend: result.backend as ResearchStageBackend, timeoutMs: input.timeoutMs, mock: false }, startedAt, stageKind, 'failed', [], ['research_stage_patch_envelope_forbidden'], { worker_result_path: result.workerResultPath })
  }
  const validation = validateResearchSourceShardOutput(worker)
  if (validation.ok) await writeJsonAtomic(path.join(input.dir, input.outputArtifact), worker)
  return baseResult({ ...input, graph: null, cycle: Number(worker?.cycle || 0), backend: result.backend as ResearchStageBackend, timeoutMs: input.timeoutMs, mock: false }, startedAt, stageKind, validation.ok ? 'passed' : 'blocked', validation.ok ? [input.outputArtifact] : [], validation.ok ? [] : validation.blockers, { worker_result_path: result.workerResultPath })
}

function inferStageKind(stage: any): ResearchStageKind {
  const raw = String(stage?.stage_kind || stage?.kind || stage?.id || '').toLowerCase()
  if (raw === 'source_shard' || raw.startsWith('source_shard_')) return 'source_shard'
  if (raw.includes('source_merge') || raw.includes('source_ledger_merge')) return 'source_merge'
  if (raw.includes('claim_matrix')) return 'claim_matrix_build'
  if (raw.includes('falsification') || raw.includes('falsify')) return 'falsification'
  if (raw.includes('blueprint')) return 'implementation_blueprint'
  if (raw.includes('experiment') || raw.includes('replication')) return 'experiment_plan'
  if (raw.includes('synthesis') || raw.includes('report')) return 'synthesis'
  if (raw.includes('final_review')) return 'final_review'
  if (raw.includes('verification') || raw.includes('gate')) return 'verification'
  return 'verification'
}

function baseResult(input: StageInput, startedAt: string, stageKind: ResearchStageKind, status: ResearchStageResult['status'], outputArtifacts: string[], blockers: string[], metrics: Record<string, unknown> = {}): ResearchStageResult {
  return {
    schema: 'sks.research-stage-result.v1',
    mission_id: String(input.plan?.mission_id || ''),
    cycle: Number(input.cycle || 0),
    stage_id: String(input.stage?.id || `${stageKind}-${input.cycle || 0}`),
    stage_kind: stageKind,
    status,
    started_at: startedAt,
    completed_at: nowIso(),
    input_artifacts: normalizeStringList(input.stage?.readonly_paths || input.stage?.input_artifacts),
    output_artifacts: outputArtifacts,
    backend: input.backend,
    worker_result_path: typeof metrics.worker_result_path === 'string' ? metrics.worker_result_path : null,
    blockers: [...new Set(blockers.map(String).filter(Boolean))],
    metrics: {
      ...metrics,
      codex_app_execution_profile: input.plan?.codex_app_execution_profile || null,
      source_tool_route: metrics.source_tool_route || researchSourceToolRoute(input.plan)
    }
  }
}

function researchSourceToolRoute(plan: any): string {
  return plan?.web_research_policy?.source_tool_routing?.mode || (plan?.codex_app_execution_profile?.plugin_mcp_inventory_ready ? 'plugin-mcp-inventory-first' : 'codex-cli-or-web-fallback')
}

async function buildResearchGateSeed(dir: string, plan: any, input: StageInput) {
  const sourceLedger = await readJson(path.join(dir, 'source-ledger.json'), null)
  const claimMatrix = await readJson(path.join(dir, 'claim-evidence-matrix.json'), null)
  const finalReview = await readJson(path.join(dir, 'research-final-review.json'), null)
  const adversarialGate = await readJson(path.join(dir, RESEARCH_CONVERGENCE_GATE_ARTIFACT), null)
  const honest = await readJson(path.join(dir, RESEARCH_HONEST_MODE_ARTIFACT), null)
  const falsificationLedger = await readJson(path.join(dir, 'falsification-ledger.json'), null)
  const experimentPlan = await readJson(path.join(dir, 'experiment-plan.json'), null)
  const paper = researchPaperArtifactForPlan(plan)
  const sourceRows = [
    ...(Array.isArray(sourceLedger?.sources) ? sourceLedger.sources : []),
    ...(Array.isArray(sourceLedger?.counterevidence_sources) ? sourceLedger.counterevidence_sources : [])
  ]
  const sourceLayers = Array.isArray(sourceLedger?.source_layers) ? sourceLedger.source_layers : []
  const falsificationCases = Array.isArray(falsificationLedger?.cases) ? falsificationLedger.cases : []
  const experimentSteps = Array.isArray(experimentPlan?.steps) ? experimentPlan.steps : []
  const reportPresent = await exists(path.join(dir, 'research-report.md'))
  const paperText = await readText(path.join(dir, paper), '')
  return {
    passed: finalReview?.approved === true && adversarialGate?.passed === true,
    execution_class: input.mock || input.backend === 'mock' || input.backend === 'deterministic' ? 'mock_fixture' : 'real',
    report_present: reportPresent,
    research_paper_artifact: paper,
    paper_present: Boolean(paperText.trim()),
    paper_sections: RESEARCH_PAPER_SECTION_GROUPS.filter((group: readonly string[]) => group.some((heading) => paperText.toLowerCase().includes(heading))).length,
    research_source_skill_present: await exists(path.join(dir, 'research-source-skill.md')),
    source_ledger_present: Boolean(sourceLedger),
    novelty_ledger_present: await exists(path.join(dir, 'novelty-ledger.json')),
    falsification_ledger_present: Boolean(falsificationLedger),
    web_search_passes: Number(sourceLedger?.web_search_passes || 0),
    source_entries: sourceRows.length,
    source_layers_required: sourceLayers.length,
    source_layers_covered: sourceLayers.filter((layer: any) => layer.status === 'covered').length,
    triangulation_checks: Array.isArray(sourceLedger?.triangulation?.cross_layer_checks) ? sourceLedger.triangulation.cross_layer_checks.length : 0,
    xhigh_agents: 0,
    counterevidence_sources: Array.isArray(sourceLedger?.counterevidence_sources) ? sourceLedger.counterevidence_sources.length : 0,
    candidate_insights: Array.isArray(claimMatrix?.claims) ? claimMatrix.claims.length : 0,
    falsification_passes: falsificationCases.length ? 1 : 0,
    falsification_cases: falsificationCases.length,
    testable_predictions: experimentSteps.length,
    citation_coverage: sourceLedger?.citation_coverage?.all_key_claims_cited === true,
    web_search_blockers: Array.isArray(sourceLedger?.blockers) ? sourceLedger.blockers : [],
    unsafe_or_destructive_actions: false,
    unsupported_breakthrough_claims: Array.isArray(honest?.overclaims) ? honest.overclaims.length : 1,
    official_subagent_review: adversarialGate,
    honest_mode: honest,
    evidence: [
      'source-ledger.json',
      'claim-evidence-matrix.json',
      RESEARCH_ADVERSARIAL_REVIEW_ARTIFACT,
      RESEARCH_REVISION_LEDGER_ARTIFACT,
      RESEARCH_CONVERGENCE_GATE_ARTIFACT,
      RESEARCH_HONEST_MODE_ARTIFACT
    ],
    notes: ['Reviewer acceptance is derived from evidence-correlated structured outcomes; lifecycle completion alone is insufficient.']
  }
}

function normalizeStringList(value: any): string[] {
  return [...new Set((Array.isArray(value) ? value : value == null ? [] : [value]).map((item) => String(item || '').trim()).filter(Boolean))]
}

type StageInput = {
  root: string
  dir: string
  plan: any
  graph: any
  stage: any
  cycle: number
  backend: ResearchStageBackend
  timeoutMs: number
  cycleDeadlineMs?: number
  maxReviewCycles?: number
  maxReviewThreads?: number
  mock?: boolean
}
