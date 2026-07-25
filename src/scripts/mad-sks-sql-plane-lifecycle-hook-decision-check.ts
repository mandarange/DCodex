#!/usr/bin/env node
// @ts-nocheck
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { checkDbOperation, madSksSqlPlaneLifecycleHookFromDecision } from '../core/db-safety.js'
import { createMadSksSqlPlaneCapability, MAD_SKS_SQL_PLANE_ACK } from '../core/mad-sks/sql-plane/capability.js'
import { createMission } from '../core/mission.js'
import { assertGate, emitGate } from './gate-lib.js'

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sks-mad-sks-sql-plane-hook-decision-'))
const mission = await createMission(root, { mode: 'mad-sks', prompt: 'hook fixture' })
await createMadSksSqlPlaneCapability(root, { missionId: mission.id, ack: MAD_SKS_SQL_PLANE_ACK, ttlMs: 60000, projectRef: 'fixture-project-ref', status: 'active' })
const decision = await checkDbOperation(root, { mission_id: mission.id }, { tool_name: 'supabase.execute_sql', tool_call_id: 'hook-decision-call-1', sql: 'insert into audit_log(id) values (1)' })
const hook = madSksSqlPlaneLifecycleHookFromDecision(decision)
assertGate(decision.allowed === true && decision.mad_sks_sql_plane?.lifecycle_result_pending === true, 'MAD-SKS SQL-plane decision must mark pending lifecycle result', decision)
assertGate(Boolean(hook?.mission_id === mission.id && hook?.operation_id && hook?.tool_call_id === 'hook-decision-call-1' && hook?.cycle_id && hook?.tool_name), 'MAD-SKS SQL-plane decision must expose canonical tool_call_id ledger result hook', { decision, hook })
emitGate('mad-sks:sql-plane-lifecycle-hook-decision', { operation_id: hook.operation_id, cycle_id: hook.cycle_id })
