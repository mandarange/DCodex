#!/usr/bin/env node
// @ts-nocheck
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { assertGate, emitGate, root } from './gate-lib.js'

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'sks-doctor-ops-semantics-'))
const projectRoot = path.join(tmp, 'project')
const codexHome = path.join(tmp, 'codex-home')

try {
  await fs.mkdir(projectRoot, { recursive: true })
  await fs.mkdir(codexHome, { recursive: true })
  await fs.writeFile(path.join(projectRoot, 'package.json'), '{"name":"doctor-ops-semantics-fixture","private":true}\n')

  const fast = runDoctor(['doctor', '--json'])
  const full = runDoctor(['doctor', '--full', '--json'])
  const fix1 = runDoctor(['doctor', '--fix', '--yes', '--json'])
  const fix2 = runDoctor(['doctor', '--fix', '--yes', '--json'])
  const blockers = [
    ...shapeBlockers('fast', fast, (json) => json.schema === 'sks.doctor-status.v3' && json.diagnostic_depth === 'fast' && json.not_counted_as_full_doctor === true && json.deep_ok === null),
    ...shapeBlockers('full', full, (json) => json.schema === 'sks.doctor-status.v3' && json.diagnostic_depth === 'full' && json.not_counted_as_full_doctor === false && typeof json.deep_ok === 'boolean'),
    ...shapeBlockers('fix', fix1, (json) => json.schema === 'sks.doctor-fix-result.v2' || json.doctor_fix_transaction?.schema === 'sks.doctor-fix-transaction.v2'),
    ...(fix1.json?.ok === true && Array.isArray(fix1.json?.blockers) && fix1.json.blockers.length ? ['fix_ok_true_with_blockers'] : []),
    ...(fix2.json?.ok === true && Array.isArray(fix2.json?.blockers) && fix2.json.blockers.length ? ['second_fix_ok_true_with_blockers'] : [])
  ]
  const report = {
    schema: 'sks.doctor-ops-semantics.v1',
    ok: blockers.length === 0,
    generated_at: new Date().toISOString(),
    fixture_root: projectRoot,
    fast: summarize(fast),
    full: summarize(full),
    fix: summarize(fix1),
    second_fix: summarize(fix2),
    blockers
  }
  const reportPath = path.join(root, '.sneakoscope', 'reports', 'doctor-ops-semantics.json')
  await fs.mkdir(path.dirname(reportPath), { recursive: true })
  await fs.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`)

  assertGate(report.ok, 'doctor ops semantics failed', report)
  emitGate('doctor:ops-semantics', { report: reportPath.replace(`${root}/`, '') })
} finally {
  await fs.rm(tmp, { recursive: true, force: true }).catch(() => undefined)
}

function runDoctor(args) {
  const result = spawnSync(process.execPath, [path.join(root, 'dist', 'bin', 'sks.js'), ...args], {
    cwd: projectRoot,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
    env: { ...process.env, CODEX_HOME: codexHome, SKS_DISABLE_NETWORK: '1', SKS_DISABLE_UPDATE_CHECK: '1', SKS_NO_QUESTION: '1' }
  })
  return { status: result.status, stdout: result.stdout, stderr: result.stderr, json: parseJson(result.stdout) }
}

function shapeBlockers(label, result, predicate) {
  if (!result.json) return [`${label}_json_missing`]
  if (result.status !== 0 && result.json.status !== 'blocked') return [`${label}_unexpected_exit:${result.status}`]
  if (result.json.ok === true && Array.isArray(result.json.blockers) && result.json.blockers.length) return [`${label}_ok_true_with_blockers`]
  if (!predicate(result.json)) return [`${label}_schema_mismatch`]
  return []
}

function summarize(result) {
  return {
    exit_code: result.status,
    schema: result.json?.schema || result.json?.doctor_fix_transaction?.schema || null,
    ok: result.json?.ok ?? null,
    status: result.json?.status || null,
    diagnostic_depth: result.json?.diagnostic_depth || null,
    blockers: Array.isArray(result.json?.blockers) ? result.json.blockers : [],
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
