import path from 'node:path'
import { buildCodexHookLifecycle } from '../codex-app/codex-hook-lifecycle.js'
import { runCodexInitDeep } from '../codex-app/codex-init-deep.js'
import { syncCodexAgentRoles } from '../codex-app/codex-agent-role-sync.js'
import { syncCodexSksSkills } from '../codex-app/codex-skill-sync.js'
import { nowIso, writeJsonAtomic } from '../fsx.js'
import { createRequestedScopeContract } from '../safety/requested-scope-contract.js'
import { evaluateMutation, mutationLedgerPath, recordMutation, type MutationLedgerKind } from '../safety/mutation-ledger.js'
import { messageOf } from '../errors/message.js'

export interface CodexNativeRepairTransaction {
  schema: 'sks.codex-native-repair-transaction.v1'
  ok: boolean
  generated_at: string
  requested_by: 'doctor --fix' | 'setup' | 'manual'
  repaired: Array<{
    asset: 'skills' | 'agent_roles' | 'hooks' | 'project_memory'
    ok: boolean
    changed: boolean
    artifact_path: string
    blockers: string[]
  }>
  confirmed: boolean
  mutation_ledger_path: string | null
  blockers: string[]
  warnings: string[]
}

export async function repairCodexNativeManagedAssets(input: {
  root: string
  requestedBy: CodexNativeRepairTransaction['requested_by']
  yes?: boolean
  repairSkills?: boolean
  repairAgentRoles?: boolean
  repairHooks?: boolean
  repairProjectMemory?: boolean
}): Promise<CodexNativeRepairTransaction> {
  const root = path.resolve(input.root)
  const requested = {
    skills: input.repairSkills !== false,
    agent_roles: input.repairAgentRoles !== false,
    hooks: input.repairHooks !== false,
    project_memory: input.repairProjectMemory !== false
  }
  const requestedAssets = Object.entries(requested)
    .filter(([, enabled]) => enabled)
    .map(([asset]) => asset as CodexNativeRepairTransaction['repaired'][number]['asset'])
  if (input.yes !== true) {
    const report: CodexNativeRepairTransaction = {
      schema: 'sks.codex-native-repair-transaction.v1',
      ok: false,
      generated_at: nowIso(),
      requested_by: input.requestedBy,
      repaired: requestedAssets.map((asset) => ({
        asset,
        ok: false,
        changed: false,
        artifact_path: artifactPathFor(asset),
        blockers: ['repair_transaction_requires_yes']
      })),
      confirmed: false,
      mutation_ledger_path: null,
      blockers: ['repair_transaction_requires_yes'],
      warnings: []
    }
    await writeJsonAtomic(path.join(root, '.sneakoscope', 'reports', 'codex-native-repair-transaction.json'), report).catch(() => undefined)
    return report
  }
  const rows: CodexNativeRepairTransaction['repaired'] = []

  if (requested.skills) {
    const report = await syncCodexSksSkills({ root, apply: true }).catch((err: unknown) => ({ ok: false, blockers: [messageOf(err)] }))
    rows.push({
      asset: 'skills',
      ok: recordOk(report) !== false,
      changed: listLength(report, 'created') > 0,
      artifact_path: '.sneakoscope/reports/codex-skill-sync.json',
      blockers: blockersOf(report)
    })
  }

  if (requested.agent_roles) {
    const report = await syncCodexAgentRoles({ root, apply: true }).catch((err: unknown) => ({ ok: false, blockers: [messageOf(err)] }))
    rows.push({
      asset: 'agent_roles',
      ok: recordOk(report) !== false,
      changed: listLength(report, 'created') + listLength(report, 'updated') > 0,
      artifact_path: '.sneakoscope/reports/codex-agent-role-sync.json',
      blockers: blockersOf(report)
    })
  }

  if (requested.hooks) {
    const report = await buildCodexHookLifecycle({ root, apply: true }).catch((err: unknown) => ({ ok: false, blockers: [messageOf(err)] }))
    rows.push({
      asset: 'hooks',
      ok: recordOk(report) !== false,
      changed: recordOk(report) !== false,
      artifact_path: '.sneakoscope/reports/codex-hook-lifecycle.json',
      blockers: blockersOf(report)
    })
  }

  if (requested.project_memory) {
    const report = await runCodexInitDeep({ root, apply: true, directoryLocal: true }).catch((err: unknown) => ({ ok: false, blockers: [messageOf(err)] }))
    rows.push({
      asset: 'project_memory',
      ok: recordOk(report) !== false,
      changed: listLength(report, 'directory_local_agents.created') + listLength(report, 'directory_local_agents.updated') > 0,
      artifact_path: '.sneakoscope/reports/codex-init-deep.json',
      blockers: blockersOf(report)
    })
  }

  const blockers = rows.flatMap((row) => row.blockers)
  const mutationWarnings = await recordRepairMutations(root, rows)
  const report: CodexNativeRepairTransaction = {
    schema: 'sks.codex-native-repair-transaction.v1',
    ok: rows.every((row) => row.ok) && blockers.length === 0,
    generated_at: nowIso(),
    requested_by: input.requestedBy,
    repaired: rows,
    confirmed: true,
    mutation_ledger_path: path.relative(root, mutationLedgerPath(root)).split(path.sep).join('/'),
    blockers: [...new Set(blockers)],
    warnings: mutationWarnings
  }
  await writeJsonAtomic(path.join(root, '.sneakoscope', 'reports', 'codex-native-repair-transaction.json'), report).catch(() => undefined)
  return report
}

