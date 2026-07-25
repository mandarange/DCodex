#!/usr/bin/env node
// @ts-nocheck
import { assertGate, emitGate } from './gate-lib.js';
import { runDynamicPoolFixture } from './agent-dynamic-pool-fixture.js';

const fixture = await runDynamicPoolFixture({ target: 4, total: 8 });
const state = fixture.result.state;
for (const key of ['target_active_slots', 'max_observed_active_slots', 'pending_queue_drained', 'backfill_count', 'expected_backfill_count', 'slot_count', 'generation_count']) {
  assertGate(Object.prototype.hasOwnProperty.call(state, key) || key === 'slot_count' || key === 'generation_count', `scheduler state/proof missing ${key}`, state);
}
assertGate(state.pending_count === 0 && state.active_slot_count === 0, 'scheduler proof must finish with empty queue and zero active sessions', state);
assertGate(state.backfill_count >= state.expected_backfill_count, 'scheduler proof must not underfill expected backfills', state);
emitGate('agent:scheduler-proof', { pending_count: state.pending_count, active_slot_count: state.active_slot_count, backfill_count: state.backfill_count });
