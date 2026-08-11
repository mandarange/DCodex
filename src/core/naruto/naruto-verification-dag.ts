import { buildVerificationDag, type VerificationDag } from '../verification/verification-dag.js'
import type { VerificationTask } from '../verification/verification-result.js'
import type { NarutoWorkGraph } from './naruto-work-item.js'

export type NarutoVerificationNodeKind =
  | 'typecheck_shard'
  | 'unit_test_shard'
  | 'route_gate_shard'
  | 'lint_static_scan_shard'
  | 'schema_validation_shard'
  | 'patch_specific_test_shard'
  | 'docs_changelog_check'
  | 'side_effect_check'
  | 'mutation_ledger_check'

export interface NarutoVerificationDag extends VerificationDag {
  schema: 'sks.verification-dag.v1'
  naruto_schema: 'sks.naruto-verification-dag.v1'
  node_kinds: NarutoVerificationNodeKind[]
  starts_when_dependencies_ready: true
  configured: boolean
  unconfigured_reason: string | null
}

const NODE_KIND_CYCLE: NarutoVerificationNodeKind[] = [
  'typecheck_shard',
  'unit_test_shard',
  'route_gate_shard',
  'lint_static_scan_shard',
  'schema_validation_shard',
  'patch_specific_test_shard',
  'docs_changelog_check',
  'side_effect_check',
  'mutation_ledger_check',
]

export function buildNarutoVerificationDag(graph: NarutoWorkGraph, input: { command?: string; cwd?: string } = {}): NarutoVerificationDag {
  const command = input.command || ''
  const verifiableItems = graph.work_items.filter((item) => item.verification_required)
  if (!command) {
    return {
      schema: 'sks.verification-dag.v1',
      tasks: [],
      naruto_schema: 'sks.naruto-verification-dag.v1',
      node_kinds: NODE_KIND_CYCLE,
      starts_when_dependencies_ready: true,
      configured: false,
      unconfigured_reason: 'no_verification_command_resolved_for_project'
    }
  }
  const taskIdByWorkItemId = new Map(verifiableItems.map((item, index) => [item.id, `NV-${String(index + 1).padStart(6, '0')}`]))
  const tasks: VerificationTask[] = verifiableItems
    .map((item, index) => {
      const kind = NODE_KIND_CYCLE[index % NODE_KIND_CYCLE.length] || 'route_gate_shard'
      const taskId = taskIdByWorkItemId.get(item.id) || `NV-${String(index + 1).padStart(6, '0')}`
      return {
        id: taskId,
        command,
        ...(input.cwd ? { cwd: input.cwd } : {}),
        inputs: [...item.target_paths],
        outputs: [`.sneakoscope/reports/naruto-verification/${item.id}.json`],
        dependencies: item.dependencies.map((dep) => taskIdByWorkItemId.get(dep)).filter((dep): dep is string => typeof dep === 'string' && dep !== taskId),
        timeout_ms: 60000,
        read_only: true
      }
    })
  const dag = buildVerificationDag(tasks)
  return {
    ...dag,
    naruto_schema: 'sks.naruto-verification-dag.v1',
    node_kinds: NODE_KIND_CYCLE,
    starts_when_dependencies_ready: true,
    configured: true,
    unconfigured_reason: null
  }
}
