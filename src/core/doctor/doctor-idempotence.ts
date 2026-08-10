import fs from 'node:fs/promises'
import path from 'node:path'
import { runProcess, tmpdir, writeJsonAtomic } from '../fsx.js'

export interface DoctorIdempotenceReport {
  schema: 'sks.doctor-idempotence.v1'
  ok: boolean
  generated_at: string
  temp_dir: string
  first: DoctorRunSummary
  second: DoctorRunSummary
  rollback_manifest_exists: boolean
  changed_files_second: string[]
  blockers: string[]
}

interface DoctorRunSummary {
  exit_code: number | null
  duration_ms: number
  stdout_json: boolean
  ok: boolean
  blockers: string[]
}

export async function runDoctorIdempotence(root: string): Promise<DoctorIdempotenceReport> {
  const tmp = tmpdir('sks-doctor-idempotence-')
  const home = path.join(tmp, 'home')
  const codexHome = path.join(tmp, 'codex')
  await Promise.all([home, codexHome].map((dir) => fs.mkdir(dir, { recursive: true })))
  const first = await runDoctor(root, home, codexHome)
  const second = await runDoctor(root, home, codexHome)
  const rollbackManifestExists = await hasRollbackManifest(home, codexHome, root)
  const changedFilesSecond = extractChangedFiles(second)
  const blockers: string[] = []
  if (first.exit_code !== 0) blockers.push(`first_doctor_exit_${first.exit_code}`)
  if (second.exit_code !== 0) blockers.push(`second_doctor_exit_${second.exit_code}`)
  if (changedFilesSecond.length > 0) blockers.push('second_doctor_not_noop')
  // Fail closed on a missing field rather than reading it as "nothing changed".
  // No part of the pipeline emitted `changed_files` at all, so this gate silently
  // passed every run and could never observe a non-idempotent repair.
  if (!reportsChangedFiles(second)) blockers.push('second_doctor_changed_files_unavailable')

  const report: DoctorIdempotenceReport = {
    schema: 'sks.doctor-idempotence.v1',
    ok: blockers.length === 0,
    generated_at: new Date().toISOString(),
    temp_dir: tmp,
    first,
    second,
    rollback_manifest_exists: rollbackManifestExists,
    changed_files_second: changedFilesSecond,
    blockers: [...new Set(blockers)]
  }
  await writeJsonAtomic(path.join(root, '.sneakoscope', 'reports', 'doctor-idempotence.json'), report)
  return report
}

async function runDoctor(root: string, home: string, codexHome: string): Promise<DoctorRunSummary & { parsed?: any }> {
  const started = Date.now()
  const res = await runProcess(process.execPath, ['./dist/bin/sks.js', 'doctor', '--fix', '--yes', '--json'], {
    cwd: root,
    timeoutMs: 180_000,
    maxOutputBytes: 1024 * 1024,
    env: {
      HOME: home,
      CODEX_HOME: codexHome,
      SKS_TEST_ISOLATION: '1',
      SKS_DISABLE_NETWORK: '1',
      SKS_DISABLE_UPDATE_CHECK: '1'
    }
  })
  let parsed: any = null
  try {
    parsed = JSON.parse(res.stdout)
  } catch {}
  const blockers = Array.isArray(parsed?.blockers) ? parsed.blockers.map(String) : []
  return {
    exit_code: res.code,
    duration_ms: Date.now() - started,
    stdout_json: parsed != null,
    ok: res.code === 0 && parsed?.ok !== false,
    blockers,
    parsed
  }
}

/** True when the doctor run actually reported the field this gate depends on. */
function reportsChangedFiles(run: DoctorRunSummary & { parsed?: any }): boolean {
  if (!run.parsed) return false
  return [
    run.parsed?.repair?.doctor_transaction?.changed_files,
    run.parsed?.doctor_fix_transaction?.changed_files,
    run.parsed?.changed_files
  ].some((value) => Array.isArray(value))
}

function extractChangedFiles(run: DoctorRunSummary & { parsed?: any }): string[] {
  const repair = run.parsed?.repair || {}
  const candidates = [
    repair.doctor_transaction?.changed_files,
    run.parsed?.doctor_fix_transaction?.changed_files,
    run.parsed?.changed_files
  ]
  return [...new Set(candidates.flatMap((value) => Array.isArray(value) ? value.map(String) : []))]
}

async function hasRollbackManifest(...roots: string[]): Promise<boolean> {
  for (const dir of roots) {
    const found = await findFileContaining(dir, /rollback|transaction|manifest/i, 4)
    if (found) return true
  }
  return false
}

async function findFileContaining(dir: string, pattern: RegExp, depth: number): Promise<boolean> {
  if (depth < 0) return false
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => [])
  for (const entry of entries) {
    const child = path.join(dir, entry.name)
    if (entry.isFile() && pattern.test(entry.name)) return true
    if (entry.isDirectory() && await findFileContaining(child, pattern, depth - 1)) return true
  }
  return false
}
