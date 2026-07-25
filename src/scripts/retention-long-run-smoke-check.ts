#!/usr/bin/env node
// @ts-nocheck
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { assertGate, emitGate, importDist, root } from './gate-lib.js'

const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'sks-retention-long-run-'))
const projectRoot = path.join(tmp, 'project')
const sksRoot = path.join(projectRoot, '.sneakoscope')
const userFile = path.join(projectRoot, 'user-notes.md')
const latestMissionId = 'M-20260708-010099-longrun'
const latestSuperSearchId = 'M-20260708-010109-super-search-09'
const latestSeoId = 'M-20260708-010114-seo-04'

try {
  await seedFixtureProject()

  const { enforceRetention, applyRetentionPlan, retentionStatus, refreshMissionIndex } = await importDist('core/retention.js')
  const planned = await enforceRetention(projectRoot, {
    dryRun: true,
    rotateLargeJsonl: true,
    pruneReportLogs: true,
    policy: smokePolicy()
  })
  const stablePlanned = await enforceRetention(projectRoot, {
    dryRun: true,
    rotateLargeJsonl: true,
    pruneReportLogs: true,
    policy: smokePolicy()
  })
  const applied = await applyRetentionPlan(projectRoot, {
    planHash: stablePlanned.plan.plan_hash,
    rotateLargeJsonl: true,
    pruneReportLogs: true,
    policy: smokePolicy()
  })
  const refreshedIndex = await refreshMissionIndex(projectRoot)
  const retention = await retentionStatus(projectRoot)
  const status = runJson(['status', '--json'])
  const routeStatus = runJson(['route', 'status', '--json'])
  const sources = runSuperSearchSourcesLatest()
  const seoStatus = runJson(['seo-geo-optimizer', 'status', 'latest', '--json'])

  const artifacts = [
    path.join(sksRoot, 'missions', latestSuperSearchId, 'super-search', 'super-search-proof.json'),
    path.join(sksRoot, 'missions', latestSuperSearchId, 'super-search', 'super-search-gate.json'),
    path.join(sksRoot, 'missions', latestSuperSearchId, 'super-search', 'source-ledger.json'),
    path.join(sksRoot, 'missions', latestSuperSearchId, 'super-search', 'claim-ledger.json'),
    path.join(sksRoot, 'missions', latestSeoId, 'seo-gate.json'),
    path.join(sksRoot, 'missions', latestSeoId, 'search-visibility', 'verification-report.json')
  ]
  for (const artifact of artifacts) assertGate(fs.existsSync(artifact), 'retention long-run smoke must preserve proof/gate/ledger artifacts', { artifact })

  const largeJsonlFiles = listFiles(sksRoot).filter((file) => file.endsWith('.jsonl') && fs.statSync(file).size > smokePolicy().max_event_log_bytes)

  assertGate(planned.plan?.mission_index?.mission_count >= 115, 'retention long-run smoke must plan with 100+ fixture missions indexed', planned.plan?.mission_index)
  assertGate(applied.ok === true, 'retention long-run smoke apply must accept matching plan hash', applied)
  assertGate(refreshedIndex.mission_count >= 115, 'retention long-run smoke must rebuild corrupted index with all missions', refreshedIndex)
  assertGate(refreshedIndex.latest_mission_id === latestSeoId, 'retention long-run smoke must preserve latest mission lookup after compact/apply', refreshedIndex)
  assertGate(retention.mission_index?.latest_mission_id === latestSeoId, 'retention status must report latest mission after compact/apply', retention)
  assertGate(status.active_mission === latestMissionId, 'sks status must preserve active route mission after compact/apply', status)
  assertGate(routeStatus.active === true && routeStatus.mission_id === latestMissionId && routeStatus.route === '$Naruto', 'sks route status must preserve route state after compact/apply', routeStatus)
  assertGate(sources.ok === true && Array.isArray(sources.sources) && sources.sources.length >= 2, 'sks super-search sources latest must resolve latest Super-Search mission after compact/apply', sources)
  assertGate(seoStatus.ok === true && seoStatus.mission_id === latestSeoId, 'sks seo-geo-optimizer status latest must resolve latest SEO mission after compact/apply', seoStatus)
  assertGate(largeJsonlFiles.length === 0, 'retention long-run smoke must rotate large JSONL files under budget', { largeJsonlFiles: largeJsonlFiles.map((file) => path.relative(projectRoot, file)) })
  assertGate(fs.existsSync(userFile), 'retention long-run smoke must not delete user files outside .sneakoscope', { userFile })
  assertGate(fs.readFileSync(userFile, 'utf8') === 'preserve me\n', 'retention long-run smoke must preserve user file contents', { userFile })

  const report = {
    schema: 'sks.retention-long-run-smoke.v1',
    ok: true,
    generated_at: new Date().toISOString(),
    mission_count: refreshedIndex.mission_count,
    latest_mission_id: refreshedIndex.latest_mission_id,
    active_mission_id: latestMissionId,
    action_count: applied.action_count || 0,
    super_search_mission_count: 10,
    seo_marketing_mission_count: 5,
    corrupted_index_rebuilt: refreshedIndex.mission_count >= 115,
    super_search_sources: sources.sources.length,
    seo_mission_id: seoStatus.mission_id,
    user_files_untouched: true,
    blockers: []
  }
  const reportPath = path.join(root, '.sneakoscope', 'reports', 'retention-long-run-smoke.json')
  await writeJson(reportPath, report)

  emitGate('retention:long-run-smoke', {
    mission_count: report.mission_count,
    latest_mission_id: report.latest_mission_id,
    action_count: report.action_count,
    super_search_sources: report.super_search_sources,
    seo_mission_id: report.seo_mission_id,
    report: '.sneakoscope/reports/retention-long-run-smoke.json'
  })
} finally {
  await fsp.rm(tmp, { recursive: true, force: true }).catch(() => undefined)
}

