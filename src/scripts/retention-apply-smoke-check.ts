#!/usr/bin/env node
// @ts-nocheck
import { assertGate, emitGate, importDist, root } from './gate-lib.js'

const { applyRetentionPlan, enforceRetention, retentionStatus } = await importDist('core/retention.js')
const planned = await enforceRetention(root, {
  dryRun: true,
  lightweight: true,
  skipStorageReport: true,
  policy: { max_tmp_age_hours: 999999, max_session_state_files: 1000000, prune_old_missions: false }
})
const applied = await applyRetentionPlan(root, {
  planHash: planned.plan.plan_hash,
  lightweight: true,
  skipStorageReport: true,
  policy: { max_tmp_age_hours: 999999, max_session_state_files: 1000000, prune_old_missions: false }
})
const status = await retentionStatus(root)
assertGate(applied.ok === true, 'retention apply smoke must accept matching dry-run plan hash', applied)
assertGate(status.mission_index?.ok !== false, 'retention apply smoke must keep status readable', status)
emitGate('retention:apply-smoke', { action_count: applied.action_count || 0, plan_hash: planned.plan.plan_hash })
