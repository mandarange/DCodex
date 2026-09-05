import path from 'node:path'
import { nowIso, writeJsonAtomic } from '../fsx.js'
import { RESEARCH_REVIEWER_CONTRACT } from '../recallpulse/policy.js'
import type { NarutoWorkGraph, NarutoWorkItem, NarutoWorkKind } from '../naruto/naruto-work-item.js'
import { RESEARCH_SOURCE_LAYERS } from './research-source-layer-catalog.js'

export const RESEARCH_WORK_GRAPH_ARTIFACT = 'research-work-graph.json'
export const REQUIRED_SOURCE_SHARD_IDS = Object.freeze(
  RESEARCH_SOURCE_LAYERS.map((layer) => `source_shard_${layer.id}`)
)

type ResearchGraphStage = {
  id: string
  title: string
  kind: NarutoWorkKind
  stage_kind: string
  layer_id?: string
  outputs: string[]
  dependencies: string[]
  required?: boolean
}

function researchStages(): ResearchGraphStage[] {
  const sourceShards = RESEARCH_SOURCE_LAYERS.map((layer) => ({
    id: `source_shard_${layer.id}`,
    title: `Source shard: ${layer.label}`,
    kind: 'research' as NarutoWorkKind,
    stage_kind: 'source_shard',
    layer_id: layer.id,
    dependencies: [],
    outputs: [`research/cycle-\${cycle}/source-shards/${layer.id}.json`]
  }))
  const shardIds = sourceShards.map((stage) => stage.id)
  return [
    ...sourceShards,
    {
      id: 'source_ledger_merge',
      title: 'Source-ledger partial merge',
      kind: 'research',
      stage_kind: 'source_merge',
      dependencies: shardIds,
      outputs: ['source-ledger.json', 'source-quality-report.json']
    },
    {
      id: 'claim_matrix_build',
      title: 'Claim-evidence matrix build from merged source shards',
      kind: 'research',
      stage_kind: 'claim_matrix_build',
      dependencies: [...shardIds, 'source_ledger_merge'],
      outputs: ['claim-evidence-matrix.json']
    },
    {
      id: 'falsification',
      title: 'Counterevidence and falsification stage',
      kind: 'verification',
      stage_kind: 'falsification',
      dependencies: ['claim_matrix_build', 'source_shard_counterevidence_factcheck'],
      outputs: ['falsification-ledger.json']
    },
    {
      id: 'implementation_blueprint',
      title: 'Concrete implementation blueprint and handoff',
      kind: 'documentation',
      stage_kind: 'implementation_blueprint',
      dependencies: ['claim_matrix_build', 'source_shard_local_project_evidence'],
      outputs: ['implementation-blueprint.json', 'implementation-blueprint.md', 'naruto-handoff-goal.md']
    },
    {
      id: 'experiment_plan',
      title: 'Experiment plan and replication pack',
      kind: 'verification',
      stage_kind: 'experiment_plan',
      dependencies: ['implementation_blueprint', 'falsification'],
      outputs: ['experiment-plan.json', 'experiment-plan.md', 'replication-pack.json']
    },
    {
      id: 'synthesis',
      title: 'Research report and manuscript synthesis',
      kind: 'research',
      stage_kind: 'synthesis',
      dependencies: ['claim_matrix_build', 'falsification', 'implementation_blueprint', 'experiment_plan'],
      outputs: ['research-report.md', 'research-paper.md', 'novelty-ledger.json']
    },
    {
      id: 'final_review',
      title: 'Static plus official-subagent adversarial review and bounded revision',
      kind: 'verification',
      stage_kind: 'final_review',
      dependencies: ['synthesis'],
      outputs: [
        'research-final-review.static.json',
        'research-final-review.codex.json',
        'research-final-review.json',
        'research-adversarial-plan.json',
        'research-adversarial-review.json',
        'research-revision-ledger.json',
        'research-adversarial-convergence.json',
        'research-honest-mode.json',
        'agent-ledger.json',
        'debate-ledger.json'
      ]
    },
    {
      id: 'verification',
      title: 'Research gate evaluation and route finalization input',
      kind: 'final_review_input_pack',
      stage_kind: 'verification',
      dependencies: ['final_review'],
      outputs: ['research-gate.json', 'research-gate.evaluated.json']
    }
  ]
}

