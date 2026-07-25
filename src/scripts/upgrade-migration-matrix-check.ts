#!/usr/bin/env node
// @ts-nocheck
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { assertGate, emitGate, root } from './gate-lib.js'
import { seedUpgradeMigrationFixture } from '../core/ops/upgrade-migration-fixtures.js'

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'sks-upgrade-migration-matrix-'))
const projectRoot = path.join(tmp, 'project')

try {
  const fixtures = await seedUpgradeMigrationFixture(projectRoot)
  const safetyBaseline = await captureSafetyBaseline(fixtures)
  const commands = [
    ['doctor', '--full', '--json'],
    ['doctor', '--fix', '--yes', '--json'],
    ['status', '--json'],
    ['route', 'status', '--json'],
    ['super-search', 'sources', 'latest', '--json'],
    ['seo-geo-optimizer', 'status', 'latest', '--json'],
    ['gc', 'plan', '--json']
  ]
  const repairChecks = commands.slice(0, 2).map((argv) => runCommand(argv))
  const migrationPostcondition = await inspectRetiredOperationalResidue(fixtures)
  const checks = [
    ...repairChecks,
    ...commands.slice(2).map((argv) => runCommand(argv))
  ]
  const safetyPostcondition = await inspectSafetyPostcondition(safetyBaseline)
  const doctorFix = repairChecks.find((check) => check.command === 'sks doctor --fix --yes --json')
  const blockers = [
    ...checks.filter((check) => check.panic).map((check) => `${check.command}:panic`),
    ...checks.filter((check) => check.json?.ok === true && Array.isArray(check.json?.blockers) && check.json.blockers.length).map((check) => `${check.command}:ok_true_with_blockers`),
    ...(!doctorFix?.ok ? ['doctor_fix_failed'] : []),
    ...migrationPostcondition.blockers,
    ...safetyBaseline.blockers,
    ...safetyPostcondition.blockers
  ]
  const explicitBlocked = checks.filter((check) => check.exit_code !== 0 && check.status === 'blocked')
  const report = {
    schema: 'sks.upgrade-migration-matrix.v1',
    ok: blockers.length === 0,
    generated_at: new Date().toISOString(),
    fixture_count: fixtures.length,
    fixture_labels: fixtures.map((fixture) => fixture.label),
    commands: checks,
    explicit_blocked_commands: explicitBlocked.map((check) => check.command),
    migration_postcondition: migrationPostcondition,
    safety_postcondition: safetyPostcondition,
    data_loss_detected: safetyPostcondition.data_loss_detected,
    user_owned_data_touched: safetyPostcondition.user_owned_data_touched,
    generated_legacy_cleanup_only: migrationPostcondition.ok && safetyPostcondition.ok,
    blockers
  }
  const reportPath = path.join(root, '.sneakoscope', 'reports', 'upgrade-migration-matrix.json')
  await fs.mkdir(path.dirname(reportPath), { recursive: true })
  await fs.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`)

  assertGate(report.ok, 'upgrade migration matrix failed', report)
  emitGate('upgrade:migration-matrix', { fixture_count: fixtures.length, report: reportPath.replace(`${root}/`, '') })
} finally {
  await fs.rm(tmp, { recursive: true, force: true }).catch(() => undefined)
}

function runCommand(argv) {
  const result = spawnSync(process.execPath, [path.join(root, 'dist', 'bin', 'sks.js'), ...argv], {
    cwd: projectRoot,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
    env: { ...process.env, SKS_DISABLE_NETWORK: '1', SKS_DISABLE_UPDATE_CHECK: '1', SKS_NO_QUESTION: '1' }
  })
  const json = parseJson(result.stdout)
  const output = `${result.stdout}\n${result.stderr}`
  return {
    command: `sks ${argv.join(' ')}`,
    exit_code: result.status,
    json_contract: Boolean(json),
    ok: result.status === 0,
    status: json?.status || (result.status === 0 ? 'passed' : output.includes('blocked') ? 'blocked' : 'failed'),
    schema: json?.schema || null,
    blockers: Array.isArray(json?.blockers) ? json.blockers : [],
    panic: /panic|UnhandledPromiseRejection|TypeError|ReferenceError/i.test(output),
    stdout_tail: result.stdout.slice(-1000),
    stderr_tail: result.stderr.slice(-1000)
  }
}

function parseJson(value) {
  try {
    return JSON.parse(value || '{}')
  } catch {
    return null
  }
}

async function inspectRetiredOperationalResidue(fixtures) {
  const retiredModes = new Set(['team', 'mad-db'])
  const retiredMissionIds = fixtures
    .filter((fixture) => retiredModes.has(String(fixture.mode || '').toLowerCase()))
    .map((fixture) => fixture.id)
  const survivingMissionIds = []
  for (const missionId of retiredMissionIds) {
    const missionRoot = path.join(projectRoot, '.sneakoscope', 'missions', missionId)
    if (await fs.access(missionRoot).then(() => true, () => false)) survivingMissionIds.push(missionId)
  }

  const listingErrors = []
  const indexFile = path.join(projectRoot, '.sneakoscope', 'missions', 'index.json')
  const operationalFiles = [
    ...(await listJsonFiles(path.join(projectRoot, '.sneakoscope', 'state'), listingErrors)),
    indexFile
  ]
  const missionRoot = path.join(projectRoot, '.sneakoscope', 'missions')
  let missionEntries = []
  try {
    missionEntries = await fs.readdir(missionRoot, { withFileTypes: true })
  } catch (error) {
    listingErrors.push(`${relative(missionRoot)}:${errorCode(error)}`)
  }
  for (const entry of missionEntries) {
    if (entry.isDirectory()) operationalFiles.push(path.join(missionRoot, entry.name, 'mission.json'))
  }

  const retiredIdentities = []
  const invalidJsonFiles = []
  const missingOperationalFiles = []
  for (const file of [...new Set(operationalFiles)]) {
    const result = await readJsonStrict(file)
    if (!result.ok) {
      invalidJsonFiles.push({ file: relative(file), error: result.error })
      continue
    }
    collectRetiredOperationalIdentities(result.value, file, retiredIdentities)
  }
  const index = await readJsonStrict(indexFile)
  if (!index.ok) missingOperationalFiles.push(relative(indexFile))
  else if (index.value?.schema !== 'sks.mission-index.v1' || !Array.isArray(index.value?.missions)) {
    invalidJsonFiles.push({ file: relative(indexFile), error: 'mission_index_schema_invalid' })
  }
  for (const fixture of fixtures.filter((fixture) => !retiredModes.has(String(fixture.mode || '').toLowerCase()))) {
    const missionFile = path.join(missionRoot, fixture.id, 'mission.json')
    const mission = await readJsonStrict(missionFile)
    if (!mission.ok) missingOperationalFiles.push(relative(missionFile))
  }
  const explicitTombstones = [
    path.join(projectRoot, '.sneakoscope', 'team'),
    path.join(projectRoot, '.sneakoscope', 'team-dashboard-state.json'),
    path.join(projectRoot, '.sneakoscope', 'update', 'legacy-team-artifacts.json')
  ]
  const survivingTombstones = []
  for (const candidate of explicitTombstones) {
    if (await pathExists(candidate)) survivingTombstones.push(relative(candidate))
  }
  const retiredMissionArtifactPaths = await findRetiredMissionArtifactPaths(missionRoot)
  const blockers = [
    ...survivingMissionIds.map((missionId) => `retired_mission_survived:${missionId}`),
    ...retiredIdentities.map((finding) => `retired_operational_identity_survived:${finding.file}:${finding.pointer}`),
    ...listingErrors.map((error) => `operational_json_listing_failed:${error}`),
    ...invalidJsonFiles.map((finding) => `operational_json_invalid:${finding.file}:${finding.error}`),
    ...missingOperationalFiles.map((file) => `operational_json_missing:${file}`),
    ...survivingTombstones.map((file) => `retired_tombstone_survived:${file}`),
    ...retiredMissionArtifactPaths.map((file) => `retired_mission_artifact_survived:${file}`)
  ]
  return {
    ok: blockers.length === 0,
    retired_mission_ids: retiredMissionIds,
    surviving_mission_ids: survivingMissionIds,
    retired_operational_identities: retiredIdentities,
    invalid_json_files: invalidJsonFiles,
    missing_operational_files: missingOperationalFiles,
    surviving_tombstone_paths: survivingTombstones,
    retired_mission_artifact_paths: retiredMissionArtifactPaths,
    blockers
  }
}

async function listJsonFiles(directory, errors = []) {
  let entries
  try {
    entries = await fs.readdir(directory, { withFileTypes: true })
  } catch (error) {
    errors.push(`${relative(directory)}:${errorCode(error)}`)
    return []
  }
  const files = []
  for (const entry of entries) {
    const file = path.join(directory, entry.name)
    if (entry.isDirectory()) files.push(...await listJsonFiles(file, errors))
    else if (entry.isFile() && entry.name.endsWith('.json')) files.push(file)
  }
  return files
}

async function readJsonStrict(file) {
  try {
    return { ok: true, value: JSON.parse(await fs.readFile(file, 'utf8')), error: null }
  } catch (error) {
    return { ok: false, value: null, error: errorCode(error) }
  }
}

function collectRetiredOperationalIdentities(value, file, findings) {
  const records = path.basename(file) === 'index.json' && Array.isArray(value?.missions)
    ? value.missions.map((entry, index) => ({ entry, pointer: `$.missions[${index}]` }))
    : [{ entry: value, pointer: '$' }]
  for (const record of records) {
    if (!record.entry || typeof record.entry !== 'object' || Array.isArray(record.entry)) continue
    for (const [key, entry] of Object.entries(record.entry)) {
      const nextPointer = `${record.pointer}.${key}`
      if (['mode', 'route', 'route_command', 'command'].includes(key) && isRetiredOperationalValue(entry)) {
        findings.push({
          file: relative(file),
          pointer: nextPointer
        })
      }
    }
  }
}

function isRetiredOperationalValue(value) {
  const raw = String(value || '').trim()
  const normalized = raw.replace(/^\$+/, '').replace(/_/g, '-').toLowerCase()
  if (['team', 'mad-db'].includes(normalized)) return true
  return /^(?:\$?team|\$?mad-db)(?:\s|$)/i.test(raw)
    || /^sks\s+(?:team|mad-db)(?:\s|$)/i.test(raw)
}

async function captureSafetyBaseline(fixtures) {
  const currentMissionFiles = []
  for (const fixture of fixtures.filter((fixture) => !['team', 'mad-db'].includes(String(fixture.mode || '').toLowerCase()))) {
    currentMissionFiles.push(...await listAllFiles(path.join(projectRoot, '.sneakoscope', 'missions', fixture.id)))
  }
  const userOwnedFiles = [
    path.join(projectRoot, 'USER-NOTES.md'),
    path.join(projectRoot, '.sneakoscope', 'state', 'customer-metadata.json')
  ]
  const currentManagedFiles = [path.join(projectRoot, 'package.json'), ...currentMissionFiles]
  const userOwned = await snapshotFiles(userOwnedFiles)
  const currentManaged = await snapshotFiles(currentManagedFiles)
  return {
    user_owned: userOwned.files,
    current_managed: currentManaged.files,
    blockers: [...userOwned.blockers, ...currentManaged.blockers]
  }
}

async function inspectSafetyPostcondition(baseline) {
  const userOwned = await compareSnapshot(baseline.user_owned)
  const currentManaged = await compareSnapshot(baseline.current_managed)
  const userOwnedDataTouched = userOwned.missing.length > 0 || userOwned.changed.length > 0
  const dataLossDetected = userOwnedDataTouched || currentManaged.missing.length > 0 || currentManaged.changed.length > 0
  const blockers = [
    ...userOwned.missing.map((file) => `user_owned_file_missing:${file}`),
    ...userOwned.changed.map((file) => `user_owned_file_changed:${file}`),
    ...currentManaged.missing.map((file) => `current_managed_file_missing:${file}`),
    ...currentManaged.changed.map((file) => `current_managed_file_changed:${file}`),
    ...userOwned.blockers,
    ...currentManaged.blockers
  ]
  return {
    ok: blockers.length === 0,
    data_loss_detected: dataLossDetected,
    user_owned_data_touched: userOwnedDataTouched,
    user_owned: userOwned,
    current_managed: currentManaged,
    blockers
  }
}

async function snapshotFiles(files) {
  const snapshot = {}
  const blockers = []
  for (const file of [...new Set(files)].sort()) {
    try {
      snapshot[relative(file)] = await fileSha256(file)
    } catch (error) {
      blockers.push(`baseline_file_unreadable:${relative(file)}:${errorCode(error)}`)
    }
  }
  return { files: snapshot, blockers }
}

async function compareSnapshot(snapshot) {
  const missing = []
  const changed = []
  const blockers = []
  for (const [file, expected] of Object.entries(snapshot)) {
    const absolute = path.join(projectRoot, file)
    try {
      const actual = await fileSha256(absolute)
      if (actual !== expected) changed.push(file)
    } catch (error) {
      if (errorCode(error) === 'ENOENT') missing.push(file)
      else blockers.push(`postcondition_file_unreadable:${file}:${errorCode(error)}`)
    }
  }
  return { ok: missing.length === 0 && changed.length === 0 && blockers.length === 0, checked: Object.keys(snapshot).length, missing, changed, blockers }
}

async function listAllFiles(directory) {
  const entries = await fs.readdir(directory, { withFileTypes: true })
  const files = []
  for (const entry of entries) {
    const file = path.join(directory, entry.name)
    if (entry.isDirectory()) files.push(...await listAllFiles(file))
    else if (entry.isFile()) files.push(file)
  }
  return files
}

async function findRetiredMissionArtifactPaths(missionRoot) {
  const retiredNames = new Set(['team-gate.json', 'team-session-cleanup.json', 'team-inbox'])
  const findings = []
  async function walk(directory) {
    let entries
    try {
      entries = await fs.readdir(directory, { withFileTypes: true })
    } catch (error) {
      if (errorCode(error) !== 'ENOENT') findings.push(`${relative(directory)}:<unreadable:${errorCode(error)}>`)
      return
    }
    for (const entry of entries) {
      const file = path.join(directory, entry.name)
      if (retiredNames.has(entry.name)) findings.push(relative(file))
      if (entry.isDirectory()) await walk(file)
    }
  }
  await walk(missionRoot)
  return findings.sort()
}

async function fileSha256(file) {
  return crypto.createHash('sha256').update(await fs.readFile(file)).digest('hex')
}

async function pathExists(file) {
  return fs.access(file).then(() => true, () => false)
}

function relative(file) {
  return path.relative(projectRoot, file).split(path.sep).join('/')
}

function errorCode(error) {
  return String(error?.code || error?.name || 'unknown_error')
}
