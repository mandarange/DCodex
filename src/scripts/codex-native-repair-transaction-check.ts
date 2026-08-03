#!/usr/bin/env node
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { repairCodexNativeManagedAssets } from '../core/codex-native/codex-native-repair-transaction.js'

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sks-repair-transaction-'))
await fs.mkdir(path.join(root, 'src', 'core', 'runtime'), { recursive: true })
await fs.writeFile(path.join(root, 'src', 'core', 'runtime', 'fixture.ts'), 'export {}\n', 'utf8')
const previous = process.env.CODEX_HOME
process.env.CODEX_HOME = path.join(root, 'codex-home')
try {
  const denied = await repairCodexNativeManagedAssets({ root, requestedBy: 'manual' })
  assertGate(denied.ok === false && denied.blockers.includes('repair_transaction_requires_yes'), 'repair transaction must require --yes before mutation', denied)
  assertGate(!(await exists(path.join(root, 'codex-home', 'skills'))) && !(await exists(path.join(root, 'codex-home', 'agents'))) && !(await exists(path.join(root, '.codex', 'agents'))), 'no-yes repair created managed assets', denied)
  const report = await repairCodexNativeManagedAssets({ root, requestedBy: 'manual', yes: true })
  assertGate(report.schema === 'sks.codex-native-repair-transaction.v1' && report.repaired.length === 4, 'repair transaction report incomplete', report)
  assertGate(report.confirmed === true && typeof report.mutation_ledger_path === 'string', 'repair transaction missing confirmation/ledger proof', report)
  assertGate(report.repaired.every((row) => row.artifact_path && Array.isArray(row.blockers)), 'repair rows missing artifact/blocker contract', report)
  assertGate(await exists(path.join(root, '.codex', 'agents', 'worker.toml')) && await exists(path.join(root, '.codex', 'agents', 'expert.toml')), 'repair transaction did not create official project agent roles', report)
  assertGate(!(await exists(path.join(root, 'codex-home', 'agents'))), 'repair transaction created legacy global agent roles', report)
} finally {
  if (previous === undefined) delete process.env.CODEX_HOME
  else process.env.CODEX_HOME = previous
}
emitGate('codex-native:repair-transaction')

async function exists(file: string): Promise<boolean> {
  try {
    await fs.stat(file)
    return true
  } catch {
    return false
  }
}

function assertGate(condition: unknown, message: string, detail: unknown = {}): asserts condition {
  if (condition) return
  console.error(JSON.stringify({ ok: false, message, detail }, null, 2))
  process.exit(1)
}

function emitGate(gate: string): void {
  console.log(JSON.stringify({ schema: 'sks.release-gate.v1', ok: true, gate }, null, 2))
}
