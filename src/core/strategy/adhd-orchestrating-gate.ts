import path from 'node:path'
import { nowIso, sha256, writeJsonAtomic, writeTextAtomic } from '../fsx.js'

export const ADHD_ORCHESTRATING_GATE_SCHEMA = 'sks.adhd-orchestrating-gate.v1'
export const DOPAMINE_ORCHESTRATION_PLAN_SCHEMA = 'sks.dopamine-orchestration-plan.v1'
export const PROGRESS_REWARD_LEDGER_SCHEMA = 'sks.progress-reward-ledger.v1'
export const MICRO_WIN_TASK_BOARD_SCHEMA = 'sks.micro-win-task-board.v1'

export interface MicroWinTask {
  id: string
  title: string
  description: string
  expected_reward: string
  verification_signal: string
  owner_agent: string
  owner_persona: string
  max_duration_minutes: number
  proof_artifact: string
  kind: 'read_only' | 'write' | 'verification' | 'rollback' | 'operator_action'
  write_paths: string[]
  readonly_paths: string[]
  appshot_required: boolean
  dopamine_weight: number
  dependencies: string[]
}

export interface AdhdOrchestratingGateArtifact {
  schema: typeof ADHD_ORCHESTRATING_GATE_SCHEMA
  generated_at: string
  prompt_hash: string
  metaphor_disclaimer: string
  objective_ladder: string[]
  micro_wins: MicroWinTask[]
  quick_win_candidates: string[]
  visible_progress_tasks: string[]
  boring_but_critical_tasks: string[]
  waiting_async_lanes: string[]
  novelty_rotation: string[]
  focus_recovery_checkpoints: string[]
  momentum_restart_triggers: string[]
  reward_heartbeat_interval_minutes: number
  boredom_risk: number
  context_switching_risk: number
  write_task_count: number
  read_only_task_count: number
  visual_appshot_required_count: number
  verification_quick_feedback: string[]
  rollback_confidence_tasks: string[]
  agent_dopamine_weights: Record<string, number>
  scheduler_requires_gate: true
  ok: boolean
  blockers: string[]
}

export function runAdhdOrchestratingGate(input: {
  prompt: string
  route?: string
  writeTargets?: string[]
  readonlyTargets?: string[]
  agentCount?: number
  visualRequired?: boolean
}): AdhdOrchestratingGateArtifact {
  const prompt = String(input.prompt || '')
  const agentCount = Math.max(1, Math.floor(Number(input.agentCount || 3)))
  const objectives = objectiveLadder(prompt)
  const writeTargets = uniquePaths(input.writeTargets || inferWriteTargets(prompt))
  const readonlyTargets = uniquePaths(input.readonlyTargets || inferReadonlyTargets(prompt))
  const visualRequired = input.visualRequired === true || needsVisualContext(prompt)
  const microWins = buildMicroWins({
    objectives,
    writeTargets,
    readonlyTargets,
    agentCount,
    visualRequired
  })
  const writeTaskCount = microWins.filter((task) => task.kind === 'write').length
  const readOnlyTaskCount = microWins.filter((task) => task.kind === 'read_only').length
  const visualCount = microWins.filter((task) => task.appshot_required).length
  const blockers: string[] = []
  if (!prompt.trim()) blockers.push('user_request_missing')
  if (!microWins.length) blockers.push('micro_win_units_missing')
  return {
    schema: ADHD_ORCHESTRATING_GATE_SCHEMA,
    generated_at: nowIso(),
    prompt_hash: sha256(prompt).slice(0, 16),
    metaphor_disclaimer: 'ADHD and dopamine language is an orchestration/UX metaphor only, not a medical diagnosis or clinical claim.',
    objective_ladder: objectives,
    micro_wins: microWins,
    quick_win_candidates: microWins.filter((task) => task.max_duration_minutes <= 15).map((task) => task.id),
    visible_progress_tasks: microWins.filter((task) => task.dopamine_weight >= 0.7).map((task) => task.id),
    boring_but_critical_tasks: microWins.filter((task) => /version|metadata|release|schema|proof/i.test(task.title)).map((task) => task.id),
    waiting_async_lanes: microWins.filter((task) => task.kind === 'operator_action' || task.kind === 'verification').map((task) => task.id),
    novelty_rotation: microWins.map((task) => task.kind).filter((kind, index, list) => list.indexOf(kind) === index),
    focus_recovery_checkpoints: ['after_strategy_artifacts', 'after_first_patch_batch', 'after_verification_failure', 'before_final_honest_mode'],
    momentum_restart_triggers: ['blocked_micro_win', 'failed_verification', 'conflict_serialization', 'operator_action_required'],
    reward_heartbeat_interval_minutes: 10,
    boredom_risk: scoreRisk(prompt.length > 5000 || microWins.length > 8, writeTargets.length === 0),
    context_switching_risk: scoreRisk(writeTargets.length > agentCount, visualRequired && writeTargets.length > 0),
    write_task_count: writeTaskCount,
    read_only_task_count: readOnlyTaskCount,
    visual_appshot_required_count: visualCount,
    verification_quick_feedback: microWins.filter((task) => task.kind === 'verification').map((task) => task.id),
    rollback_confidence_tasks: microWins.filter((task) => task.kind === 'rollback').map((task) => task.id),
    agent_dopamine_weights: Object.fromEntries(microWins.map((task) => [task.owner_agent, task.dopamine_weight])),
    scheduler_requires_gate: true,
    ok: blockers.length === 0,
    blockers
  }
}

