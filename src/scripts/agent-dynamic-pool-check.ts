#!/usr/bin/env node
// @ts-nocheck
import { assertGate, emitGate } from './gate-lib.js';
import { runDynamicPoolFixture } from './agent-dynamic-pool-fixture.js';

const fixture = await runDynamicPoolFixture({ target: 8, total: 16 });
const state = fixture.result.state;
assertGate(fixture.result.ok === true, 'dynamic pool fixture must drain cleanly', state);
assertGate(state.target_active_slots === 8, 'target active slots must honor Naruto frame budget above four', state);
assertGate(state.max_observed_active_slots === 8, 'scheduler must observe eight active slots', state);
assertGate(state.pending_queue_drained === true, 'pending queue must drain', state);
assertGate(state.all_slots_closed_after_drain === true, 'all slots must close after drain', state);
emitGate('agent:dynamic-pool', { target_active_slots: state.target_active_slots, max_observed_active_slots: state.max_observed_active_slots, total_work_items: state.total_work_items });
