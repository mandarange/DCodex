#!/usr/bin/env node
// @ts-nocheck
import { assertGate, emitGate, readText } from './gate-lib.js';
import { runDynamicPoolFixture } from './agent-dynamic-pool-fixture.js';

const proofSource = readText('src/core/agents/agent-proof-evidence.ts');
for (const token of [
  'agent_work_queue_missing',
  'agent_scheduler_events_missing',
  'agent_worker_slots_missing',
  'agent_session_generations_missing',
  'scheduler_active_slots_not_zero_at_finalization',
  'scheduler_backfill_count_below_expected',
  'scheduler_max_observed_active_slots_mismatch',
  'terminal_close_report_count_below_generation_count'
]) {
  assertGate(proofSource.includes(token), `scheduler proof hardening missing ${token}`);
}
const fixture = await runDynamicPoolFixture({ target: 4, total: 8 });
assertGate(fixture.result.state.pending_queue_drained === true, 'positive scheduler fixture must drain', fixture.result.state);
assertGate(fixture.result.state.backfill_count >= fixture.result.state.expected_backfill_count, 'positive scheduler fixture must satisfy backfill invariant', fixture.result.state);
emitGate('agent:scheduler-proof-hardening', { checked_blockers: 8, backfill_count: fixture.result.state.backfill_count });
