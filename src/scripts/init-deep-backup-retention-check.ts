#!/usr/bin/env node
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { runCodexInitDeep } from '../core/codex-app/codex-init-deep.js'

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sks-init-deep-retention-'))
const target = path.join(root, 'src', 'core', 'runtime')
await fs.mkdir(target, { recursive: true })
for (let index = 0; index < 18; index += 1) await fs.writeFile(path.join(target, `f${index}.ts`), 'export {}\n', 'utf8')
await fs.writeFile(path.join(target, 'AGENTS.md'), '# User local guidance\nKeep me.\n', 'utf8')
const previous = process.env.SKS_INIT_DEEP_BACKUP_RETENTION
process.env.SKS_INIT_DEEP_BACKUP_RETENTION = '1'
try {
  const first = await runCodexInitDeep({ root, apply: true, directoryLocal: true })
  const second = await runCodexInitDeep({ root, apply: true, directoryLocal: true })
  assertGate(first.directory_local_agents.changed_only_backup === true, 'changed-only backup flag missing')
  assertGate(first.directory_local_agents.backup_paths.every((file) => /AGENTS\.md\.sks-backup-\d{13}-[0-9a-f]{8,12}$/.test(file)), 'backup filename must be timestamp-hash pattern', first)
  assertGate(second.directory_local_agents.unchanged_files.length >= 1 && second.directory_local_agents.backup_paths.length === 0, 'unchanged second run should not create backup', second)
} finally {
  if (previous === undefined) delete process.env.SKS_INIT_DEEP_BACKUP_RETENTION
  else process.env.SKS_INIT_DEEP_BACKUP_RETENTION = previous
}
emitGate('init-deep:backup-retention')

function assertGate(condition: unknown, message: string, detail: unknown = {}): asserts condition {
  if (condition) return
  console.error(JSON.stringify({ ok: false, message, detail }, null, 2))
  process.exit(1)
}

function emitGate(gate: string): void {
  console.log(JSON.stringify({ schema: 'sks.release-gate.v1', ok: true, gate }, null, 2))
}
