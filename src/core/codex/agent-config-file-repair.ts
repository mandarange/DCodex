import fs from 'node:fs/promises'
import path from 'node:path'
import { nowIso, readJson, writeJsonAtomic } from '../fsx.js'
import {
  SKS_MANAGED_CODEX_CONFIG_MARKER,
  backupInvalidToml,
  inspectOfficialSubagentToml,
  mergeOfficialSubagentConfigResult,
  officialSubagentConfigOwnershipProof,
  officialSubagentConfigWarnings,
  readInheritedOfficialSubagentConfigText
} from '../subagents/official-subagent-config.js'
import { isCodexHomeConfigPath, writeCodexConfigGuarded } from './codex-config-guard.js'

export interface AgentConfigFileRepairReport {
  schema: 'sks.agent-config-file-repair.v1'
  generated_at: string
  ok: boolean
  apply: boolean
  config_path: string
  backup_path: string | null
  repaired_paths: string[]
  created_files: string[]
  removed_unsupported_fields: string[]
  skipped_unmanaged_paths: string[]
  manual_required: boolean
  blockers: string[]
  warnings: string[]
  operator_actions: string[]
  ownership_proof: {
    owned: boolean
    reasons: string[]
  }
}

/**
 * `user_owned_file_without_sks_marker` names a state, not a remedy, and the
 * doctor summary drops it. Ship the manual step with the blocker so a refused
 * repair is recoverable without reading the source.
 */
function unmanagedConfigOperatorAction(configPath: string): string {
  return `Refused to modify ${configPath}: no SKS ownership proof. `
    + `If SKS owns this file, add the line \`${SKS_MANAGED_CODEX_CONFIG_MARKER}\` as its first line `
    + 'and re-run `sks doctor --fix`. Otherwise run `sks setup` to regenerate a managed config.'
}

/**
 * Compatibility entrypoint retained for doctor callers. It repairs the
 * official project [agents] settings and removes only exact legacy SKS child
 * tables after ownership has been proven. User-authored child tables remain.
 */
