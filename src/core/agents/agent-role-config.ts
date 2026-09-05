import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { nowIso, readText, writeJsonAtomic } from '../fsx.js'
import {
  inspectConfinedPath,
  moveConfinedPath,
  removeConfinedDirectoryIfEmpty,
  removeManagedPathVerified,
  uniqueConfinedPath,
  walkConfinedEntries
} from '../managed-path-safety.js'
import {
  MANAGED_OFFICIAL_SUBAGENT_ROLES,
  RETIRED_MANAGED_AGENT_ROLE_TOMBSTONES,
  managedAgentRoleOwnsText,
  managedOfficialSubagentRoleByFile,
  managedOfficialSubagentRoleByName,
  managedOfficialSubagentRoleContent
} from '../managed-assets/managed-assets-manifest.js'
import { installOfficialSubagentAgentConfigs, refreshGlobalOfficialSubagentAgentConfigs } from '../subagents/official-subagent-config.js'

export const AGENT_ROLE_CONFIG_REPAIR_SCHEMA = 'sks.agent-role-config-repair.v1'

export const SKS_OWNED_AGENT_CONFIGS = new Map<string, {
  name: string
  sandbox: 'read-only' | 'workspace-write' | null
  content: string
  id: string
}>([
  ...MANAGED_OFFICIAL_SUBAGENT_ROLES.map((role) => [
    role.filename,
    { name: role.codex_name, sandbox: role.sandbox ?? null, content: managedOfficialSubagentRoleContent(role), id: role.id }
  ] as const),
])

export function managedAgentRoleConfigForFile(file: string): string | null {
  const official = managedOfficialSubagentRoleByFile(file)
  return official ? managedOfficialSubagentRoleContent(official) : null
}

export function managedAgentRoleConfigForRole(role: string): { file: string; content: string } | null {
  const official = managedOfficialSubagentRoleByName(role)
  return official ? { file: official.filename, content: managedOfficialSubagentRoleContent(official) } : null
}

export async function repairAgentRoleConfigs(input: {
  root: string
  apply?: boolean
  reportPath?: string
  home?: string
  codexHome?: string
  globalRuntimeRoot?: string
}) {
  const root = path.resolve(input.root)
  const defaultHome = path.resolve(input.home || process.env.HOME || os.homedir())
  const codexHome = path.resolve(input.codexHome || process.env.CODEX_HOME || path.join(defaultHome, '.codex'))
  const home = path.resolve(input.home || (input.codexHome ? path.dirname(codexHome) : defaultHome))
  const retiredRoleCleanup = await reconcileRetiredAgentRoleResidue({
    root,
    home,
    codexHome,
    ...(input.globalRuntimeRoot ? { globalRuntimeRoot: input.globalRuntimeRoot } : {}),
    fix: input.apply === true
  })
  const officialRepair = await installOfficialSubagentAgentConfigs(root, { apply: input.apply === true })
  const globalRepair = path.join(root, '.codex') === codexHome
    ? null
    : await refreshGlobalOfficialSubagentAgentConfigs(codexHome, { apply: input.apply === true })
  const globalPath = (file: string) => path.join(path.dirname(codexHome), file)
  const missing: string[] = [...officialRepair.missing]
  const stale: string[] = [...officialRepair.stale, ...(globalRepair?.stale.map(globalPath) || [])]
  const created: string[] = [...officialRepair.created]
  const repaired: string[] = [...officialRepair.updated, ...(globalRepair?.updated.map(globalPath) || [])]
  const existing: string[] = [...officialRepair.existing, ...(globalRepair?.existing.map(globalPath) || [])]
  const manualBlockers: string[] = [
    ...officialRepair.manual_blockers,
    ...(globalRepair?.manual_blockers.map((blocker) => `global:${blocker}`) || [])
  ]
  const requiredFixes = missing.length + stale.length
  const appliedFixes = created.length + repaired.length
  const report = {
    schema: AGENT_ROLE_CONFIG_REPAIR_SCHEMA,
    generated_at: nowIso(),
    ok: input.apply
      ? requiredFixes === appliedFixes && manualBlockers.length === 0 && retiredRoleCleanup.ok
      : manualBlockers.length === 0 && retiredRoleCleanup.ok && (globalRepair?.stale.length || 0) === 0,
    apply: input.apply === true,
    missing,
    stale,
    existing,
    created,
    repaired,
    backups: [...officialRepair.backups, ...(globalRepair?.backups.map(globalPath) || [])],
    global_role_repair: globalRepair,
    manual_blockers: manualBlockers,
    manifest_role_ids: MANAGED_OFFICIAL_SUBAGENT_ROLES.map((role) => role.id),
    retired_role_cleanup: retiredRoleCleanup,
    warnings_suppressed: true,
    blockers: [
      ...manualBlockers,
      ...(!input.apply ? (globalRepair?.stale.map((file) => `stale_global_official_subagent_agent:${globalPath(file)}`) || []) : []),
      ...(input.apply && requiredFixes !== appliedFixes ? ['agent_role_config_repair_incomplete'] : []),
      ...(!retiredRoleCleanup.ok ? ['retired_agent_role_cleanup_incomplete'] : [])
    ]
  }
  if (input.reportPath) await writeJsonAtomic(input.reportPath, report)
  return report
}

