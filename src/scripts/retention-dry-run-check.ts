#!/usr/bin/env node
// @ts-nocheck
import { assertGate, emitGate, importDist, root } from './gate-lib.js'

const { enforceRetention, retentionStatus } = await importDist('core/retention.js')
const result = await enforceRetention(root, { dryRun: true, lightweight: true, skipStorageReport: true })
const status = await retentionStatus(root)
assertGate(Boolean(result.plan?.plan_hash), 'retention dry run must write a plan hash', result)
assertGate(status.mission_index?.ok !== false, 'retention dry run must keep mission index readable', status)
emitGate('retention:dry-run', { action_count: result.actions.length, plan_hash: result.plan.plan_hash })