export function buildDopamineOrchestrationArtifacts(gate: AdhdOrchestratingGateArtifact) {
  const completed = gate.micro_wins.filter((task) => task.kind === 'read_only').map((task) => ({ id: task.id, signal: task.verification_signal }))
  return {
    dopaminePlan: {
      schema: DOPAMINE_ORCHESTRATION_PLAN_SCHEMA,
      generated_at: gate.generated_at,
      metaphor_disclaimer: gate.metaphor_disclaimer,
      reward_heartbeat_interval_minutes: gate.reward_heartbeat_interval_minutes,
      micro_wins: gate.micro_wins,
      quick_win_candidates: gate.quick_win_candidates,
      high_dopamine_visible_progress_tasks: gate.visible_progress_tasks,
      boring_but_critical_tasks: gate.boring_but_critical_tasks,
      waiting_async_lanes: gate.waiting_async_lanes
    },
    progressLedger: {
      schema: PROGRESS_REWARD_LEDGER_SCHEMA,
      generated_at: gate.generated_at,
      completed_micro_wins: completed,
      blocked_micro_wins: gate.blockers.map((blocker) => ({ blocker })),
      recovery_actions: gate.momentum_restart_triggers.map((trigger) => ({ trigger, action: 're-slice to the smallest verifiable task and update proof artifacts' }))
    },
    microWinBoard: {
      schema: MICRO_WIN_TASK_BOARD_SCHEMA,
      generated_at: gate.generated_at,
      summary_available: true,
      items: gate.micro_wins.map((task) => ({
        id: task.id,
        title: task.title,
        owner_agent: task.owner_agent,
        expected_reward: task.expected_reward,
        verification_signal: task.verification_signal,
        status: completed.some((row) => row.id === task.id) ? 'completed' : 'pending',
        proof_artifact: task.proof_artifact
      }))
    },
    focusRecoveryPlan: {
      schema: 'sks.focus-recovery-plan.v1',
      checkpoints: gate.focus_recovery_checkpoints
    },
    momentumRestartPlan: {
      schema: 'sks.momentum-restart-plan.v1',
      triggers: gate.momentum_restart_triggers
    },
    noveltyRotationPlan: {
      schema: 'sks.novelty-rotation-plan.v1',
      rotation: gate.novelty_rotation
    },
    parallelStrategyScore: {
      schema: 'sks.parallel-strategy-score.v1',
      expected_parallelism_score: Math.max(0, Math.min(1, gate.write_task_count / Math.max(1, gate.micro_wins.length))),
      context_switch_risk_score: gate.context_switching_risk,
      micro_win_throughput_score: Math.max(0, Math.min(1, gate.quick_win_candidates.length / Math.max(1, gate.micro_wins.length)))
    }
  }
}

