import path from 'node:path'
import { nowIso, readJson, writeJsonAtomic } from '../fsx.js'
import { loopPlanPath } from './loop-artifacts.js'
import { isRecord } from '../json/records.js'

interface LoopContinuationReport {
  schema: 'sks.loop-continuation-enforcer.v1'
  generated_at: string
  ok: boolean
  mission_id: string
  nodes: number
  completed: number
  incomplete: number
  max_continuation_turns: number
  should_continue: boolean
  resume_instruction: string | null
  blockers: string[]
}

export async function evaluateLoopContinuation(input: {
  root: string
  missionId: string
  maxContinuationTurns?: number
}): Promise<LoopContinuationReport> {
  const root = path.resolve(input.root || process.cwd())
  const plan = await readJson<unknown>(loopPlanPath(root, input.missionId), null)
  const blockers: string[] = []
  if (!plan) blockers.push('loop_plan_missing')
  const nodes = loopNodes(plan)
  const proofs = await Promise.all(nodes.map((node) => readJson<unknown>(path.join(root, '.sneakoscope', 'missions', input.missionId, 'loops', node.loop_id, 'loop-proof.json'), null)))
  const completed = proofs.filter((proof) => isRecord(proof) && proof.status === 'completed').length
  const incomplete = Math.max(0, nodes.length - completed)
  const shouldContinue = Boolean(plan && incomplete > 0 && blockers.length === 0)
  const report: LoopContinuationReport = {
    schema: 'sks.loop-continuation-enforcer.v1',
    generated_at: nowIso(),
    ok: blockers.length === 0,
    mission_id: input.missionId,
    nodes: nodes.length,
    completed,
    incomplete,
    max_continuation_turns: input.maxContinuationTurns || 3,
    should_continue: shouldContinue,
    resume_instruction: shouldContinue ? `sks loop resume ${input.missionId}` : null,
    blockers
  }
  await writeJsonAtomic(path.join(root, '.sneakoscope', 'missions', input.missionId, 'loop-continuation-enforcer.json'), report).catch(() => undefined)
  return report
}

function loopNodes(value: unknown): Array<{ loop_id: string }> {
  if (!isRecord(value) || !isRecord(value.graph) || !Array.isArray(value.graph.nodes)) return []
  return value.graph.nodes
    .filter((node): node is { loop_id: string } => isRecord(node) && typeof node.loop_id === 'string')
}
