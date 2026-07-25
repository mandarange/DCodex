#!/usr/bin/env node
// @ts-nocheck
import { assertGate, emitGate } from './gate-lib.js';
import { runDynamicPoolFixture } from './agent-dynamic-pool-fixture.js';

const fixture = await runDynamicPoolFixture({ target: 4, total: 8 });
const backfills = fixture.events.filter((event) => event.event_type === 'backfill_event');
const firstSlowCompletionIndex = fixture.events.findIndex((event) => event.event_type === 'session_completed' && /work-00[3-5]/.test(String(event.work_item_id || '')));
const secondBackfillIndex = fixture.events.findIndex((event, index) => index > fixture.events.findIndex((row) => row.event_type === 'backfill_event') && event.event_type === 'backfill_event');
assertGate(backfills.length >= 2, 'two early completions must create two backfill events', { backfills });
assertGate(secondBackfillIndex >= 0 && (firstSlowCompletionIndex < 0 || secondBackfillIndex < firstSlowCompletionIndex), 'replacement sessions must launch before the remaining first wave drains', { firstSlowCompletionIndex, secondBackfillIndex });
assertGate(fixture.result.state.backfill_count >= fixture.result.state.expected_backfill_count, 'backfill count must satisfy expected backfills', fixture.result.state);
emitGate('agent:backfill-replenishment', { backfill_count: fixture.result.state.backfill_count, expected_backfill_count: fixture.result.state.expected_backfill_count });