export async function writeAdhdOrchestrationArtifacts(root: string, gate: AdhdOrchestratingGateArtifact) {
  const artifacts = buildDopamineOrchestrationArtifacts(gate)
  await writeJsonAtomic(path.join(root, 'adhd-orchestrating-gate.json'), gate)
  await writeJsonAtomic(path.join(root, 'dopamine-orchestration-plan.json'), artifacts.dopaminePlan)
  await writeJsonAtomic(path.join(root, 'progress-reward-ledger.json'), artifacts.progressLedger)
  await writeJsonAtomic(path.join(root, 'micro-win-task-board.json'), artifacts.microWinBoard)
  await writeTextAtomic(path.join(root, 'micro-win-task-board.md'), renderMicroWinBoard(artifacts.microWinBoard))
  await writeJsonAtomic(path.join(root, 'focus-recovery-plan.json'), artifacts.focusRecoveryPlan)
  await writeJsonAtomic(path.join(root, 'momentum-restart-plan.json'), artifacts.momentumRestartPlan)
  await writeJsonAtomic(path.join(root, 'novelty-rotation-plan.json'), artifacts.noveltyRotationPlan)
  await writeJsonAtomic(path.join(root, 'parallel-strategy-score.json'), artifacts.parallelStrategyScore)
  return artifacts
}

function buildMicroWins(input: {
  objectives: string[]
  writeTargets: string[]
  readonlyTargets: string[]
  agentCount: number
  visualRequired: boolean
}): MicroWinTask[] {
  const tasks: MicroWinTask[] = []
  for (const [index, objective] of input.objectives.slice(0, Math.max(3, input.agentCount)).entries()) {
    tasks.push(task(index, {
      title: `Understand objective ${index + 1}`,
      description: objective,
      kind: 'read_only',
      readonlyPaths: input.readonlyTargets.slice(0, 5),
      dopamineWeight: 0.55,
      expectedReward: 'fast clarity and reduced duplicate analysis',
      verificationSignal: 'objective recorded in user-request-strategy.json'
    }))
  }
  for (const [index, file] of input.writeTargets.entries()) {
    tasks.push(task(tasks.length, {
      title: `Patch ${file}`,
      description: `Exclusive write lease for ${file}`,
      kind: 'write',
      writePaths: [file],
      dopamineWeight: 0.85,
      expectedReward: 'visible code/docs progress',
      verificationSignal: `diff and after-hash recorded for ${file}`,
      dependencies: tasks.slice(0, 1).map((row) => row.id)
    }))
  }
  tasks.push(task(tasks.length, {
    title: 'Verify first patch batch',
    description: 'Run the smallest relevant checks before widening the patch set.',
    kind: 'verification',
    dopamineWeight: 0.9,
    expectedReward: 'quick feedback loop',
    verificationSignal: 'verification-dag.json node completed',
    dependencies: tasks.filter((row) => row.kind === 'write').map((row) => row.id)
  }))
  tasks.push(task(tasks.length, {
    title: 'Prepare rollback confidence',
    description: 'Record rollback diff/digest before claiming patch proof.',
    kind: 'rollback',
    dopamineWeight: 0.75,
    expectedReward: 'failure feels recoverable',
    verificationSignal: 'rollback-dag.json node completed',
    dependencies: tasks.filter((row) => row.kind === 'write').map((row) => row.id)
  }))
  if (input.visualRequired) {
    tasks.push(task(tasks.length, {
      title: 'Request Appshot if visual proof is needed',
      description: 'Operator-assisted Appshot is required only for visual/app-state proof.',
      kind: 'operator_action',
      appshotRequired: true,
      dopamineWeight: 0.65,
      expectedReward: 'clear human-visible next action',
      verificationSignal: 'appshots-operator-action.json status recorded'
    }))
  }
  return tasks
}

