#!/usr/bin/env node
// @ts-nocheck
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { assertGate, emitGate, importDist, root } from './gate-lib.js';

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'sks-official-subagent-helper-'));
const nativeProof = {
  schema: 'sks.native-cli-worker-runtime-proof.v1',
  ok: true,
  spawned_worker_process_count: 3,
  max_observed_worker_process_count: 3,
  unique_worker_session_count: 3,
  worker_proof_is_only_subagent_events: false,
  blockers: []
};
await fs.writeFile(path.join(tmp, 'native-cli-worker-runtime-proof.json'), `${JSON.stringify(nativeProof, null, 2)}\n`);
await fs.writeFile(path.join(tmp, 'native-cli-worker-runtime.json'), `${JSON.stringify({
  schema: 'sks.native-cli-worker-runtime.v2',
  ok: true,
  scaling_primitive: 'native_cli_process',
  spawned_worker_process_count: 3,
  process_ids: [101, 102, 103],
  blockers: []
}, null, 2)}\n`);
await fs.writeFile(path.join(tmp, 'agent-events.jsonl'), [
  JSON.stringify({ event_type: 'SubagentStart', agent_type: 'explorer' }),
  JSON.stringify({ event_type: 'SubagentStop', agent_type: 'explorer' })
].join('\n') + '\n');

const helperMod = await importDist('core/agents/official-subagent-helper-policy.js');
const noSubagentMod = await importDist('core/agents/no-subagent-scaling-policy.js');
const helper = await helperMod.writeOfficialSubagentHelperPolicy(tmp, { nativeProof });
const noSubagent = await noSubagentMod.writeNoSubagentScalingPolicy(tmp, { nativeProof, officialSubagentHelperPolicy: helper });

assertGate(helper.ok === true, 'official subagent helper policy must pass', helper);
assertGate(helper.official_codex_subagent_helper_lane_enabled === true, 'official helper lane must be enabled', helper);
assertGate(helper.helper_lane_may_run_in_parallel_with_native_workers === true, 'official helper lane must be parallel-capable', helper);
assertGate(helper.subagent_events_counted_as_worker_sessions === false, 'subagent helper events must not count as worker sessions', helper);
assertGate(helper.worker_capacity_credit === 0, 'official helper lane must have zero worker capacity credit', helper);
assertGate(helper.observed_subagent_event_count === 2, 'official helper lane must report observed subagent events without granting capacity', helper);
assertGate(helper.codex_builtin_imagegen_helper_allowed === true, 'Codex built-in imagegen helper must be allowed', helper);
assertGate(helper.codex_app_builtin_evidence_class === 'codex_app_builtin', 'Codex App builtin evidence class must be explicit', helper);
assertGate(helper.api_fallback_evidence_class === 'api_fallback', 'API fallback evidence class must be explicit', helper);
assertGate(helper.provider_surface_evidence_required === true, 'provider surface evidence must be required', helper);
assertGate(helper.imagegen_api_fallback_counts_as_codex_app_evidence === false, 'API fallback must not count as Codex App evidence', helper);
assertGate(Array.isArray(helper.required_output_proof_for_generated_images) && helper.required_output_proof_for_generated_images.includes('sha256'), 'image output proof must require hashes', helper);
assertGate(noSubagent.ok === true, 'no-subagent scaling policy must still pass with helper lane', noSubagent);
assertGate(noSubagent.official_codex_subagent_helper_lane_allowed === true, 'no-subagent policy must allow official helper lane', noSubagent);
assertGate(noSubagent.official_helper_lane_worker_capacity_credit === 0, 'no-subagent policy must keep helper worker capacity credit at zero', noSubagent);
assertGate(noSubagent.official_helper_lane_observed_subagent_event_count === 2, 'no-subagent policy must expose observed helper events separately', noSubagent);
assertGate(noSubagent.official_helper_lane_events_counted_as_worker_sessions === false, 'no-subagent policy must keep helper events out of worker sessions', noSubagent);
assertGate(noSubagent.subagent_events_counted_as_worker_sessions === false, 'no-subagent policy must keep subagent events out of worker counts', noSubagent);
assertGate(noSubagent.native_worker_process_count === 3, 'native worker count must come from native proof only', noSubagent);

const report = {
  schema: 'sks.agent-official-subagent-helper-policy-check.v1',
  ok: true,
  helper,
  no_subagent_scaling_policy: noSubagent,
  live_codex_app_output_proof_required_for_generated_images: true,
  live_codex_app_output_proof_ran: false,
  live_codex_app_output_proof_note: 'Deterministic release gate validates policy wiring only; generated image claims still require live Codex App output proof when enabled.'
};
await fs.mkdir(path.join(root, '.sneakoscope', 'reports'), { recursive: true });
await fs.writeFile(path.join(root, '.sneakoscope', 'reports', 'agent-official-subagent-helper-policy.json'), `${JSON.stringify(report, null, 2)}\n`);

emitGate('agent:official-subagent-helper-policy', {
  helper_lane_enabled: helper.official_codex_subagent_helper_lane_enabled,
  worker_capacity_credit: helper.worker_capacity_credit,
  subagent_events_counted_as_worker_sessions: helper.subagent_events_counted_as_worker_sessions,
  native_worker_process_count: noSubagent.native_worker_process_count,
  observed_subagent_event_count: helper.observed_subagent_event_count
});