export async function reconcileRetiredAgentRoleResidue(input: {
  root: string
  home?: string
  codexHome?: string
  globalRuntimeRoot?: string
  fix: boolean
}) {
  const root = path.resolve(input.root)
  const home = path.resolve(input.home || process.env.HOME || os.homedir())
  const codexHome = path.resolve(input.codexHome || process.env.CODEX_HOME || path.join(home, '.codex'))
  const globalRuntimeRoot = path.resolve(input.globalRuntimeRoot || process.env.SKS_GLOBAL_ROOT || path.join(home, '.sneakoscope-global'))
  const targets = uniqueTargets([
    { scope: 'project', ownerRoot: root, agentsDir: path.join(root, '.codex', 'agents'), kind: 'active' as const },
    { scope: 'global', ownerRoot: codexHome, agentsDir: path.join(codexHome, 'agents'), kind: 'active' as const },
    { scope: 'global-runtime', ownerRoot: globalRuntimeRoot, agentsDir: path.join(globalRuntimeRoot, '.codex', 'agents'), kind: 'active' as const },
    { scope: 'project-disabled', ownerRoot: root, agentsDir: path.join(root, '.codex', 'agents-disabled', 'sks'), kind: 'backup' as const },
    { scope: 'global-disabled', ownerRoot: codexHome, agentsDir: path.join(codexHome, 'agents-disabled', 'sks'), kind: 'backup' as const },
    { scope: 'global-runtime-disabled', ownerRoot: globalRuntimeRoot, agentsDir: path.join(globalRuntimeRoot, '.codex', 'agents-disabled', 'sks'), kind: 'backup' as const }
  ])
  const counters = { detected: 0, removed: 0, quarantined: 0, remaining: 0, errors: 0 }
  const runId = `${Date.now()}-${process.pid}`

  for (const target of targets) {
    const ownerStat = await fsp.lstat(target.ownerRoot).catch((error: any) => error?.code === 'ENOENT' ? null : Promise.reject(error))
    if (!ownerStat) continue
    if (ownerStat.isSymbolicLink() || !ownerStat.isDirectory()) {
      counters.errors += 1
      counters.remaining += 1
      continue
    }
    const rootInspection = await inspectConfinedPath(target.ownerRoot, target.agentsDir).catch(() => null)
    if (!rootInspection) {
      counters.errors += 1
      counters.remaining += 1
      continue
    }
    if (!rootInspection.exists) continue
    if (rootInspection.leafSymlink || !rootInspection.stat?.isDirectory()) {
      await reconcileAgentRoleCollision(target, target.agentsDir, input.fix, runId, counters)
      continue
    }

    if (target.kind === 'active') {
      for (const role of RETIRED_MANAGED_AGENT_ROLE_TOMBSTONES) {
        const file = path.join(target.agentsDir, role.filename)
        const inspected = await inspectConfinedPath(target.ownerRoot, file).catch(() => null)
        if (!inspected) {
          counters.errors += 1
          counters.remaining += 1
          continue
        }
        if (!inspected.exists) continue
        await reconcileRetiredRoleFile(target, file, role, input.fix, runId, counters)
      }
      const walked = await walkConfinedEntries(target.ownerRoot, target.agentsDir)
      counters.errors += walked.errors.length
      counters.remaining += walked.errors.length
      for (const file of walked.entries) {
        const role = retiredRoleForBackup(path.basename(file))
        if (!role || path.basename(file) === role.filename) continue
        await reconcileRetiredRoleFile(target, file, role, input.fix, runId, counters)
      }
    } else {
      const walked = await walkConfinedEntries(target.ownerRoot, target.agentsDir)
      counters.errors += walked.errors.length
      counters.remaining += walked.errors.length
      for (const file of walked.entries) {
        const role = retiredRoleForBackup(path.basename(file))
        if (!role) continue
        await reconcileRetiredRoleFile(target, file, role, input.fix, runId, counters)
      }
    }
    if (input.fix) await removeConfinedDirectoryIfEmpty(target.ownerRoot, target.agentsDir).catch(() => { counters.errors += 1 })
  }

  return {
    schema: 'sks.retired-agent-role-cleanup.v1',
    ok: counters.remaining === 0 && counters.errors === 0,
    fix: input.fix,
    detected_count: counters.detected,
    removed_count: counters.removed,
    quarantined_user_collision_count: counters.quarantined,
    remaining_count: counters.remaining,
    error_count: counters.errors
  }
}

