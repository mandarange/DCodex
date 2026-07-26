#!/usr/bin/env node
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createMission } from '../core/mission.js'
import { createMadSksSqlPlaneRuntimeProfile, closeMadSksSqlPlaneRuntimeProfile, verifyReadOnlyRestored } from '../core/mad-sks/sql-plane/runtime-profile.js'
import { assertGate, emitGate } from './gate-lib.js'

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sks-mad-sks-sql-plane-runtime-profile-'))
await fs.mkdir(path.join(root, '.codex'), { recursive: true })
await fs.writeFile(path.join(root, '.codex', 'config.toml'), [
  '[mcp_servers.supabase]',
  'url = "https://mcp.supabase.com/mcp?project_ref=fixture-project-ref&read_only=true"',
  ''
].join('\n'))
const mission = await createMission(root, { mode: 'mad-sks', prompt: 'runtime profile fixture' })
const profile = await createMadSksSqlPlaneRuntimeProfile({ root, missionId: mission.id, cycleId: 'runtime-profile-cycle', projectRef: 'fixture-project-ref', runtimeSessionId: 'runtime-profile-session' })
const profileText = await fs.readFile(path.join(root, profile.profile_path), 'utf8')
const beforeClose = await verifyReadOnlyRestored(root, profile.normal_config_hash_before, path.join(root, profile.profile_path))
const proof = await closeMadSksSqlPlaneRuntimeProfile({ root, missionId: mission.id, profile, reason: 'runtime_profile_lifecycle_check' })

assertGate(profileText.includes('features=database') && !profileText.includes('read_only=true'), 'runtime profile must be write-capable and database-scoped', { profileText })
assertGate(beforeClose.ok === false && beforeClose.blockers.includes('runtime_write_profile_still_exists'), 'open runtime profile must be detected before close', beforeClose)
assertGate(proof.ok === true && proof.persistent_supabase_read_only === true && proof.runtime_profile_exists === false, 'close must remove profile and prove persistent read-only restoration', proof)
emitGate('mad-sks-sql-plane:runtime-profile', { profile_sha256: profile.profile_sha256, restoration_ok: proof.ok })
