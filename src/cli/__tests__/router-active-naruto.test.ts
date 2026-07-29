import test from 'node:test'
import assert from 'node:assert/strict'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { dispatch, safeActiveRouteContinuation, safeReadOnlySubcommand } from '../router.js'

test('active Naruto permits only its read-only observation subcommands', () => {
  for (const subcommand of ['status', 'subagents', 'proof']) {
    assert.equal(safeReadOnlySubcommand('naruto', [subcommand, 'latest', '--json']), true, subcommand)
  }
  assert.equal(safeReadOnlySubcommand('naruto', ['workers', 'latest', '--json']), false)
  assert.equal(safeReadOnlySubcommand('naruto', ['run', 'task']), false)
  assert.equal(safeReadOnlySubcommand('naruto', ['proof', 'latest', '--write']), false)
  assert.equal(safeReadOnlySubcommand('naruto', ['--json', 'status', 'latest']), false)
  assert.equal(safeReadOnlySubcommand('naruto', ['--agents=8', 'status']), false)
  assert.equal(safeReadOnlySubcommand('naruto', ['--max-threads=12', 'proof', 'latest']), false)
})

test('SKS Center nested read probes skip migration-blocking classification', () => {
  assert.equal(safeReadOnlySubcommand('mcp', ['config', 'list', '--scope', 'effective', '--json']), true)
  assert.equal(safeReadOnlySubcommand('mcp', ['config', 'test', 'context7', '--json']), true)
  assert.equal(safeReadOnlySubcommand('mcp', ['config', 'backups', '--scope', 'global', '--json']), true)
  assert.equal(safeReadOnlySubcommand('mcp', ['config', 'add', '--stdin-json', '--json']), false)
  assert.equal(safeReadOnlySubcommand('mcp', ['config', 'edit', 'x', '--fix', '--json']), false)
  assert.equal(safeReadOnlySubcommand('remote', ['readiness', '--json']), true)
  assert.equal(safeReadOnlySubcommand('remote', ['status', '--json']), true)
  assert.equal(safeReadOnlySubcommand('remote', ['run', '--fix']), false)
})

test('active Naruto admits only explicit same-mission run and parent-summary continuations', () => {
  const state = {
    mission_id: 'M-active',
    mode: 'NARUTO',
    phase: 'NARUTO_DELEGATION_CONTEXT_READY',
    route_closed: false
  }
  assert.equal(safeActiveRouteContinuation('naruto', ['run', 'task', '--mission', 'M-active'], state), true)
  assert.equal(safeActiveRouteContinuation('naruto', ['run', 'task', '--mission=M-active'], state), true)
  assert.equal(safeActiveRouteContinuation('naruto', ['run', 'task', '--mission', 'latest'], state), true)
  assert.equal(safeActiveRouteContinuation('naruto', ['run', 'task', '--mission', 'M-other'], state), false)
  assert.equal(safeActiveRouteContinuation('naruto', ['run', 'task'], state), false)
  assert.equal(safeActiveRouteContinuation('naruto', ['proof', 'M-active'], state), false)
  assert.equal(safeActiveRouteContinuation('naruto', ['parent-summary', '--mission', 'M-active', '--stdin'], state), true)
  assert.equal(safeActiveRouteContinuation('naruto', ['parent-summary', '--mission=M-active', '--stdin', '--json'], state), true)
  assert.equal(safeActiveRouteContinuation('naruto', ['parent-summary', '--mission', 'M-active'], state), false)
  assert.equal(safeActiveRouteContinuation('naruto', ['parent-summary', '--mission', 'latest', '--stdin'], state), false)
  assert.equal(safeActiveRouteContinuation('naruto', ['parent-summary', '--mission', 'M-other', '--stdin'], state), false)
  assert.equal(safeActiveRouteContinuation('naruto', ['parent-summary', '--mission-id', 'M-active', '--stdin'], state), false)
})

