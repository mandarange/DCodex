#!/usr/bin/env node
// @ts-nocheck
import { assertGate, emitGate, importDist } from './gate-lib.js';

const mod = await importDist('core/codex-control/codex-reliability-shield.js');
const audit = mod.auditToolOutputContinuity([
  { type: 'thread.started' },
  { type: 'item.completed', item: { id: 'call-1', call_id: 'call-1', type: 'custom_tool_call', name: 'fixture' } },
  { type: 'item.completed', item: { id: 'call-2', call_id: 'call-2', type: 'custom_tool_call', name: 'fixture' } },
  { type: 'item.completed', item: { call_id: 'call-1', type: 'custom_tool_call_output', output: 'ok' } }
]);
assertGate(audit.missingToolResultCount === 1, 'one missing custom tool output must be detected', audit);
assertGate(audit.missingToolCallIds.includes('call-2'), 'missing custom tool call id not reported', audit);
assertGate(!audit.events.some((event) => event.type === 'tool_result.stubbed'), 'continuity audit must never fabricate a tool output', audit);
const rolloutAudit = mod.auditToolOutputContinuity([
  { type: 'response_item', payload: { type: 'custom_tool_call', call_id: 'rollout-call-1', name: 'fixture' } },
  { type: 'rollout_record', response_item: { payload: { type: 'custom_tool_call', call_id: 'rollout-call-2', name: 'fixture' } } },
  { type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: 'rollout-call-1', output: 'ok' } }
]);
assertGate(rolloutAudit.missingToolResultCount === 1, 'persisted response_item rollout envelopes must be audited', rolloutAudit);
assertGate(rolloutAudit.missingToolCallIds.includes('rollout-call-2'), 'rollout envelope missing call id not reported', rolloutAudit);
emitGate('codex-control:tool-output-continuity-audit', {
  status: 'fail_closed_audit',
  fabricated_tool_result_count: 0,
  missing_tool_result_count: audit.missingToolResultCount,
  rollout_missing_tool_result_count: rolloutAudit.missingToolResultCount
});
