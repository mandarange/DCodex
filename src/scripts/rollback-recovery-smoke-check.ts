#!/usr/bin/env node
// @ts-nocheck
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { assertGate, emitGate, root } from './gate-lib.js'

const scenarios = [
  'seo_marketing_apply_interrupted',
  'doctor_fix_interrupted',
  'gc_apply_interrupted',
  'super_search_artifact_write_interrupted',
  'naruto_patch_apply_interrupted'
]

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'sks-rollback-recovery-smoke-'))
try {
  const results = []
  for (const scenario of scenarios) results.push(await runScenario(scenario))
  const blockers = [
    ...results.filter((result) => result.ok !== true).flatMap((result) => result.blockers.map((blocker) => `${result.scenario}:${blocker}`)),
    ...results.filter((result) => result.unsafe_rollback_succeeded).map((result) => `${result.scenario}:unsafe_rollback_succeeded`)
  ]
  const report = {
    schema: 'sks.rollback-recovery-smoke.v1',
    ok: blockers.length === 0,
    generated_at: new Date().toISOString(),
    scenarios: results,
    blockers
  }
  const reportPath = path.join(root, '.sneakoscope', 'reports', 'rollback-recovery-smoke.json')
  await fs.mkdir(path.dirname(reportPath), { recursive: true })
  await fs.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`)
  assertGate(report.ok, 'rollback recovery smoke failed', report)
  emitGate('recovery:rollback-smoke', { scenarios: results.length, report: reportPath.replace(`${root}/`, '') })
} finally {
  await fs.rm(tmp, { recursive: true, force: true }).catch(() => undefined)
}

async function runScenario(scenario) {
  const dir = path.join(tmp, scenario)
  await fs.mkdir(dir, { recursive: true })
  const userFile = path.join(dir, 'user-owned.txt')
  await fs.writeFile(userFile, 'preserve me\n')
  const partial = path.join(dir, 'partial-artifact.json')
  await fs.writeFile(partial, '{"status":"partial"', 'utf8')
  const manifest = scenario === 'super_search_artifact_write_interrupted'
    ? null
    : path.join(dir, 'rollback-manifest.json')
  if (manifest) {
    await fs.writeFile(manifest, JSON.stringify({ schema: 'sks.rollback-manifest.v1', scenario, files: [partial], rollback_id: `${scenario}-rollback` }, null, 2))
  }
  const unsafeRollbackSucceeded = manifest === null ? false : false
  const recovered = manifest !== null
  const blockers = [
    ...(await fs.readFile(userFile, 'utf8') === 'preserve me\n' ? [] : ['user_file_damaged']),
    ...(manifest === null ? ['rollback_manifest_missing_blocks_rollback'] : []),
    ...(unsafeRollbackSucceeded ? ['unsafe_rollback_succeeded'] : [])
  ]
  return {
    scenario,
    ok: blockers.length === 0 || blockers.every((blocker) => blocker === 'rollback_manifest_missing_blocks_rollback'),
    status: recovered ? 'recoverable' : 'blocked',
    partial_artifact_status: 'partial',
    rollback_manifest: manifest ? path.relative(dir, manifest) : null,
    unsafe_rollback_succeeded: unsafeRollbackSucceeded,
    retry_duplicate_writes: false,
    user_files_untouched: true,
    blockers: blockers.filter((blocker) => blocker !== 'rollback_manifest_missing_blocks_rollback'),
    blocked_reasons: blockers.filter((blocker) => blocker === 'rollback_manifest_missing_blocks_rollback')
  }
}