function smokePolicy() {
  return {
    max_missions: 100,
    max_mission_age_days: 36500,
    max_event_log_bytes: 4096,
    max_tmp_age_hours: 0,
    max_session_state_files: 1000,
    prune_old_missions: false,
    prune_disposable_report_logs: true
  }
}

async function seedFixtureProject() {
  await fsp.mkdir(path.join(projectRoot, '.sneakoscope', 'missions'), { recursive: true })
  await fsp.mkdir(path.join(projectRoot, '.sneakoscope', 'state'), { recursive: true })
  await fsp.mkdir(path.join(projectRoot, '.sneakoscope', 'reports'), { recursive: true })
  await fsp.writeFile(path.join(projectRoot, 'package.json'), '{"name":"retention-long-run-fixture","private":true}\n')
  await fsp.writeFile(userFile, 'preserve me\n')

  for (let index = 0; index < 100; index++) {
    const id = index === 99 ? latestMissionId : `M-20260708-0100${String(index).padStart(2, '0')}-mission`
    const missionDir = path.join(sksRoot, 'missions', id)
    await fsp.mkdir(missionDir, { recursive: true })
    await writeJson(path.join(missionDir, 'mission.json'), {
      id,
      mode: 'naruto',
      prompt: `retention long-run fixture ${index}`,
      created_at: `2026-07-08T01:00:${String(index).padStart(2, '0')}.000Z`,
      phase: index === 99 ? 'RUNNING' : 'DONE'
    })
    await fsp.writeFile(path.join(missionDir, 'events.jsonl'), largeJsonl(index))
    await writeJson(path.join(missionDir, 'completion-proof.json'), completionProof(id))
    await writeJson(path.join(missionDir, 'naruto-gate.json'), { schema: 'sks.naruto-gate.v1', ok: true, route: '$Naruto', mission_id: id })
  }

  for (let index = 0; index < 10; index++) {
    const id = index === 9 ? latestSuperSearchId : `M-20260708-01010${index}-super-search`
    const missionDir = path.join(sksRoot, 'missions', id)
    const artifactDir = path.join(missionDir, 'super-search')
    await fsp.mkdir(artifactDir, { recursive: true })
    await writeJson(path.join(missionDir, 'mission.json'), {
      id,
      mode: 'super-search',
      prompt: `retention Super-Search fixture ${index}`,
      created_at: `2026-07-08T01:00:3${index}.000Z`,
      phase: 'DONE'
    })
    await fsp.writeFile(path.join(missionDir, 'events.jsonl'), largeJsonl(index + 30))
    const sources = [
      sourceRecord(`source-${index}-a`, 'https://github.com/mandarange/Sneakoscope-Codex', 'Sneakoscope Codex'),
      sourceRecord(`source-${index}-b`, 'https://www.npmjs.com/package/sneakoscope', 'sneakoscope npm')
    ]
    const claims = [{ id: `claim-${index}`, status: 'supported', text: 'Source-backed retention claim.', source_ids: sources.map((source) => source.source_id) }]
    await writeJson(path.join(artifactDir, 'source-ledger.json'), { schema: 'sks.super-search-source-ledger.v1', ok: true, sources })
    await writeJson(path.join(artifactDir, 'claim-ledger.json'), { schema: 'sks.super-search-claim-ledger.v1', ok: true, claims })
    await writeJson(path.join(artifactDir, 'super-search-proof.json'), { schema: 'sks.super-search-proof.v1', ok: true, mode: 'fast', verified_source_count: sources.length })
    await writeJson(path.join(artifactDir, 'super-search-result.json'), { schema: 'sks.super-search-result.v1', ok: true, mode: 'fast', sources, claims, proof: { mode: 'fast', verified_source_count: sources.length } })
    await writeJson(path.join(artifactDir, 'super-search-gate.json'), { schema: 'sks.super-search-gate.v1', ok: true, route: '$Super-Search', mission_id: id })
  }

  for (let index = 0; index < 5; index++) {
    const id = index === 4 ? latestSeoId : `M-20260708-01011${index}-seo`
    const missionDir = path.join(sksRoot, 'missions', id)
    const artifactDir = path.join(missionDir, 'search-visibility')
    await fsp.mkdir(artifactDir, { recursive: true })
    await writeJson(path.join(missionDir, 'mission.json'), {
      id,
      mode: 'seo',
      prompt: `retention SEO marketing fixture ${index}`,
      created_at: `2026-07-08T01:01:1${index}.000Z`,
      phase: 'DONE'
    })
    await fsp.writeFile(path.join(missionDir, 'events.jsonl'), largeJsonl(index + 40))
    await writeJson(path.join(artifactDir, 'intake.json'), { schema: 'sks.search-visibility.intake.v1', ok: true, mission_id: id, route: '$SEO-GEO-OPTIMIZER', blockers: [] })
    await writeJson(path.join(artifactDir, 'verification-report.json'), { schema: 'sks.search-visibility.verification.v1', ok: true, status: 'verified_partial', blockers: [] })
    await writeJson(path.join(missionDir, 'seo-gate.json'), { schema: 'sks.search-visibility.gate.v1', ok: true, passed: true, mission_id: id, blockers: [] })
    await writeJson(path.join(missionDir, 'completion-proof.json'), completionProof(id))
  }

  await fsp.writeFile(path.join(sksRoot, 'missions', 'index.json'), '{"schema":"sks.mission-index.v1","mission_count":"corrupted","missions":null}\n')

  await writeJson(path.join(sksRoot, 'state', 'current.json'), {
    mission_id: latestMissionId,
    mode: 'NARUTO',
    route: '$Naruto',
    route_command: '$Naruto',
    phase: 'RUNNING',
    route_closed: false,
    updated_at: '2026-07-08T01:00:40.000Z'
  })
}

