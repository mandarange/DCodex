#!/usr/bin/env node
// @ts-nocheck
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { checkDbOperation, madSksSqlPlaneLifecycleHookFromDecision } from '../core/db-safety.js'
import { evaluateHookPayload } from '../core/hooks-runtime.js'
import { createMadSksSqlPlaneCapability, MAD_SKS_SQL_PLANE_ACK } from '../core/mad-sks/sql-plane/capability.js'
import { createMission, missionDir } from '../core/mission.js'
import { assertGate, emitGate } from './gate-lib.js'

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sks-mad-sks-sql-plane-mcp-result-'))
const mission = await createMission(root, { mode: 'mad-sks', prompt: 'mcp result fixture' })
await createMadSksSqlPlaneCapability(root, { missionId: mission.id, ack: MAD_SKS_SQL_PLANE_ACK, ttlMs: 60000, projectRef: 'fixture-project-ref', status: 'active' })
const successPayload = { tool_name: 'supabase.execute_sql', tool_call_id: 'mcp-success-call', sql: 'insert into audit_log(id) values (1)' }
const successDecision = await checkDbOperation(root, { mission_id: mission.id }, successPayload)
const successHook = madSksSqlPlaneLifecycleHookFromDecision(successDecision)
assertGate(Boolean(successHook), 'MAD-SKS SQL-plane lifecycle hook missing before post-tool success result', successDecision)
await evaluateHookPayload('post-tool', { tool_name: successPayload.tool_name, tool_call_id: successHook.tool_call_id, success: true, row_count: 1 }, { root, state: { mission_id: mission.id } })
const failurePayload = { tool_name: 'supabase.execute_sql', tool_call_id: 'mcp-failure-call', sql: 'update audit_log set id = 2 where id = 1' }
const failureDecision = await checkDbOperation(root, { mission_id: mission.id }, failurePayload)
const failureHook = madSksSqlPlaneLifecycleHookFromDecision(failureDecision)
assertGate(Boolean(failureHook), 'MAD-SKS SQL-plane lifecycle hook missing before post-tool MCP isError result', failureDecision)
await evaluateHookPayload('post-tool', {
  tool_name: failurePayload.tool_name,
  tool_call_id: failureHook.tool_call_id,
  result: { isError: true, content: [{ type: 'text', text: 'fixture MCP error' }] }
}, { root, state: { mission_id: mission.id } })
const ledger = await fs.readFile(path.join(missionDir(root, mission.id), 'mad-sks', 'sql-plane', 'ledger.jsonl'), 'utf8')
assertGate(ledger.includes('db_operation.succeeded') && ledger.includes('db_operation.failed') && ledger.includes('fixture MCP error'), 'PostToolUse must append succeeded and MCP isError failed lifecycle events', { ledger })
emitGate('mad-sks:sql-plane-result-lifecycle', { success_operation_id: successHook.operation_id, failure_operation_id: failureHook.operation_id, status: 'succeeded_and_failed_checked' })
