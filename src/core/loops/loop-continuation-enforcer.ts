import path from 'node:path'
import { nowIso, readJson, writeJsonAtomic } from '../fsx.js'
import { loopPlanPath } from './loop-artifacts.js'
import { isRecord } from '../json/records.js'
import { executionProgressFingerprint } from '../runtime/execution-control.js'
import { loopProofCompletionIssues } from './loop-proof-validation.js'

interface LoopContinuationReport {
  schema: 'sks.loop-continuation-enforcer.v1'
  generated_at: string
  ok: boolean
  mission_id: string
  nodes: number
  completed: number
  incomplete: number
  max_continuation_turns: number
  continuation_turn: number
  progress_fingerprint: string
  should_continue: boolean
  terminal_blocked: boolean
  stop_reason: 'loop_plan_missing' | 'loop_plan_empty' | 'all_loop_proofs_verified' | 'loop_proof_unverified' | 'continuation_budget_exhausted' | 'execution_control_persistence_failed'
  resume_instruction: string | null
  proof_issues: Record<string, string[]>
  blockers: string[]
}

export async function evaluateLoopContinuation(input: {
  root: string
  missionId: string
  maxContinuationTurns?: number
}): Promise<LoopContinuationReport> {
  const root = path.resolve(input.root || process.cwd())
  const plan = await readJson<unknown>(loopPlanPath(root, input.missionId), null)
  const reportPath = path.join(root, '.sneakoscope', 'missions', input.missionId, 'loop-continuation-enforcer.json')
  const previous = await readJson<Partial<LoopContinuationReport> | null>(reportPath, null)
  const blockers: string[] = []
  if (!plan) blockers.push('loop_plan_missing')
  const nodes = loopNodes(plan)
  if (plan && nodes.length === 0) blockers.push('loop_plan_empty')
  const proofs = await Promise.all(nodes.map((node) => readJson<unknown>(path.join(root, '.sneakoscope', 'missions', input.missionId, 'loops', node.loop_id, 'loop-proof.json'), null)))
  const proofIssues = Object.fromEntries(nodes.map((node, index) => [
    node.loop_id,
    loopProofCompletionIssues(proofs[index])
  ]))
  const completed = Object.values(proofIssues).filter((issues) => issues.length === 0).length
  const incomplete = Math.max(0, nodes.length - completed)
  for (const [loopId, issues] of Object.entries(proofIssues)) {
    if (issues.length > 0) blockers.push(`loop_proof_unverified:${loopId}`)
  }
  const maxContinuationTurns = boundedContinuationTurns(input.maxContinuationTurns)
  const progressFingerprint = executionProgressFingerprint({
    nodes: nodes.map((node) => ({ loop_id: node.loop_id, issues: proofIssues[node.loop_id] || [] }))
  })
  const continuationTurn = previous?.progress_fingerprint === progressFingerprint
    ? Math.max(0, Number(previous.continuation_turn || 0)) + 1
    : incomplete > 0 ? 1 : 0
  const planUsable = Boolean(plan && nodes.length > 0)
  const budgetExhausted = planUsable && incomplete > 0 && continuationTurn > maxContinuationTurns
  if (budgetExhausted) blockers.push('loop_continuation_budget_exhausted')
  const shouldContinue = planUsable && incomplete > 0 && !budgetExhausted
  const stopReason: LoopContinuationReport['stop_reason'] = !plan
    ? 'loop_plan_missing'
    : nodes.length === 0
      ? 'loop_plan_empty'
      : incomplete === 0
        ? 'all_loop_proofs_verified'
        : budgetExhausted
          ? 'continuation_budget_exhausted'
          : 'loop_proof_unverified'
  const report: LoopContinuationReport = {
    schema: 'sks.loop-continuation-enforcer.v1',
    generated_at: nowIso(),
    ok: stopReason === 'all_loop_proofs_verified',
    mission_id: input.missionId,
    nodes: nodes.length,
    completed,
    incomplete,
    max_continuation_turns: maxContinuationTurns,
    continuation_turn: continuationTurn,
    progress_fingerprint: progressFingerprint,
    should_continue: shouldContinue,
    terminal_blocked: !shouldContinue && stopReason !== 'all_loop_proofs_verified',
    stop_reason: stopReason,
    resume_instruction: shouldContinue ? `sks loop resume ${input.missionId}` : null,
    proof_issues: proofIssues,
    blockers: [...new Set(blockers)]
  }
  try {
    await writeJsonAtomic(reportPath, report)
    return report
  } catch {
    return {
      ...report,
      ok: false,
      should_continue: false,
      terminal_blocked: true,
      stop_reason: 'execution_control_persistence_failed',
      resume_instruction: null,
      blockers: [...new Set([...report.blockers, 'loop_continuation_state_persistence_failed'])]
    }
  }
}

function boundedContinuationTurns(value: unknown) {
  const parsed = Number(value ?? 3)
  if (!Number.isFinite(parsed)) return 3
  return Math.max(1, Math.min(20, Math.floor(parsed)))
}

function loopNodes(value: unknown): Array<{ loop_id: string }> {
  if (!isRecord(value) || !isRecord(value.graph) || !Array.isArray(value.graph.nodes)) return []
  return value.graph.nodes
    .filter((node): node is { loop_id: string } => isRecord(node) && typeof node.loop_id === 'string')
}
