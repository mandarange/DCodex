import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'
import type {
  ReleaseUpgradeCommandResult,
  ReleaseUpgradeCommandSpec,
  ReleaseUpgradeIsolation
} from '../../../scripts/release-upgrade-smoke.js'
import type { ReleaseUpgradeLifecycleInput } from '../../../scripts/release-upgrade-smoke-contract.js'

export function result(stdout: string, code = 0): ReleaseUpgradeCommandResult {
  return { code, stdout, stderr: '', timedOut: false, durationMs: 1 }
}

export async function writeDoctorReport(spec: ReleaseUpgradeCommandSpec, value: unknown): Promise<void> {
  const reportPath = doctorReportPath(spec)
  await fs.mkdir(path.dirname(reportPath), { recursive: true })
  await fs.writeFile(reportPath, `${JSON.stringify(value, null, 2)}\n`)
}

export function doctorReportPath(spec: ReleaseUpgradeCommandSpec): string {
  const index = spec.args.indexOf('--report-file')
  assert.ok(index >= 0)
  const value = spec.args[index + 1]
  assert.ok(value)
  return value
}

export async function makeLifecycleInput(
  isolation: ReleaseUpgradeIsolation,
  platform: NodeJS.Platform
): Promise<ReleaseUpgradeLifecycleInput> {
  const targetTarball = path.join(isolation.sealedInputsDir, 'target-8.0.0.tgz')
  const baselineTarball = path.join(isolation.sealedInputsDir, 'baseline-7.6.0.tgz')
  const targetBytes = Buffer.from('sealed-target-8.0.0')
  const baselineBytes = Buffer.from('sealed-baseline-7.6.0')
  await Promise.all([
    fs.writeFile(targetTarball, targetBytes),
    fs.writeFile(baselineTarball, baselineBytes)
  ])
  await Promise.all([
    fs.chmod(targetTarball, 0o400),
    fs.chmod(baselineTarball, 0o400)
  ])
  return {
    targetVersion: '8.0.0',
    targetTarball,
    targetSha256: crypto.createHash('sha256').update(targetBytes).digest('hex'),
    baselineTarball,
    baselineSha256: crypto.createHash('sha256').update(baselineBytes).digest('hex'),
    isolation,
    platform,
    npmCommand: 'npm'
  }
}

export function initGit(root: string): void {
  for (const args of [
    ['init', '--quiet'],
    ['add', '--all'],
    ['-c', 'user.name=Sneakoscope Test', '-c', 'user.email=test@sneakoscope.invalid', 'commit', '--quiet', '-m', 'fixture']
  ]) {
    const completed = spawnSync('git', args, { cwd: root, encoding: 'utf8' })
    assert.equal(completed.status, 0, completed.stderr || completed.stdout)
  }
}

export async function pathExists(value: string): Promise<boolean> {
  if (!value) return false
  try {
    await fs.access(value)
    return true
  } catch {
    return false
  }
}
