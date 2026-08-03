#!/usr/bin/env node
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { madHighCommand } from '../core/commands/mad-sks-command.js'
import { checkDbOperation } from '../core/db-safety.js'
import { assertGate, emitGate } from './gate-lib.js'

const original = {
  cwd: process.cwd(),
  home: process.env.HOME,
  codexHome: process.env.CODEX_HOME,
  skipNpm: process.env.SKS_SKIP_NPM_FRESHNESS_CHECK,
  updateNotice: process.env.SKS_DISABLE_UPDATE_NOTICE,
  exitCode: process.exitCode
}

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'sks-mad-sks-sql-plane-boundary-'))
const home = path.join(tmp, 'home')
const codexHome = path.join(home, '.codex')
const projectCodexDir = path.join(tmp, '.codex')
const configText = [
  'service_tier = "fast"',
  '[features]',
  'fast_mode = true',
  ''
].join('\n')

try {
  await fs.mkdir(codexHome, { recursive: true })
  await fs.mkdir(projectCodexDir, { recursive: true })
  await fs.mkdir(path.join(tmp, '.sneakoscope'), { recursive: true })
  await fs.writeFile(path.join(codexHome, 'config.toml'), configText)
  await fs.writeFile(path.join(projectCodexDir, 'config.toml'), configText)

  process.chdir(tmp)
  process.env.HOME = home
  process.env.CODEX_HOME = codexHome
  process.env.SKS_SKIP_NPM_FRESHNESS_CHECK = '1'
  process.env.SKS_DISABLE_UPDATE_NOTICE = '1'
  process.exitCode = 0

  const launch: any = await madHighCommand([], {
    maybePromptSksUpdateForLaunch: async () => ({ status: 'skipped' }),
    maybePromptCodexUpdateForLaunch: async () => ({ status: 'skipped' }),
    ensureMadLaunchDependencies: async () => ({ ready: true, actions: [] }),
    maybePromptCodexLbSetupForLaunch: async () => ({ status: 'skipped' })
  })
  assertGate(launch?.ok === true && launch.status === 'native-codex-ready', 'sks --mad fixture launch must prepare the native Codex session', launch)

  const state = await readJson(path.join(tmp, '.sneakoscope', 'state', 'current.json'))
  assert.equal(state.mad_sks_active, true)
  assert.notEqual(state.mad_sks_sql_plane_active, true)
  assert.equal(state.mad_sks_sql_plane_capability_mission_id, undefined)

  const missionDir = path.join(tmp, '.sneakoscope', 'missions', state.mission_id)
  await assertMissing(path.join(missionDir, 'mad-sks', 'sql-plane', 'capability.json'), 'bare sks --mad must not create a SQL-plane capability')
  await assertMissing(path.join(missionDir, 'mad-sks-launch-grants.json'), 'bare sks --mad must not create SQL-plane grant artifacts')

  const decision: any = await checkDbOperation(tmp, state, {
    tool_name: 'supabase.execute_sql',
    tool_call_id: 'mad-sks-default-does-not-open-sql-plane',
    sql: 'truncate sks_mad_sks_sql_plane_probe;'
  })
  assertGate(decision.allowed === false && decision.mad_sks_sql_plane?.active !== true, 'sks --mad default must not satisfy the SQL-plane mutation policy locally', decision)

  emitGate('mad-sks:launch-sql-plane-boundary', {
    mission_id: state.mission_id,
    default_sql_plane_active: state.mad_sks_sql_plane_active === true,
    standalone_launch_did_not_create_sql_plane_capability: true
  })
} finally {
  process.chdir(original.cwd)
  restoreEnv('HOME', original.home)
  restoreEnv('CODEX_HOME', original.codexHome)
  restoreEnv('SKS_SKIP_NPM_FRESHNESS_CHECK', original.skipNpm)
  restoreEnv('SKS_DISABLE_UPDATE_NOTICE', original.updateNotice)
  process.exitCode = original.exitCode
}

async function readJson(file: string) {
  return JSON.parse(await fs.readFile(file, 'utf8'))
}

async function assertMissing(file: string, message: string) {
  try {
    await fs.access(file)
    assertGate(false, message, { file })
  } catch (err: any) {
    if (err?.code === 'ENOENT') return
    throw err
  }
}

function restoreEnv(key: string, value: string | undefined) {
  if (value == null) delete process.env[key]
  else process.env[key] = value
}