test('active Image UX Review admits only explicit same-mission continuation actions', () => {
  const state = {
    mission_id: 'M-active',
    route: 'ImageUXReview',
    phase: 'IMAGE_UX_REVIEW_READY',
    route_closed: false
  }
  for (const action of ['attach-generated', 'attach-after', 'fix', 'recapture', 'recheck', 'proof']) {
    assert.equal(safeActiveRouteContinuation('image-ux-review', [action, 'M-active', '--json'], state), true, action)
    assert.equal(safeActiveRouteContinuation('image-ux-review', [action, 'M-other', '--json'], state), false, action)
  }
  assert.equal(safeActiveRouteContinuation('image-ux-review', ['run', '--mission', 'M-active', '--json'], state), true)
  assert.equal(safeActiveRouteContinuation('image-ux-review', ['extract-issues', '--mission=M-active', '--json'], state), true)
  assert.equal(safeActiveRouteContinuation('image-ux-review', ['proof', 'latest', '--json'], state), true)
  assert.equal(safeActiveRouteContinuation('image-ux-review', ['proof', '--json'], state), false)
  assert.equal(safeActiveRouteContinuation('image-ux-review', ['fixture', 'M-active', '--json'], state), false)
  assert.equal(safeActiveRouteContinuation('image-ux-review', ['proof', 'M-active'], { ...state, route: 'Naruto' }), false)
})

test('active non-Naruto route admits only an exact same-mission parent summary', () => {
  const state = {
    mission_id: 'M-active',
    route: 'ImageUXReview',
    phase: 'IMAGE_UX_REVIEW_READY',
    route_closed: false
  }
  assert.equal(safeActiveRouteContinuation('naruto', ['parent-summary', '--mission', 'M-active', '--stdin', '--json'], state), true)
  assert.equal(safeActiveRouteContinuation('naruto', ['parent-summary', '--mission=M-active', '--stdin'], state), true)
  assert.equal(safeActiveRouteContinuation('naruto', ['parent-summary', '--mission', 'M-active'], state), false)
  assert.equal(safeActiveRouteContinuation('naruto', ['parent-summary', '--mission', 'M-other', '--stdin'], state), false)
  assert.equal(safeActiveRouteContinuation('naruto', ['run', 'task', '--mission', 'M-active'], state), false)
})

test('Naruto observation dispatch skips migration repair and remains read-only', async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'sks-router-naruto-readonly-'))
  const oldCwd = process.cwd()
  const oldHome = process.env.HOME
  const oldCodexHome = process.env.CODEX_HOME
  const oldRequireReceipt = process.env.SKS_REQUIRE_UPDATE_MIGRATION_RECEIPT
  const oldDoctorFail = process.env.SKS_TEST_DOCTOR_FAIL
  const oldThreadId = process.env.CODEX_THREAD_ID
  const oldLog = console.log
  const oldError = console.error
  const oldExitCode = process.exitCode
  try {
    await fsp.mkdir(path.join(root, '.sneakoscope', 'state'), { recursive: true })
    await fsp.writeFile(path.join(root, '.sneakoscope', 'state', 'current.json'), '{"mode":"IDLE","phase":"IDLE"}\n')
    process.chdir(root)
    process.env.HOME = path.join(root, 'home')
    process.env.CODEX_HOME = path.join(root, 'home', '.codex')
    process.env.SKS_REQUIRE_UPDATE_MIGRATION_RECEIPT = '1'
    process.env.SKS_TEST_DOCTOR_FAIL = '1'
    delete process.env.CODEX_THREAD_ID
    console.log = () => undefined
    console.error = () => undefined
    process.exitCode = undefined

    const result: any = await dispatch(['naruto', 'status', 'latest', '--json'])
    assert.equal(result.status, 'missing_mission')
    await assert.rejects(fsp.access(path.join(root, '.sneakoscope', 'missions')))
    await assert.rejects(fsp.access(path.join(root, '.sneakoscope', 'update', 'doctor-migration.json')))
  } finally {
    process.chdir(oldCwd)
    restoreEnv('HOME', oldHome)
    restoreEnv('CODEX_HOME', oldCodexHome)
    restoreEnv('SKS_REQUIRE_UPDATE_MIGRATION_RECEIPT', oldRequireReceipt)
    restoreEnv('SKS_TEST_DOCTOR_FAIL', oldDoctorFail)
    restoreEnv('CODEX_THREAD_ID', oldThreadId)
    console.log = oldLog
    console.error = oldError
    process.exitCode = oldExitCode
    await fsp.rm(root, { recursive: true, force: true })
  }
})

function restoreEnv(name: string, value: string | undefined) {
  if (value === undefined) delete process.env[name]
  else process.env[name] = value
}
