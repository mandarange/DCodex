#!/usr/bin/env node
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { assertGate, emitGate, importDist } from './gate-lib.js'

const missionMod = await importDist('core/mission.js')
const capMod = await importDist('core/mad-sks/sql-plane/capability.js')
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sks-mad-sks-sql-plane-cap-'))
const mission = await missionMod.createMission(root, { mode: 'mad-sks', prompt: 'fixture' })
const cap = await capMod.createMadSksSqlPlaneCapability(root, {
  missionId: mission.id,
  ack: capMod.MAD_SKS_SQL_PLANE_ACK,
  cwd: root,
  projectRef: 'fixture-project-ref',
  runtimeSessionId: 'fixture-session',
  profilePath: '.sneakoscope/missions/M/mad-sks/sql-plane/runtime/codex-mad-sks-sql-plane.config.toml',
  profileSha256: 'fixture-profile-sha',
  status: 'active'
})
assertGate(cap.schema === capMod.MAD_SKS_SQL_PLANE_CAPABILITY_SCHEMA, 'MAD-SKS SQL-plane capability schema mismatch', cap)
assertGate(cap.revision === 1 && cap.status === 'active', 'MAD-SKS SQL-plane capability must start as one current active capability revision', cap)
assertGate(cap.project_ref === 'fixture-project-ref' && cap.runtime_session_id === 'fixture-session' && cap.transport.profile_sha256 === 'fixture-profile-sha', 'MAD-SKS SQL-plane capability v2 must bind project/session/profile', cap)
assertGate(cap.scope.sql_plane === 'all_mutations' && cap.scope.control_plane === 'deny' && cap.scope.operations.includes('truncate'), 'MAD-SKS SQL-plane capability v2 must authorize SQL-plane operation classes only', cap)
assertGate(capMod.isMadSksSqlPlaneCapabilityActive(cap) === true, 'MAD-SKS SQL-plane capability must be active before consumption', cap)
emitGate('mad-sks:sql-plane-capability', { mission_id: mission.id, cycle_id: cap.cycle_id })