async function recordRepairMutations(root: string, rows: CodexNativeRepairTransaction['repaired']): Promise<string[]> {
  const contract = createRequestedScopeContract({
    route: 'codex-native-repair-transaction',
    userRequest: 'Repair SKS-managed Codex Native assets after explicit --yes confirmation.',
    projectRoot: root,
    overrides: { global_codex_config: true }
  })
  const warnings: string[] = []
  for (const row of rows) {
    const kind: MutationLedgerKind = row.asset === 'project_memory' ? 'file_write' : 'global_config_write'
    const entry = evaluateMutation(contract, kind, {
      target: row.asset,
      confirmed: true,
      applied: row.changed,
      noOpReason: row.changed ? 'sks_managed_asset_transaction_recorded' : 'repair_noop'
    })
    await recordMutation(root, entry).catch((err: unknown) => warnings.push(`mutation_ledger_write_failed:${messageOf(err)}`))
  }
  return warnings
}

function artifactPathFor(asset: CodexNativeRepairTransaction['repaired'][number]['asset']): string {
  return asset === 'skills'
    ? '.sneakoscope/reports/codex-skill-sync.json'
    : asset === 'agent_roles'
      ? '.sneakoscope/reports/codex-agent-role-sync.json'
      : asset === 'hooks'
        ? '.sneakoscope/reports/codex-hook-lifecycle.json'
        : '.sneakoscope/reports/codex-init-deep.json'
}

function recordOk(value: unknown): boolean | undefined {
  return Boolean(value) && typeof value === 'object' && typeof (value as { ok?: unknown }).ok === 'boolean'
    ? (value as { ok: boolean }).ok
    : undefined
}

function blockersOf(value: unknown): string[] {
  return Boolean(value) && typeof value === 'object' && Array.isArray((value as { blockers?: unknown }).blockers)
    ? (value as { blockers: unknown[] }).blockers.map((item) => String(item)).filter(Boolean)
    : []
}

function listLength(value: unknown, key: string): number {
  const parts = key.split('.')
  let current: unknown = value
  for (const part of parts) {
    if (!current || typeof current !== 'object') return 0
    current = (current as Record<string, unknown>)[part]
  }
  return Array.isArray(current) ? current.length : 0
}