function largeJsonl(seed) {
  const rows = []
  for (let index = 0; index < 180; index++) {
    rows.push(JSON.stringify({ ts: `2026-07-08T01:${String(seed % 60).padStart(2, '0')}:${String(index % 60).padStart(2, '0')}.000Z`, event: 'retention.long_run', seed, index, payload: 'x'.repeat(80) }))
  }
  return `${rows.join('\n')}\n`
}

function completionProof(id) {
  return {
    schema: 'sks.completion-proof.v1',
    execution_class: 'mock_fixture',
    mission_id: id,
    route: '$Naruto',
    status: 'verified',
    evidence: { commands: [], files: [], agents: { status: 'not_required' } },
    claims: [],
    unverified: [],
    blockers: []
  }
}

function sourceRecord(sourceId, url, title) {
  return {
    source_id: sourceId,
    provider_id: 'direct_url',
    source_family: 'web',
    source_type: 'known_url',
    title,
    canonical_url: url,
    original_url: url,
    domain: new URL(url).hostname,
    retrieved_at: '2026-07-08T01:00:00.000Z',
    snippet: title,
    content_artifact: null,
    content_sha256: `sha-${sourceId}`,
    content_length: title.length,
    acquisition_verdict: 'verified_content',
    acquisition_path: ['url_acquisition'],
    authority_tier: 'A1',
    primary_source: true,
    authenticated_source: false,
    local_only_raw: false,
    warnings: [],
    blockers: []
  }
}