export async function repairAgentConfigFileReferences(input: {
  root: string
  apply?: boolean
  reportPath?: string | null
  home?: string
  codexHome?: string
}): Promise<AgentConfigFileRepairReport> {
  const root = path.resolve(input.root)
  const configPath = path.join(root, '.codex', 'config.toml')
  // Running `sks doctor`/`sks setup` from the home directory makes the project
  // root the home directory, so this "project config" is really the host-owned
  // global Codex config. Rewriting it — and, since 8.5.0, stamping the SKS
  // ownership marker into it — claims a file SKS does not own.
  if (isCodexHomeConfigPath(configPath, {
    ...(input.home ? { home: input.home } : {}),
    ...(input.codexHome ? { codexHome: input.codexHome } : {})
  })) {
    return writeReport(input.reportPath, root, {
      schema: 'sks.agent-config-file-repair.v1',
      generated_at: nowIso(),
      ok: true,
      apply: input.apply === true,
      config_path: configPath,
      backup_path: null,
      repaired_paths: [],
      created_files: [],
      removed_unsupported_fields: [],
      skipped_unmanaged_paths: [configPath],
      manual_required: false,
      blockers: [],
      warnings: ['project_config_is_codex_home_noop'],
      operator_actions: [
        `${configPath} is the global Codex config, not a project config — SKS left it untouched. `
        + 'Run `sks doctor` from a project directory so the project config is repaired instead.'
      ],
      ownership_proof: { owned: false, reasons: [] }
    })
  }
  const configExists = await fs.stat(configPath).then((stat) => stat.isFile()).catch(() => false)
  const original = configExists ? await fs.readFile(configPath, 'utf8').catch(() => '') : ''
  const manifest = await readJson(path.join(root, '.sneakoscope', 'manifest.json'), null)
  const migrationReceipt = await readJson(path.join(root, '.sneakoscope', 'update', 'migration-receipt.json'), null)
  const ownershipProof = officialSubagentConfigOwnershipProof({
    text: original,
    manifest,
    migrationReceipt
  })
  const originalValidation = inspectOfficialSubagentToml(original)

  if (configExists && !originalValidation.ok) {
    const backupPath = input.apply
      ? await backupInvalidToml(configPath, original, 'doctor-project-config-invalid')
      : null
    return writeReport(input.reportPath, root, {
      schema: 'sks.agent-config-file-repair.v1',
      generated_at: nowIso(),
      ok: false,
      apply: input.apply === true,
      config_path: configPath,
      backup_path: backupPath,
      repaired_paths: [],
      created_files: [],
      removed_unsupported_fields: [],
      skipped_unmanaged_paths: [],
      manual_required: true,
      blockers: [
        'project_official_subagent_config_toml_parse_failed',
        ...(!ownershipProof.owned ? ['user_owned_file_without_sks_marker'] : [])
      ],
      warnings: [],
      operator_actions: [
        `${configPath} is not valid TOML; SKS preserved it and wrote a backup. Fix the syntax, then re-run \`sks doctor --fix\`.`,
        ...(!ownershipProof.owned ? [unmanagedConfigOperatorAction(configPath)] : [])
      ],
      ownership_proof: ownershipProof
    })
  }

  if (input.apply && configExists && !ownershipProof.owned) {
    return writeReport(input.reportPath, root, {
      schema: 'sks.agent-config-file-repair.v1',
      generated_at: nowIso(),
      ok: false,
      apply: true,
      config_path: configPath,
      backup_path: null,
      repaired_paths: [],
      created_files: [],
      removed_unsupported_fields: [],
      skipped_unmanaged_paths: [],
      manual_required: true,
      blockers: ['user_owned_file_without_sks_marker'],
      warnings: [],
      operator_actions: [unmanagedConfigOperatorAction(configPath)],
      ownership_proof: ownershipProof
    })
  }

  const inheritedText = await readInheritedOfficialSubagentConfigText(configPath, {
    ...(input.home ? { home: input.home } : {}),
    ...(input.codexHome ? { codexHome: input.codexHome } : {})
  })
  const mergeResult = mergeOfficialSubagentConfigResult(original, {
    sksOwned: ownershipProof.owned,
    inheritedText
  })
  const merged = mergeResult.text
  const validation = inspectOfficialSubagentToml(merged)
  const warnings = officialSubagentConfigWarnings(merged, inheritedText)
  const blockers: string[] = [...mergeResult.blockers]
  let changed = merged !== original
  let writeSucceeded = input.apply !== true
  let backupPath: string | null = null

  if (input.apply) {
    const guarded = await writeCodexConfigGuarded({
      root,
      configPath,
      before: original,
      cause: 'official-subagent-config-repair',
      ownershipVerified: ownershipProof.owned,
      mutate: () => merged
    })
    writeSucceeded = guarded.ok
    changed = guarded.ok && guarded.changed
    backupPath = guarded.backup_path
    if (!guarded.ok) blockers.push(`config_write_guard:${guarded.status}`)
  } else if (!validation.ok) {
    blockers.push('project_official_subagent_config_toml_parse_failed')
  }

  const report: AgentConfigFileRepairReport = {
    schema: 'sks.agent-config-file-repair.v1',
    generated_at: nowIso(),
    ok: blockers.length === 0,
    apply: input.apply === true,
    config_path: configPath,
    backup_path: backupPath,
    repaired_paths: changed && writeSucceeded ? [configPath] : [],
    created_files: input.apply === true && !configExists && changed && writeSucceeded ? [configPath] : [],
    removed_unsupported_fields: [],
    skipped_unmanaged_paths: [],
    manual_required: blockers.length > 0,
    blockers,
    warnings,
    operator_actions: blockers.map((blocker) => blocker === 'user_owned_file_without_sks_marker'
      ? unmanagedConfigOperatorAction(configPath)
      : `${configPath}: ${blocker}. Re-run \`sks doctor --fix\` after resolving it, or run \`sks setup\` to regenerate a managed config.`),
    ownership_proof: ownershipProof
  }
  return writeReport(input.reportPath, root, report)
}

// Retained for compatibility with the startup postcheck API. Official custom
// agents are discovered from .codex/agents and do not require config_file
// references; legacy references are intentionally ignored and preserved.
export async function missingAgentConfigFiles(_text: string): Promise<string[]> {
  return []
}

async function writeReport(
  reportPath: string | null | undefined,
  root: string,
  report: AgentConfigFileRepairReport
): Promise<AgentConfigFileRepairReport> {
  if (reportPath !== null) {
    await writeJsonAtomic(reportPath || path.join(root, '.sneakoscope', 'reports', 'agent-config-file-repair.json'), report).catch(() => undefined)
  }
  return report
}