function workItem(stage: ResearchGraphStage, index: number, allStages: ResearchGraphStage[], plan: any = null): NarutoWorkItem & Record<string, unknown> {
  const missionPrefix = plan?.mission_id ? `.sneakoscope/missions/${plan.mission_id}/` : ''
  const item: NarutoWorkItem = {
    id: stage.id,
    kind: stage.kind,
    title: stage.title,
    target_paths: stage.outputs.map((artifact) => `${missionPrefix}${artifact}`),
    readonly_paths: [
      `${missionPrefix}research-plan.json`,
      `${missionPrefix}research-quality-contract.json`,
      `${missionPrefix}source-ledger.json`,
      `${missionPrefix}claim-evidence-matrix.json`,
      `${missionPrefix}falsification-ledger.json`
    ],
    write_paths: [],
    required_role: index < RESEARCH_SOURCE_LAYERS.length ? 'research' : stage.kind === 'documentation' ? 'planner' : 'verifier',
    write_allowed: false,
    verification_required: true,
    dependencies: stage.dependencies,
    can_run_in_parallel_with: allStages.filter((candidate) => candidate.id !== stage.id && !stage.dependencies.includes(candidate.id)).map((candidate) => candidate.id),
    conflicts_with: [],
    estimated_cost: { tokens: stage.stage_kind === 'source_shard' ? 2500 : 4000, latency_ms: stage.stage_kind === 'source_shard' ? 30000 : 60000, cpu_weight: 1, memory_mb: 256, gpu_weight: 0 },
    lease_requirements: stage.outputs.map((artifact) => ({ path: `${missionPrefix}${artifact}`, kind: 'read' })),
    acceptance: { requires_patch_envelope: false, requires_verification: true, requires_gpt_final: stage.stage_kind === 'final_review' },
    owner: null,
    allocation_reason: 'Stage-aware read-only Research graph: Super Search source acquisition, evidence synthesis, and official-subagent adversarial convergence',
    allocation_score: 1,
    allocation_hints: { domains: [stage.kind], write_paths: [], read_only_paths: stage.outputs } as any,
    lane: null,
    worktree: { mode: 'patch-envelope-only', required: false, allocation_required: false }
  }
  return {
    ...item,
    stage_kind: stage.stage_kind,
    layer_id: stage.layer_id || null,
    output_artifacts: stage.outputs,
    required: stage.required !== false
  }
}

export function buildResearchWorkGraph(plan: any = null): NarutoWorkGraph & Record<string, unknown> {
  const stages = researchStages()
  const requestedReviewers = RESEARCH_REVIEWER_CONTRACT.length
  const workItems = stages.map((stage, index) => workItem(stage, index, stages, plan))
  const sourceShardIds = workItems.filter((item: any) => item.stage_kind === 'source_shard').map((item) => item.id)
  const closeoutIds = workItems.filter((item: any) => item.stage_kind !== 'source_shard').map((item) => item.id)
  return {
    schema: 'sks.naruto-work-graph.v1',
    route: '$Naruto',
    requested_workers: requestedReviewers,
    total_work_items: workItems.length,
    readonly: true,
    write_capable: false,
    work_items: workItems,
    active_waves: [
      { wave_id: 'parallel-source-shard-wave', work_item_ids: sourceShardIds, write_paths: [], conflict_count: 0 },
      { wave_id: 'research-closeout-wave', work_item_ids: closeoutIds, write_paths: [], conflict_count: 0 }
    ],
    mixed_work_kinds: [...new Set(workItems.map((item) => item.kind))],
    write_allowed_count: 0,
    worktree_policy: { mode: 'patch-envelope-only', required: false, main_repo_root: null, worktree_root: null, fallback_reason: 'Research route is read-only.' },
    blockers: [],
    ok: true,
    official_subagent_workflow: true,
    official_subagent_reviewer_count: requestedReviewers
  }
}

export async function writeResearchWorkGraph(dir: string, plan: any = null) {
  const graph = buildResearchWorkGraph(plan)
  await writeJsonAtomic(path.join(dir, RESEARCH_WORK_GRAPH_ARTIFACT), {
    ...graph,
    generated_at: nowIso()
  })
  return graph
}