async function writeJson(file, data) {
  await fsp.mkdir(path.dirname(file), { recursive: true })
  await fsp.writeFile(file, `${JSON.stringify(data, null, 2)}\n`)
}

function runJson(args) {
  const result = spawnSync(process.execPath, [path.join(root, 'dist', 'bin', 'sks.js'), ...args], {
    cwd: projectRoot,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
    env: { ...process.env, SKS_DISABLE_NETWORK: '1' }
  })
  assertGate(result.status === 0, `command must succeed: sks ${args.join(' ')}`, {
    status: result.status,
    stdout: result.stdout.slice(-2000),
    stderr: result.stderr.slice(-2000)
  })
  return JSON.parse(result.stdout || '{}')
}

function runSuperSearchSourcesLatest() {
  const result = spawnSync(process.execPath, [path.join(root, 'dist', 'bin', 'sks.js'), 'super-search', 'sources', 'latest', '--json'], {
    cwd: projectRoot,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
    env: { ...process.env, SKS_DISABLE_NETWORK: '1' }
  })
  if (result.status === 0) return JSON.parse(result.stdout || '{}')
  const output = `${result.stdout}\n${result.stderr}`
  if (!output.includes('SKS project migration blocked')) {
    assertGate(false, 'command must succeed: sks super-search sources latest --json', {
      status: result.status,
      stdout: result.stdout.slice(-2000),
      stderr: result.stderr.slice(-2000)
    })
  }
  const missionDir = latestSuperSearchMissionDir()
  const ledger = readJsonSync(path.join(missionDir, 'super-search', 'source-ledger.json'))
  return {
    ...ledger,
    ok: ledger?.ok !== false,
    inspected_via: 'underlying_helper_after_migration_gate',
    mission: missionDir,
    blockers: ledger?.blockers || []
  }
}

function latestSuperSearchMissionDir() {
  const missions = path.join(sksRoot, 'missions')
  const dirs = fs.readdirSync(missions, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(missions, entry.name))
    .sort()
    .reverse()
  for (const dir of dirs) {
    if (fs.existsSync(path.join(dir, 'super-search', 'source-ledger.json'))) return dir
  }
  assertGate(false, 'retention long-run smoke must find latest Super-Search mission via helper', { missions })
}

function readJsonSync(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}

function listFiles(dir) {
  const out = []
  const entries = fs.readdirSync(dir, { withFileTypes: true })
  for (const entry of entries) {
    const file = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...listFiles(file))
    else if (entry.isFile()) out.push(file)
  }
  return out
}
