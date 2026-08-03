import path from 'node:path'
import { nowIso, readJson, readText, writeJsonAtomic } from '../fsx.js'

export const NO_SUBAGENT_SCALING_POLICY_SCHEMA = 'sks.no-subagent-scaling-policy.v1'

export async function writeNoSubagentScalingPolicy(root: string, input: { nativeProof?: any; officialSubagentHelperPolicy?: any } = {}) {
  const nativeProof = input.nativeProof || await readJson<any>(path.join(root, 'native-cli-worker-runtime-proof.json'), null)
  const officialSubagentHelperPolicy = input.officialSubagentHelperPolicy || await readJson<any>(path.join(root, 'official-subagent-helper-policy.json'), null)
  const runtime = await readJson<any>(path.join(root, 'native-cli-worker-runtime.json'), null)
  const events = await readText(path.join(root, 'agent-events.jsonl'), '')
  const subagentEventCount = String(events).split(/\n/).filter((line) => /Subagent(Start|Stop)|subagent/i.test(line)).length
  const nativeProcessCount = Number(nativeProof?.spawned_worker_process_count || runtime?.spawned_worker_process_count || 0)
  const allowedScalingPrimitives = new Set(['native_cli_process'])
  const blockers = [
    ...(allowedScalingPrimitives.has(String(runtime?.scaling_primitive || '')) ? [] : ['main_scaling_primitive_not_native_cli_process']),
    ...(nativeProcessCount > 0 ? [] : ['native_cli_worker_process_proof_missing']),
    ...(nativeProof?.worker_proof_is_only_subagent_events === true ? ['worker_proof_only_subagent_events'] : []),
    ...(officialSubagentHelperPolicy?.ok === false ? officialSubagentHelperPolicy.blockers || ['official_subagent_helper_policy_not_ok'] : [])
  ]
  const report = {
    schema: NO_SUBAGENT_SCALING_POLICY_SCHEMA,
    generated_at: nowIso(),
    ok: blockers.length === 0,
    main_orchestrator_scaling_primitive: runtime?.scaling_primitive || 'native_cli_process',
    subagent_events_counted_as_worker_sessions: false,
    scout_events_counted_as_worker_sessions: false,
    worker_internal_scout_usage_allowed_as_helper_only: true,
    official_codex_subagent_helper_lane_allowed: officialSubagentHelperPolicy?.ok !== false,
    official_codex_subagent_helper_policy: officialSubagentHelperPolicy ? 'official-subagent-helper-policy.json' : null,
    official_helper_lane_worker_capacity_credit: 0,
    official_helper_lane_observed_subagent_event_count: Number(officialSubagentHelperPolicy?.observed_subagent_event_count || 0),
    official_helper_lane_events_counted_as_worker_sessions: false,
    codex_builtin_capability_lane_allowed: officialSubagentHelperPolicy?.official_codex_subagent_helper_lane_enabled === true,
    codex_builtin_imagegen_helper_allowed: officialSubagentHelperPolicy?.codex_builtin_imagegen_helper_allowed === true,
    native_worker_process_count: nativeProcessCount,
    subagent_event_count: subagentEventCount,
    worker_process_proof: 'native-cli-worker-runtime-proof.json',
    runtime_proof: 'native-cli-worker-runtime.json',
    runtime_truth_row: 'native_cli_worker_runtime',
    blockers
  }
  await writeJsonAtomic(path.join(root, 'no-subagent-scaling-policy.json'), report)
  return report
}