type RetiredRoleTarget = {
  scope: string
  ownerRoot: string
  agentsDir: string
  kind: 'active' | 'backup'
}

function uniqueTargets<T extends { agentsDir: string }>(targets: T[]): T[] {
  const rows = new Map<string, T>()
  for (const target of targets) rows.set(path.resolve(target.agentsDir), target)
  return [...rows.values()]
}

async function reconcileRetiredRoleFile(
  target: RetiredRoleTarget,
  file: string,
  role: (typeof RETIRED_MANAGED_AGENT_ROLE_TOMBSTONES)[number],
  fix: boolean,
  runId: string,
  counters: { detected: number; removed: number; quarantined: number; remaining: number; errors: number }
): Promise<void> {
  counters.detected += 1
  if (!fix) {
    counters.remaining += 1
    return
  }
  try {
    const inspected = await inspectConfinedPath(target.ownerRoot, file)
    const managed = !inspected.leafSymlink && inspected.stat?.isFile()
      && managedAgentRoleOwnsText(await readText(file, ''), role)
    if (managed) {
      await removeManagedPathVerified(target.ownerRoot, file)
      counters.removed += 1
    } else {
      await quarantineAgentRoleCollision(target, file, runId)
      counters.quarantined += 1
    }
  } catch {
    counters.errors += 1
    counters.remaining += 1
  }
}

async function reconcileAgentRoleCollision(
  target: RetiredRoleTarget,
  file: string,
  fix: boolean,
  runId: string,
  counters: { detected: number; removed: number; quarantined: number; remaining: number; errors: number }
): Promise<void> {
  counters.detected += 1
  if (!fix) {
    counters.remaining += 1
    return
  }
  try {
    await quarantineAgentRoleCollision(target, file, runId)
    counters.quarantined += 1
  } catch {
    counters.errors += 1
    counters.remaining += 1
  }
}

async function quarantineAgentRoleCollision(target: RetiredRoleTarget, file: string, runId: string): Promise<void> {
  const relative = path.relative(target.ownerRoot, file)
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('retired_agent_role_quarantine_escape')
  const quarantineBase = path.join(target.ownerRoot, '.sneakoscope', 'quarantine', 'retired-agent-roles', runId, target.scope, relative)
  const destination = await uniqueConfinedPath(target.ownerRoot, quarantineBase)
  await moveConfinedPath(target.ownerRoot, file, destination)
}

function retiredRoleForBackup(name: string): (typeof RETIRED_MANAGED_AGENT_ROLE_TOMBSTONES)[number] | null {
  return RETIRED_MANAGED_AGENT_ROLE_TOMBSTONES.find((role) => {
    const stem = role.filename.replace(/\.toml$/i, '')
    return name === role.filename
      || (name.endsWith('.bak') && (name.startsWith(role.filename) || name.startsWith(`${stem}.`) || name.startsWith(`${stem}-`)))
  }) || null
}
