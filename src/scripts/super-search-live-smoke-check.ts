#!/usr/bin/env node
// @ts-nocheck
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { assertGate, emitGate, root } from './gate-lib.js'

const bin = path.join(root, 'dist', 'bin', 'sks.js')
assertGate(fs.existsSync(bin), 'dist bin missing for live smoke', { bin, hint: 'run npm run build first' })

const targetGroups = [
  {
    id: 'repo_metadata',
    urls: [
      'https://raw.githubusercontent.com/mandarange/Sneakoscope-Codex/main/package.json',
      'https://github.com/mandarange/Sneakoscope-Codex',
      'https://api.github.com/repos/mandarange/Sneakoscope-Codex'
    ]
  },
  {
    id: 'npm_package',
    urls: [
      'https://registry.npmjs.org/sneakoscope',
      'https://www.npmjs.com/package/sneakoscope'
    ]
  }
]

const fetchResults = targetGroups.map((group) => fetchWithFallback(group))
const doctor = runJson(['super-search', 'doctor', '--json'])

for (const row of fetchResults) {
  assertGate(row.status === 0, 'super-search live fetch command failed', row)
  const result = row.json
  const directSources = result.sources.filter((source) => source.provider_id === 'direct_url')
  assertGate(directSources.some((source) => source.acquisition_verdict === 'verified_content'), 'direct_url source must have verified_content', { target: row.target, sources: result.sources })
  assertGate(directSources.some((source) => source.content_artifact), 'direct_url source must have content artifact', { target: row.target, sources: result.sources })
  assertGate(directSources.some((source) => source.content_sha256), 'direct_url source must have content sha256', { target: row.target, sources: result.sources })
  assertGate(result.proof.source_count > 0, 'live smoke must record source count > 0', result.proof)
  assertGate(result.proof.verified_source_count > 0, 'live smoke must record verified source count > 0', result.proof)
  assertGate(!result.blockers.includes('source_acquisition_unavailable'), 'live smoke must not report source_acquisition_unavailable', result)
  assertGate(result.claims.every((claim) => claim.status !== 'supported' || claim.source_ids?.length > 0), 'supported claims must be source-backed', result.claims)
}

assertGate(doctor.status === 0, 'super-search doctor command failed', doctor)
assertGate(['sks.super-search-doctor.v2', 'sks.super-search-doctor.v3'].includes(doctor.json.schema), 'doctor must emit a supported schema', doctor.json)
assertGate(doctor.json.ok === (doctor.json.status === 'usable' || doctor.json.status === 'offline_usable'), 'doctor ok must match usable status', doctor.json)

const report = {
  schema: 'sks.super-search-live-smoke.v1',
  ok: true,
  generated_at: new Date().toISOString(),
  checked_urls: fetchResults.map((row) => row.url),
  attempts: fetchResults.map((row) => ({
    group_id: row.group_id,
    selected_url: row.url,
    attempts: row.attempts.map((attempt) => ({
      url: attempt.url,
      status: attempt.status,
      verified_source_count: Number(attempt.json?.proof?.verified_source_count || 0),
      blockers: attempt.json?.blockers || []
    }))
  })),
  doctor_status: doctor.json.status,
  verified_sources: fetchResults.reduce((sum, row) => sum + Number(row.json?.proof?.verified_source_count || 0), 0),
  blockers: [],
  evidence_paths: fetchResults.map((row) => row.json?.artifact_dir).filter(Boolean)
}
fs.mkdirSync(path.join(root, '.sneakoscope', 'reports'), { recursive: true })
fs.writeFileSync(path.join(root, '.sneakoscope', 'reports', 'super-search-live-smoke.json'), `${JSON.stringify(report, null, 2)}\n`)

emitGate('super-search:live-smoke', {
  checked_urls: fetchResults.length,
  doctor_status: doctor.json.status,
  verified_sources: fetchResults.reduce((sum, row) => sum + Number(row.json?.proof?.verified_source_count || 0), 0)
})

function fetchWithFallback(group) {
  const attempts = []
  for (const url of group.urls) {
    const row = runJson(['super-search', 'fetch', url, '--json'])
    attempts.push({ ...row, url })
    if (isVerifiedFetch(row)) {
      return { ...row, group_id: group.id, url, attempts }
    }
  }
  return { ...attempts[attempts.length - 1], group_id: group.id, url: attempts[attempts.length - 1]?.url || null, attempts }
}

function isVerifiedFetch(row) {
  if (row.status !== 0 || !row.json) return false
  const result = row.json
  const directSources = Array.isArray(result.sources) ? result.sources.filter((source) => source.provider_id === 'direct_url') : []
  const hasNoSourceAcquisitionBlocker = !Array.isArray(result.blockers) || !result.blockers.includes('source_acquisition_unavailable')
  return directSources.some((source) => source.acquisition_verdict === 'verified_content') &&
    directSources.some((source) => source.content_artifact) &&
    directSources.some((source) => source.content_sha256) &&
    Number(result.proof?.source_count || 0) > 0 &&
    Number(result.proof?.verified_source_count || 0) > 0 &&
    hasNoSourceAcquisitionBlocker
}

function runJson(args) {
  const proc = spawnSync(process.execPath, [bin, ...args], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, SKS_RELEASE_LIVE: '1' },
    timeout: 30000
  })
  let json = null
  try {
    json = JSON.parse(proc.stdout || proc.stderr || '{}')
  } catch {
    json = null
  }
  return {
    target: args.join(' '),
    status: proc.status,
    signal: proc.signal,
    stdout: proc.stdout,
    stderr: proc.stderr,
    json
  }
}
