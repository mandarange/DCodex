#!/usr/bin/env node
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { assertGate, emitGate, importDist } from './gate-lib.js'

const missionMod = await importDist('core/mission.js')
const capMod = await importDist('core/mad-sks/sql-plane/capability.js')
const runtimeMod = await importDist('core/mad-sks/sql-plane/runtime-profile.js')
const coordinatorMod = await importDist('core/mad-sks/sql-plane/coordinator.js')
const db = await importDist('core/db-safety.js')
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sks-mad-sks-sql-plane-matrix-'))
const mission = await missionMod.createMission(root, { mode: 'mad-sks', prompt: 'fixture' })
const madSksState = { mission_id: mission.id, mode: 'MADSKS', mad_sks_active: true, mad_sks_gate_file: 'mad-sks-gate.json' }
fs.writeFileSync(path.join(mission.dir, 'mad-sks-gate.json'), JSON.stringify({ passed: false, permissions_deactivated: false }, null, 2))
const catastrophic = await db.checkDbOperation(root, madSksState, { tool_name: 'supabase.execute_sql', sql: 'truncate users;' })
assertGate(catastrophic.allowed === false && catastrophic.reasons.includes('mad_sks_catastrophic_db_operation_blocked'), 'MAD-SKS catastrophic guard must remain without active sql-plane capability', catastrophic)

const prepared = await coordinatorMod.prepareMadSksSqlPlaneMission({
  root,
  task: '$MAD-SKS truncate users',
  args: ['--project-ref', 'fixture-project-ref', '--target', 'preview'],
  verifyTools: false,
  route: 'MadSKS',
  routeCommand: '$MAD-SKS'
})
const activeState = {
  mission_id: prepared.mission_id,
  mode: 'MADSKS',
  route: 'MadSKS',
  route_command: '$MAD-SKS',
  mad_sks_active: true,
  mad_sks_sql_plane_active: true,
  mad_sks_sql_plane_capability_mission_id: prepared.mission_id,
  mad_sks_sql_plane_cycle_id: prepared.cycle_id,
  mad_sks_sql_plane_runtime_session_id: prepared.capability.runtime_session_id,
  mad_sks_sql_plane_profile_sha256: prepared.runtime_profile.profile_sha256,
  mad_sks_gate_file: 'mad-sks-gate.json'
}
const sqlPlane = await db.checkDbOperation(root, activeState, { tool_name: 'supabase.execute_sql', tool_call_id: 'matrix-truncate-active', sql: 'truncate users;' })
assertGate(sqlPlane.allowed === true && sqlPlane.mad_sks_sql_plane?.active === true, 'MAD-SKS SQL-plane capability must authorize the bounded SQL-plane cycle', sqlPlane)
await runtimeMod.closeMadSksSqlPlaneRuntimeProfile({ root, missionId: prepared.mission_id, reason: 'matrix-cycle-close' })
await capMod.closeMadSksSqlPlaneCycle(root, prepared.mission_id, prepared.cycle_id, 'matrix-cycle-close')
const afterClose = await db.checkDbOperation(root, { ...activeState, mad_sks_sql_plane_active: false, mad_sks_active: false }, { tool_name: 'supabase.execute_sql', tool_call_id: 'matrix-truncate-closed', sql: 'truncate users;' })
assertGate(afterClose.allowed === false, 'after bounded sql-plane close, MAD-SKS catastrophic guard must block again', afterClose)
emitGate('mad-sks-sql-plane:safety-conflict-matrix', { states: ['mad-sks-blocks-without-sql-plane', 'mad-sks-sql-plane-allows-cycle', 'mad-sks-blocks-after-cycle-close'] })