function task(index: number, input: {
  title: string
  description: string
  kind: MicroWinTask['kind']
  writePaths?: string[]
  readonlyPaths?: string[]
  dopamineWeight?: number
  expectedReward: string
  verificationSignal: string
  dependencies?: string[]
  appshotRequired?: boolean
}): MicroWinTask {
  const id = `micro-win-${String(index + 1).padStart(3, '0')}`
  return {
    id,
    title: input.title,
    description: input.description,
    expected_reward: input.expectedReward,
    verification_signal: input.verificationSignal,
    owner_agent: `executor_${(index % 3) + 1}`,
    owner_persona: input.kind === 'verification' ? 'verifier' : input.kind === 'rollback' ? 'safety' : input.kind === 'read_only' ? 'planner' : 'implementer',
    max_duration_minutes: input.kind === 'write' ? 25 : 15,
    proof_artifact: input.kind === 'write' ? 'agent-patch-proof.json' : input.kind === 'rollback' ? 'rollback-dag.json' : input.kind === 'operator_action' ? 'appshots-operator-action.json' : 'strategy-trust-evidence.json',
    kind: input.kind,
    write_paths: uniquePaths(input.writePaths || []),
    readonly_paths: uniquePaths(input.readonlyPaths || []),
    appshot_required: input.appshotRequired === true,
    dopamine_weight: input.dopamineWeight ?? 0.5,
    dependencies: input.dependencies || []
  }
}

function objectiveLadder(prompt: string): string[] {
  const lines = String(prompt || '').split(/\n+/).map((line) => line.replace(/^[-*#\s]+/, '').trim()).filter(Boolean)
  const candidates = lines.length ? lines : [String(prompt || '').trim()].filter(Boolean)
  return candidates.slice(0, 6).map((line, index) => `${index + 1}. ${line.slice(0, 180)}`)
}

function inferWriteTargets(prompt: string): string[] {
  const matches = [...String(prompt || '').matchAll(/`([^`]+\.(?:ts|mjs|js|json|md|toml|rs|txt))`/g)].map((match) => match[1] || '')
  return uniquePaths(matches).filter((file) => !isProtectedPath(file)).slice(0, 32)
}

function inferReadonlyTargets(prompt: string): string[] {
  return uniquePaths([...String(prompt || '').matchAll(/(?:docs|src|test|scripts)\/[A-Za-z0-9._/\-]+/g)].map((match) => match[0] || '')).slice(0, 12)
}

function needsVisualContext(prompt: string): boolean {
  const text = String(prompt || '')
  return /appshot|screenshot|ui|ux|preview|browser|image|design|화면|시각|스크린샷/i.test(text) || /\bvisual\b/i.test(text)
}

function uniquePaths(paths: string[]): string[] {
  return [...new Set(paths.map((file) => String(file || '').replace(/\\/g, '/').replace(/^\.\/+/, '').trim()).filter(Boolean))]
}

function isProtectedPath(file: string): boolean {
  return /^(?:\.codex|\.agents\/skills|\.codex\/agents|AGENTS\.md|node_modules\/sneakoscope|\.sneakoscope\/.*policy.*\.json)(?:\/|$)/.test(file)
}

function scoreRisk(...signals: boolean[]): number {
  const active = signals.filter(Boolean).length
  return Math.min(1, Number((0.25 + active * 0.25).toFixed(2)))
}

function renderMicroWinBoard(board: any): string {
  const lines = ['# Micro-Win Task Board', '', '| ID | Owner | Status | Signal |', '| --- | --- | --- | --- |']
  for (const item of board.items || []) lines.push(`| ${item.id} | ${item.owner_agent} | ${item.status} | ${String(item.verification_signal).replace(/\|/g, '/')} |`)
  return `${lines.join('\n')}\n`
}
