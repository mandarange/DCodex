import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { parse } from 'smol-toml'
import { ensureDir, exists, PACKAGE_VERSION, readText, sha256, writeTextAtomic } from '../fsx.js'
import { ensureConfinedDirectory, inspectConfinedPath } from '../managed-path-safety.js'
import {
  MANAGED_OFFICIAL_SUBAGENT_ROLES,
  managedOfficialSubagentRoleContent,
  managedOfficialSubagentRoleOwnsText,
  type ManagedOfficialSubagentRole
} from '../managed-assets/managed-assets-manifest.js'
import {
  DEFAULT_SUBAGENT_EFFORT,
  DEFAULT_SUBAGENT_MODEL
} from './model-policy.js'
import { escapeRegExp } from '../text/regex.js'

/** Spawned child-thread hard cap (excludes the root/parent thread). */
export const DEFAULT_OFFICIAL_SUBAGENT_MAX_THREADS = 12
/** V1-only nesting limit. Ignored by multi-agent V2; kept at 1 for fail-closed depth. */
export const DEFAULT_OFFICIAL_SUBAGENT_MAX_DEPTH = 1
/** @deprecated Removed from Codex 0.145 AgentsToml. Retained only for SKS-internal callers. */
export const DEFAULT_OFFICIAL_SUBAGENT_JOB_MAX_RUNTIME_SECONDS = 1200
export const DEFAULT_OFFICIAL_SUBAGENT_INTERRUPT_MESSAGE = true
export const DEFAULT_OFFICIAL_SUBAGENT_ENABLED = true
export const DEFAULT_OFFICIAL_SUBAGENT_MODEL = DEFAULT_SUBAGENT_MODEL
export const DEFAULT_OFFICIAL_SUBAGENT_REASONING_EFFORT = DEFAULT_SUBAGENT_EFFORT
/** MA v2 total concurrency = spawned children + root thread. */
export const DEFAULT_MULTI_AGENT_V2_MAX_CONCURRENT_THREADS_PER_SESSION =
  DEFAULT_OFFICIAL_SUBAGENT_MAX_THREADS + 1
export const LEGACY_SKS_MAX_THREAD_VALUES = Object.freeze([4, 5, 6])
export const AGENTS_MAX_CONCURRENT_THREADS_KEY = 'max_concurrent_threads_per_session'
export const LEGACY_AGENTS_MAX_THREADS_KEY = 'max_threads'
export const LEGACY_AGENTS_JOB_MAX_RUNTIME_KEY = 'job_max_runtime_seconds'

export interface OfficialSubagentConfig {
  enabled: boolean
  maxThreads: number
  maxDepth: number
  /** Always null for Codex 0.145+; retained for postcheck compatibility. */
  jobMaxRuntimeSeconds: number | null
  interruptMessage: boolean
  defaultSubagentModel: string
  defaultSubagentReasoningEffort: string
  multiAgentV2: {
    enabled: boolean
    maxConcurrentThreadsPerSession: number
    exposeSpawnAgentModelOverrides: boolean
  }
  sources: {
    enabled: 'project' | 'global' | 'default'
    maxThreads: 'project' | 'global' | 'default'
    maxDepth: 'project' | 'global' | 'default'
    interruptMessage: 'project' | 'global' | 'default'
    defaultSubagentModel: 'project' | 'global' | 'default'
    defaultSubagentReasoningEffort: 'project' | 'global' | 'default'
    multiAgentV2: 'project' | 'global' | 'default'
  }
  projectConfigPath: string
  globalConfigPath: string | null
  blockers: string[]
  warnings: string[]
}

export interface OfficialSubagentConfigMergeOptions {
  sksOwned?: boolean
  inheritedText?: string
  defaultMaxThreads?: number
}

export interface OfficialSubagentConfigOwnershipProof {
  owned: boolean
  reasons: string[]
}

export interface OfficialSubagentAgentInstallResult {
  schema: 'sks.official-subagent-agent-install.v1'
  ok: boolean
  apply: boolean
  installed_agents: string[]
  missing: string[]
  existing: string[]
  stale: string[]
  created: string[]
  updated: string[]
  preserved: string[]
  invalid: string[]
  backups: string[]
  manual_blockers: string[]
  generated_files: string[]
}

/**
 * Merge project-scoped Codex multi-agent V2 defaults without overriding explicit
 * project or inherited global values. Migrates legacy `agents.max_threads` and
 * strips removed `job_max_runtime_seconds` only when SKS ownership is proven.
 */
export function mergeOfficialSubagentConfig(
  text: string = '',
  opts: OfficialSubagentConfigMergeOptions = {}
): string {
  const source = String(text || '')
  if (!inspectToml(source).ok) return source

  const inherited = parsedToml(opts.inheritedText || '')
  const inheritedAgents = objectValue(inherited?.agents)
  const inheritedFeatures = objectValue(inherited?.features)
  let next = source.trimEnd()
  if (!next.trim()) next = '# SKS-MANAGED-CODEX-CONFIG'
  if (opts.sksOwned === true) {
    next = removeExactLegacyManagedAgentBlocks(next)
    next = stripLegacyUnsupportedAgentKeys(next)
  }

  const targetMaxThreads = positiveInteger(opts.defaultMaxThreads) || DEFAULT_OFFICIAL_SUBAGENT_MAX_THREADS
  next = migrateLegacyMaxThreads(next, {
    sksOwned: opts.sksOwned === true,
    targetMaxThreads,
    inheritedAgents
  })

  next = upsertDefaultUnlessInherited(
    next,
    inheritedAgents,
    'enabled',
    `enabled = ${DEFAULT_OFFICIAL_SUBAGENT_ENABLED}`
  )
  next = upsertDefaultUnlessInherited(
    next,
    inheritedAgents,
    'max_depth',
    `max_depth = ${DEFAULT_OFFICIAL_SUBAGENT_MAX_DEPTH}`
  )
  next = upsertDefaultUnlessInherited(
    next,
    inheritedAgents,
    'interrupt_message',
    `interrupt_message = ${DEFAULT_OFFICIAL_SUBAGENT_INTERRUPT_MESSAGE}`
  )
  next = upsertDefaultUnlessInherited(
    next,
    inheritedAgents,
    'default_subagent_model',
    `default_subagent_model = "${DEFAULT_OFFICIAL_SUBAGENT_MODEL}"`
  )
  next = upsertDefaultUnlessInherited(
    next,
    inheritedAgents,
    'default_subagent_reasoning_effort',
    `default_subagent_reasoning_effort = "${DEFAULT_OFFICIAL_SUBAGENT_REASONING_EFFORT}"`
  )

  next = mergeOfficialMultiAgentV2FeatureConfig(next, {
    sksOwned: opts.sksOwned === true,
    inheritedFeatures,
    maxThreads: readAgentsMaxThreads(next) || targetMaxThreads
  })

  const merged = ensureTrailingNewline(next)
  return inspectToml(merged).ok ? merged : source
}

export function mergeOfficialMultiAgentV2FeatureConfig(
  text: string = '',
  opts: {
    sksOwned?: boolean
    inheritedFeatures?: Record<string, unknown>
    maxThreads?: number
  } = {}
): string {
  const source = String(text || '')
  if (!inspectToml(source).ok) return source
  const inheritedFeatures = objectValue(opts.inheritedFeatures)
  const inheritedMaV2 = featureTomlObject(inheritedFeatures.multi_agent_v2)
  let next = source.trimEnd()
  if (!next.trim()) next = '# SKS-MANAGED-CODEX-CONFIG'

  // Prefer the table form so concurrency and spawn model overrides can be set.
  // Boolean `features.multi_agent_v2 = true` alone cannot carry those knobs.
  if (hasTomlTableKey(next, 'features', 'multi_agent_v2')) {
    next = removeTomlTableKey(next, 'features', 'multi_agent_v2')
  }

  const maxThreads = positiveInteger(opts.maxThreads) || DEFAULT_OFFICIAL_SUBAGENT_MAX_THREADS
  const targetTotal = Math.max(1, maxThreads + 1)

  if (!hasTomlTable(next, 'features.multi_agent_v2')) {
    if (inheritedMaV2) return ensureTrailingNewline(next)
    next = upsertTomlTable(
      next,
      'features.multi_agent_v2',
      [
        '[features.multi_agent_v2]',
        'enabled = true',
        `max_concurrent_threads_per_session = ${targetTotal}`,
        'expose_spawn_agent_model_overrides = true'
      ].join('\n')
    )
    return ensureTrailingNewline(next)
  }

  if (opts.sksOwned === true) {
    next = upsertTomlTableKey(next, 'features.multi_agent_v2', 'enabled = true')
    if (!hasTomlTableKey(next, 'features.multi_agent_v2', 'max_concurrent_threads_per_session')) {
      next = upsertTomlTableKey(
        next,
        'features.multi_agent_v2',
        `max_concurrent_threads_per_session = ${targetTotal}`
      )
    }
    if (!hasTomlTableKey(next, 'features.multi_agent_v2', 'expose_spawn_agent_model_overrides')) {
      next = upsertTomlTableKey(
        next,
        'features.multi_agent_v2',
        'expose_spawn_agent_model_overrides = true'
      )
    }
  } else {
    const inherited = inheritedMaV2 || {}
    if (!hasTomlTableKey(next, 'features.multi_agent_v2', 'enabled') && !hasOwn(inherited, 'enabled')) {
      next = upsertTomlTableKey(next, 'features.multi_agent_v2', 'enabled = true')
    }
    if (
      !hasTomlTableKey(next, 'features.multi_agent_v2', 'max_concurrent_threads_per_session')
      && !hasOwn(inherited, 'max_concurrent_threads_per_session')
    ) {
      next = upsertTomlTableKey(
        next,
        'features.multi_agent_v2',
        `max_concurrent_threads_per_session = ${targetTotal}`
      )
    }
    if (
      !hasTomlTableKey(next, 'features.multi_agent_v2', 'expose_spawn_agent_model_overrides')
      && !hasOwn(inherited, 'expose_spawn_agent_model_overrides')
    ) {
      next = upsertTomlTableKey(
        next,
        'features.multi_agent_v2',
        'expose_spawn_agent_model_overrides = true'
      )
    }
  }

  return ensureTrailingNewline(next)
}

export async function readOfficialSubagentConfig(
  root: string,
  opts: { home?: string; codexHome?: string; projectConfigPath?: string } = {}
): Promise<OfficialSubagentConfig> {
  const projectConfigPath = path.resolve(opts.projectConfigPath || path.join(root, '.codex', 'config.toml'))
  const home = opts.home || process.env.HOME || os.homedir()
  const codexHome = opts.codexHome || process.env.CODEX_HOME || path.join(home, '.codex')
  const candidateGlobalPath = path.resolve(codexHome, 'config.toml')
  const globalConfigPath = candidateGlobalPath === projectConfigPath ? null : candidateGlobalPath
  const projectText = await readText(projectConfigPath, '')
  const globalText = globalConfigPath ? await readText(globalConfigPath, '') : ''
  const projectLayer = configLayer(projectText, 'project')
  const globalLayer = configLayer(globalText, 'global')
  const blockers = [...projectLayer.blockers, ...globalLayer.blockers]

  const enabled = resolveLayeredValue(
    projectLayer.agents.enabled,
    globalLayer.agents.enabled,
    DEFAULT_OFFICIAL_SUBAGENT_ENABLED,
    booleanValue
  )
  const maxThreads = resolveLayeredValue(
    readAgentsMaxThreadsFromRecord(projectLayer.agents),
    readAgentsMaxThreadsFromRecord(globalLayer.agents),
    DEFAULT_OFFICIAL_SUBAGENT_MAX_THREADS,
    positiveInteger
  )
  const maxDepth = resolveLayeredValue(
    projectLayer.agents.max_depth,
    globalLayer.agents.max_depth,
    DEFAULT_OFFICIAL_SUBAGENT_MAX_DEPTH,
    positiveInteger
  )
  const interruptMessage = resolveLayeredValue(
    projectLayer.agents.interrupt_message,
    globalLayer.agents.interrupt_message,
    DEFAULT_OFFICIAL_SUBAGENT_INTERRUPT_MESSAGE,
    booleanValue
  )
  const defaultSubagentModel = resolveLayeredValue(
    projectLayer.agents.default_subagent_model,
    globalLayer.agents.default_subagent_model,
    DEFAULT_OFFICIAL_SUBAGENT_MODEL,
    nonEmptyString
  )
  const defaultSubagentReasoningEffort = resolveLayeredValue(
    projectLayer.agents.default_subagent_reasoning_effort,
    globalLayer.agents.default_subagent_reasoning_effort,
    DEFAULT_OFFICIAL_SUBAGENT_REASONING_EFFORT,
    nonEmptyString
  )
  const multiAgentV2 = resolveMultiAgentV2Layer(
    projectLayer.features.multi_agent_v2,
    globalLayer.features.multi_agent_v2,
    maxThreads.value
  )

  const depthCoerced = maxDepth.value > 1
  const warnings = [
    ...(depthCoerced ? [`official_subagent_max_depth_coerced_to_one:${maxDepth.value}:${maxDepth.source}`] : []),
    ...(projectLayer.legacyWarnings),
    ...(globalLayer.legacyWarnings)
  ]

  return {
    enabled: enabled.value,
    maxThreads: maxThreads.value,
    maxDepth: depthCoerced ? DEFAULT_OFFICIAL_SUBAGENT_MAX_DEPTH : maxDepth.value,
    jobMaxRuntimeSeconds: null,
    interruptMessage: interruptMessage.value,
    defaultSubagentModel: defaultSubagentModel.value,
    defaultSubagentReasoningEffort: defaultSubagentReasoningEffort.value,
    multiAgentV2: multiAgentV2.value,
    sources: {
      enabled: enabled.source,
      maxThreads: maxThreads.source,
      maxDepth: depthCoerced ? 'default' : maxDepth.source,
      interruptMessage: interruptMessage.source,
      defaultSubagentModel: defaultSubagentModel.source,
      defaultSubagentReasoningEffort: defaultSubagentReasoningEffort.source,
      multiAgentV2: multiAgentV2.source
    },
    projectConfigPath,
    globalConfigPath,
    blockers,
    warnings
  }
}

export function officialSubagentConfigWarnings(text: string = '', inheritedText: string = ''): string[] {
  const project = configLayer(text, 'project')
  const inherited = configLayer(inheritedText, 'global')
  if (project.blockers.length || inherited.blockers.length) return []
  const maxDepth = resolveLayeredValue(
    project.agents.max_depth,
    inherited.agents.max_depth,
    DEFAULT_OFFICIAL_SUBAGENT_MAX_DEPTH,
    positiveInteger
  )
  return [
    ...(maxDepth.value > 1
      ? [`official_subagent_max_depth_coerced_to_one:${maxDepth.value}:${maxDepth.source}`]
      : []),
    ...project.legacyWarnings,
    ...inherited.legacyWarnings
  ]
}

export async function readInheritedOfficialSubagentConfigText(
  projectConfigPath: string,
  opts: { home?: string; codexHome?: string } = {}
): Promise<string> {
  const globalConfigPath = resolveInheritedOfficialSubagentConfigPath(projectConfigPath, opts)
  return globalConfigPath ? readText(globalConfigPath, '') : ''
}

export function resolveInheritedOfficialSubagentConfigPath(
  projectConfigPath: string,
  opts: { home?: string; codexHome?: string } = {}
): string | null {
  const home = opts.home || process.env.HOME || os.homedir()
  const codexHome = opts.codexHome || process.env.CODEX_HOME || path.join(home, '.codex')
  const globalConfigPath = path.resolve(codexHome, 'config.toml')
  return globalConfigPath === path.resolve(projectConfigPath) ? null : globalConfigPath
}

export async function installOfficialSubagentAgentConfigs(
  root: string,
  opts: { apply?: boolean } = {}
): Promise<OfficialSubagentAgentInstallResult> {
  const apply = opts.apply !== false
  const agentsDir = path.join(path.resolve(root), '.codex', 'agents')
  const missing: string[] = []
  const existing: string[] = []
  const stale: string[] = []
  const created: string[] = []
  const updated: string[] = []
  const preserved: string[] = []
  const invalid: string[] = []
  const backups: string[] = []
  const manualBlockers: string[] = []
  const generatedFiles: string[] = []

  const agentsInspection = await inspectConfinedPath(root, agentsDir).catch(() => null)
  if (!agentsInspection) {
    manualBlockers.push('official_subagent_agents_dir_unsafe')
  } else if (agentsInspection.leafSymlink) {
    manualBlockers.push('official_subagent_agents_dir_symlink_refused')
  } else if (agentsInspection.exists && !agentsInspection.stat?.isDirectory()) {
    manualBlockers.push('official_subagent_agents_dir_not_directory')
  }
  if (manualBlockers.length) {
    return {
      schema: 'sks.official-subagent-agent-install.v1',
      ok: false,
      apply,
      installed_agents: MANAGED_OFFICIAL_SUBAGENT_ROLES.map((role) => role.codex_name),
      missing: MANAGED_OFFICIAL_SUBAGENT_ROLES.map((role) => role.filename),
      existing,
      stale,
      created,
      updated,
      preserved,
      invalid,
      backups,
      manual_blockers: manualBlockers,
      generated_files: generatedFiles
    }
  }
  if (apply) await ensureConfinedDirectory(root, agentsDir)
  for (const role of MANAGED_OFFICIAL_SUBAGENT_ROLES) {
    const absolute = path.join(agentsDir, role.filename)
    const relative = `.codex/agents/${role.filename}`
    const expected = managedOfficialSubagentRoleContent(role)
    const inspected = await inspectConfinedPath(root, absolute).catch(() => null)
    if (!inspected) {
      preserved.push(relative)
      manualBlockers.push(`manual_unsafe_official_subagent_path:${relative}`)
      continue
    }
    if (!inspected.exists) {
      missing.push(role.filename)
      if (apply) {
        await writeTextAtomic(absolute, expected)
        created.push(relative)
        generatedFiles.push(relative)
      }
      continue
    }

    if (inspected.leafSymlink || !inspected.stat?.isFile()) {
      preserved.push(relative)
      manualBlockers.push(`manual_non_regular_official_subagent_collision:${relative}`)
      continue
    }

    const current = await readText(absolute, '')
    const validation = inspectToml(current)
    if (!validation.ok) {
      invalid.push(relative)
      preserved.push(relative)
      manualBlockers.push(`manual_invalid_official_subagent_toml:${relative}`)
      if (apply) {
        const backup = await backupInvalidToml(absolute, current, 'official-subagent-invalid')
        backups.push(path.relative(root, backup))
      }
      continue
    }

    if (current === expected) {
      existing.push(relative)
      generatedFiles.push(relative)
      continue
    }

    if (managedOfficialSubagentRoleOwnsText(current, role)) {
      stale.push(relative)
      if (apply) {
        await writeTextAtomic(absolute, expected)
        updated.push(relative)
        generatedFiles.push(relative)
      }
      continue
    }

    preserved.push(relative)
    manualBlockers.push(manualCollisionBlocker(relative, current, role))
  }

  const remainingMissing = apply
    ? missing.filter((filename) => !created.includes(`.codex/agents/${filename}`))
    : missing
  return {
    schema: 'sks.official-subagent-agent-install.v1',
    ok: manualBlockers.length === 0 && (apply ? remainingMissing.length === 0 : true),
    apply,
    installed_agents: MANAGED_OFFICIAL_SUBAGENT_ROLES.map((role) => role.codex_name),
    missing,
    existing,
    stale,
    created,
    updated,
    preserved,
    invalid,
    backups,
    manual_blockers: manualBlockers,
    generated_files: [...new Set(generatedFiles)].sort()
  }
}

export function manifestProvesSksGeneratedPath(manifest: unknown, relativePath: string): boolean {
  const files = objectValue(objectValue(manifest)?.generated_files)?.files
  return Array.isArray(files) && files.map((entry) => String(entry || '').replaceAll('\\', '/')).includes(relativePath.replaceAll('\\', '/'))
}

export function officialSubagentConfigOwnershipProof(input: {
  text?: string
  manifest?: unknown
  migrationReceipt?: unknown
} = {}): OfficialSubagentConfigOwnershipProof {
  const text = String(input.text || '')
  const reasons: string[] = []
  if (manifestProvesSksGeneratedPath(input.manifest, '.codex/config.toml')) {
    reasons.push('generated_file_inventory')
  }
  if (hasExactManagedConfigMarker(text)) reasons.push('managed_marker_or_hash')
  if (migrationReceiptProvesManagedMaxThreads(input.migrationReceipt)) {
    reasons.push('migration_receipt:agents.max_concurrent_threads_per_session')
  }
  const legacyBlockCount = exactLegacyManagedAgentBlockCount(text)
  if (legacyBlockCount >= 3) reasons.push(`exact_legacy_managed_blocks:${legacyBlockCount}`)
  return { owned: reasons.length > 0, reasons: uniqueStrings(reasons) }
}

export function inspectOfficialSubagentToml(text: string = ''): { ok: boolean; error: string | null } {
  return inspectToml(text)
}

export async function backupInvalidToml(file: string, text: string, tag: string): Promise<string> {
  const safeTag = String(tag || 'invalid').replace(/[^a-z0-9-]+/gi, '-').replace(/^-+|-+$/g, '') || 'invalid'
  const backupPath = `${file}.sks-${safeTag}-${sha256(String(text || '')).slice(0, 16)}.bak`
  await writeTextAtomic(backupPath, String(text || ''), { mode: 0o600 })
  return backupPath
}

function manualCollisionBlocker(relative: string, text: string, role: ManagedOfficialSubagentRole): string {
  const markerPresent = String(text || '').includes(role.ownership_marker)
  return markerPresent
    ? `manual_modified_official_subagent_config:${relative}`
    : `manual_user_owned_official_subagent_collision:${relative}`
}

function configLayer(text: string, label: 'project' | 'global') {
  const validation = inspectToml(text)
  if (!validation.ok) {
    return {
      agents: {} as Record<string, unknown>,
      features: {} as Record<string, unknown>,
      blockers: [`${label}_official_subagent_config_toml_parse_failed`],
      legacyWarnings: [] as string[]
    }
  }
  const agents = objectValue(parsedToml(text)?.agents)
  const features = objectValue(parsedToml(text)?.features)
  const legacyWarnings: string[] = []
  if (hasOwn(agents, LEGACY_AGENTS_MAX_THREADS_KEY) && !hasOwn(agents, AGENTS_MAX_CONCURRENT_THREADS_KEY)) {
    legacyWarnings.push(`${label}_legacy_agents_max_threads_present`)
  }
  if (hasOwn(agents, LEGACY_AGENTS_JOB_MAX_RUNTIME_KEY)) {
    legacyWarnings.push(`${label}_legacy_agents_job_max_runtime_seconds_ignored`)
  }
  return {
    agents,
    features,
    blockers: [] as string[],
    legacyWarnings
  }
}

function resolveMultiAgentV2Layer(
  projectValue: unknown,
  globalValue: unknown,
  maxThreads: number
): {
  value: OfficialSubagentConfig['multiAgentV2']
  source: 'project' | 'global' | 'default'
} {
  const fallback = {
    enabled: true,
    maxConcurrentThreadsPerSession: Math.max(1, maxThreads + 1),
    exposeSpawnAgentModelOverrides: true
  }
  const project = normalizeMultiAgentV2(projectValue, fallback)
  if (project) return { value: project, source: 'project' }
  const global = normalizeMultiAgentV2(globalValue, fallback)
  if (global) return { value: global, source: 'global' }
  return { value: fallback, source: 'default' }
}

function normalizeMultiAgentV2(
  value: unknown,
  fallback: OfficialSubagentConfig['multiAgentV2']
): OfficialSubagentConfig['multiAgentV2'] | null {
  if (value === true) {
    return { ...fallback, enabled: true }
  }
  if (value === false) {
    return { ...fallback, enabled: false }
  }
  const row = objectValue(value)
  if (!Object.keys(row).length) return null
  return {
    enabled: booleanValue(row.enabled) ?? true,
    maxConcurrentThreadsPerSession:
      positiveInteger(row.max_concurrent_threads_per_session) || fallback.maxConcurrentThreadsPerSession,
    exposeSpawnAgentModelOverrides:
      booleanValue(row.expose_spawn_agent_model_overrides) ?? fallback.exposeSpawnAgentModelOverrides
  }
}

function resolveLayeredValue<T>(
  projectValue: unknown,
  globalValue: unknown,
  fallback: T,
  validate: (value: unknown) => T | null
): { value: T; source: 'project' | 'global' | 'default' } {
  const project = validate(projectValue)
  if (project !== null) return { value: project, source: 'project' }
  const global = validate(globalValue)
  if (global !== null) return { value: global, source: 'global' }
  return { value: fallback, source: 'default' }
}

function positiveInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : null
}

function booleanValue(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null
}

function nonEmptyString(value: unknown): string | null {
  const text = typeof value === 'string' ? value.trim() : ''
  return text ? text : null
}

function inspectToml(text: string): { ok: boolean; error: string | null } {
  try {
    parse(String(text || ''))
    return { ok: true, error: null }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

function parsedToml(text: string): Record<string, unknown> | null {
  try {
    return parse(String(text || '')) as Record<string, unknown>
  } catch {
    return null
  }
}

function objectValue(value: unknown): Record<string, any> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : {}
}

function featureTomlObject(value: unknown): Record<string, unknown> | null {
  if (typeof value === 'boolean') return { enabled: value }
  const row = objectValue(value)
  return Object.keys(row).length ? row : null
}

function hasExactManagedConfigMarker(text: string): boolean {
  return /^(?:#\s*SKS-MANAGED-CODEX-CONFIG\b|#\s*SKS managed Codex config\b|#\s*sks_managed_(?:body_)?sha256\s*=\s*["'][a-f0-9]{64}["'])/mi.test(text)
}

function migrationReceiptProvesManagedMaxThreads(value: unknown): boolean {
  const root = objectValue(value)
  if (root.schema !== 'sks.project-migration-receipt.v2') return false
  if (root.status !== 'current' || root.sks_version !== PACKAGE_VERSION) return false
  if (typeof root.installation_epoch_sha256 !== 'string' || !root.installation_epoch_sha256.trim()) return false
  if (!Array.isArray(root.blockers) || root.blockers.length > 0) return false
  if (root.required_blockers !== undefined && (!Array.isArray(root.required_blockers) || root.required_blockers.length > 0)) return false
  if (root.doctor !== undefined && root.doctor !== null && objectValue(root.doctor).ok !== true) return false
  if (root.retention_cleanup !== undefined && root.retention_cleanup !== null && objectValue(root.retention_cleanup).ok === false) return false

  const stages = [
    ...(Array.isArray(root.update_stages) ? root.update_stages : []),
    ...(Array.isArray(root.migration_stages) ? root.migration_stages : [])
  ]
  if (!stages.length || stages.some((stage) => migrationStageFailed(stage))) return false
  return stages.some((stage) => migrationStageSucceeded(stage) && migrationStageProvesManagedMaxThreads(stage))
}

function migrationStageSucceeded(value: unknown): boolean {
  const stage = objectValue(value)
  if (stage.ok !== true) return false
  const status = String(stage.status || '').trim()
  return Boolean(status) && !/(?:fail|block|error|skip|pending|partial|cancel|timeout|unavailable|unknown)/i.test(status)
}

function migrationStageFailed(value: unknown): boolean {
  const stage = objectValue(value)
  const status = String(stage.status || '').trim()
  return stage.ok === false || /(?:fail|block|error|cancel|timeout)/i.test(status)
}

function migrationStageProvesManagedMaxThreads(value: unknown): boolean {
  const queue: unknown[] = [value]
  const seen = new Set<unknown>()
  while (queue.length) {
    const current = queue.shift()
    if (!current || seen.has(current)) continue
    seen.add(current)
    if (Array.isArray(current)) {
      queue.push(...current)
      continue
    }
    if (typeof current === 'string') {
      if (
        /\bagents\.(?:max_threads|max_concurrent_threads_per_session)\b/i.test(current)
        && /\b(?:set|write|wrote|written|upsert|update|updated|migrat(?:e|ed|ion)|manage(?:d)?|apply|applied|repair|repaired)\b/i.test(current)
      ) return true
      continue
    }
    if (typeof current !== 'object') continue
    const row = current as Record<string, unknown>
    if (row.ok === false || /(?:fail|block|error|cancel|timeout)/i.test(String(row.status || ''))) continue
    for (const key of ['managed_keys', 'written_keys', 'migrated_keys', 'config_keys', 'keys_written']) {
      const entries = row[key]
      if (
        Array.isArray(entries)
        && entries.some((entry) => {
          const text = String(entry || '').trim()
          return text === 'agents.max_threads' || text === 'agents.max_concurrent_threads_per_session'
        })
      ) return true
    }
    const key = String(row.key || row.config_key || '').trim()
    if (key === 'agents.max_threads' || key === 'agents.max_concurrent_threads_per_session') return true
    for (const keyName of ['actions', 'detail', 'changes', 'writes', 'result', 'summary']) {
      if (row[keyName] !== undefined) queue.push(row[keyName])
    }
  }
  return false
}

function exactLegacyManagedAgentBlockCount(text: string): number {
  const agents = objectValue(parsedToml(text)?.agents)
  return LEGACY_SKS_AGENT_TABLE_SPECS.filter((spec) => exactLegacyManagedAgentRow(agents[spec.name], spec)).length
}

function removeExactLegacyManagedAgentBlocks(text: string): string {
  const agents = objectValue(parsedToml(text)?.agents)
  let next = String(text || '')
  for (const spec of LEGACY_SKS_AGENT_TABLE_SPECS) {
    if (!exactLegacyManagedAgentRow(agents[spec.name], spec)) continue
    next = removeTomlTable(next, `agents.${spec.name}`)
  }
  return next
}

function stripLegacyUnsupportedAgentKeys(text: string): string {
  let next = String(text || '')
  next = removeTomlTableKey(next, 'agents', LEGACY_AGENTS_JOB_MAX_RUNTIME_KEY)
  return next
}

function migrateLegacyMaxThreads(
  text: string,
  opts: {
    sksOwned: boolean
    targetMaxThreads: number
    inheritedAgents: Record<string, unknown>
  }
): string {
  let next = String(text || '')
  const currentCanonical = readTomlTableInteger(next, 'agents', AGENTS_MAX_CONCURRENT_THREADS_KEY)
  const currentLegacy = readTomlTableInteger(next, 'agents', LEGACY_AGENTS_MAX_THREADS_KEY)
  const inheritedCanonical = positiveInteger(opts.inheritedAgents[AGENTS_MAX_CONCURRENT_THREADS_KEY])
  const inheritedLegacy = positiveInteger(opts.inheritedAgents[LEGACY_AGENTS_MAX_THREADS_KEY])

  if (currentCanonical !== null) {
    if (opts.sksOwned && LEGACY_SKS_MAX_THREAD_VALUES.includes(currentCanonical)) {
      next = upsertTomlTableKey(next, 'agents', `${AGENTS_MAX_CONCURRENT_THREADS_KEY} = ${opts.targetMaxThreads}`)
    }
    if (hasTomlTableKey(next, 'agents', LEGACY_AGENTS_MAX_THREADS_KEY) && opts.sksOwned) {
      next = removeTomlTableKey(next, 'agents', LEGACY_AGENTS_MAX_THREADS_KEY)
    }
    return next
  }

  if (currentLegacy !== null) {
    const migrated = opts.sksOwned && LEGACY_SKS_MAX_THREAD_VALUES.includes(currentLegacy)
      ? opts.targetMaxThreads
      : currentLegacy
    next = upsertTomlTableKey(next, 'agents', `${AGENTS_MAX_CONCURRENT_THREADS_KEY} = ${migrated}`)
    if (opts.sksOwned) next = removeTomlTableKey(next, 'agents', LEGACY_AGENTS_MAX_THREADS_KEY)
    return next
  }

  if (inheritedCanonical !== null || inheritedLegacy !== null) return next
  return upsertTomlTableKey(next, 'agents', `${AGENTS_MAX_CONCURRENT_THREADS_KEY} = ${opts.targetMaxThreads}`)
}

function readAgentsMaxThreads(text: string): number | null {
  return readTomlTableInteger(text, 'agents', AGENTS_MAX_CONCURRENT_THREADS_KEY)
    ?? readTomlTableInteger(text, 'agents', LEGACY_AGENTS_MAX_THREADS_KEY)
}

function readAgentsMaxThreadsFromRecord(agents: Record<string, unknown>): unknown {
  if (positiveInteger(agents[AGENTS_MAX_CONCURRENT_THREADS_KEY]) !== null) {
    return agents[AGENTS_MAX_CONCURRENT_THREADS_KEY]
  }
  return agents[LEGACY_AGENTS_MAX_THREADS_KEY]
}

function exactLegacyManagedAgentRow(
  value: unknown,
  spec: typeof LEGACY_SKS_AGENT_TABLE_SPECS[number]
): boolean {
  const row = objectValue(value)
  const keys = Object.keys(row).sort()
  const configFile = String(row.config_file || '')
  const configFilename = configFile.replaceAll('\\', '/').split('/').pop() || ''
  return JSON.stringify(keys) === JSON.stringify(['config_file', 'description', 'nickname_candidates'])
    && row.description === spec.description
    && configFilename === spec.filename
    && Array.isArray(row.nickname_candidates)
    && JSON.stringify(row.nickname_candidates) === JSON.stringify(spec.nicknames)
}

function removeTomlTable(text: string, table: string): string {
  const lines = String(text || '').split('\n')
  const header = new RegExp(`^\\s*\\[${escapeRegExp(table)}\\]\\s*(?:#.*)?$`)
  const start = lines.findIndex((line) => header.test(line))
  if (start === -1) return text
  let end = lines.length
  for (let index = start + 1; index < lines.length; index += 1) {
    if (/^\s*\[.+\]\s*(?:#.*)?$/.test(lines[index] || '')) {
      end = index
      break
    }
  }
  lines.splice(start, end - start)
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd()
}

function removeTomlTableKey(text: string, table: string, key: string): string {
  const lines = String(text || '').trimEnd().split('\n')
  if (lines.length === 1 && lines[0] === '') return ''
  const start = lines.findIndex((line) => isTomlTableHeader(line, table))
  if (start === -1) return String(text || '')
  let end = lines.length
  for (let index = start + 1; index < lines.length; index += 1) {
    if (/^\s*\[.+\]\s*(?:#.*)?$/.test(lines[index] || '')) {
      end = index
      break
    }
  }
  const pattern = new RegExp(`^\\s*${escapeRegExp(key)}\\s*=`)
  return lines
    .filter((line, index) => index <= start || index >= end || !pattern.test(line || ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
}

function hasOwn(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key)
}

function upsertDefaultUnlessInherited(
  text: string,
  inheritedAgents: Record<string, unknown>,
  key: string,
  line: string
): string {
  if (hasTomlTableKey(text, 'agents', key) || hasOwn(inheritedAgents, key)) return text
  return upsertTomlTableKey(text, 'agents', line)
}

function readTomlTableInteger(text: string, table: string, key: string): number | null {
  const line = tomlTableKeyLine(text, table, key)
  const match = line?.match(/^\s*[^=]+\s*=\s*([0-9]+)\s*(?:#.*)?$/)
  if (!match?.[1]) return null
  const value = Number(match[1])
  return Number.isSafeInteger(value) ? value : null
}

function hasTomlTableKey(text: string, table: string, key: string): boolean {
  return tomlTableKeyLine(text, table, key) !== null
}

function hasTomlTable(text: string, table: string): boolean {
  return String(text || '').split('\n').some((line) => isTomlTableHeader(line, table))
}

function tomlTableKeyLine(text: string, table: string, key: string): string | null {
  const lines = String(text || '').split('\n')
  const start = lines.findIndex((line) => isTomlTableHeader(line, table))
  if (start === -1) return null
  const pattern = new RegExp(`^\\s*${escapeRegExp(key)}\\s*=`)
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index] || ''
    if (/^\s*\[.+\]\s*(?:#.*)?$/.test(line)) break
    if (pattern.test(line)) return line
  }
  return null
}

function upsertTomlTableKey(text: string, table: string, line: string): string {
  const key = String(line).split('=')[0]?.trim() || ''
  let lines = String(text || '').trimEnd().split('\n')
  if (lines.length === 1 && lines[0] === '') lines = []
  const header = `[${table}]`
  const start = lines.findIndex((entry) => isTomlTableHeader(entry, table))
  if (start === -1) {
    const firstChild = lines.findIndex((entry) => entry.trim().startsWith(`[${table}.`))
    const block = [header, line, '']
    if (firstChild >= 0) {
      lines.splice(firstChild, 0, ...block)
      return lines.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd()
    }
    return [...lines, ...(lines.length ? [''] : []), header, line].join('\n').replace(/\n{3,}/g, '\n\n')
  }
  let end = lines.length
  for (let index = start + 1; index < lines.length; index += 1) {
    if (/^\s*\[.+\]\s*(?:#.*)?$/.test(lines[index] || '')) {
      end = index
      break
    }
  }
  const pattern = new RegExp(`^\\s*${escapeRegExp(key)}\\s*=`)
  for (let index = start + 1; index < end; index += 1) {
    if (pattern.test(lines[index] || '')) {
      lines[index] = line
      return lines.join('\n').replace(/\n{3,}/g, '\n\n')
    }
  }
  lines.splice(end, 0, line)
  return lines.join('\n').replace(/\n{3,}/g, '\n\n')
}

function upsertTomlTable(text: string, table: string, block: string): string {
  let lines = String(text || '').trimEnd().split('\n')
  if (lines.length === 1 && lines[0] === '') lines = []
  const start = lines.findIndex((entry) => isTomlTableHeader(entry, table))
  const blockLines = String(block || '').trim().split('\n')
  if (start === -1) {
    return [...lines, ...(lines.length ? [''] : []), ...blockLines].join('\n').replace(/\n{3,}/g, '\n\n')
  }
  let end = lines.length
  for (let index = start + 1; index < lines.length; index += 1) {
    if (/^\s*\[.+\]\s*(?:#.*)?$/.test(lines[index] || '')) {
      end = index
      break
    }
  }
  lines.splice(start, end - start, ...blockLines)
  return lines.join('\n').replace(/\n{3,}/g, '\n\n')
}

function ensureTrailingNewline(text: string): string {
  const value = String(text || '').trimEnd()
  return value ? `${value}\n` : ''
}

function isTomlTableHeader(line: string, table: string): boolean {
  return new RegExp(`^\\s*\\[${escapeRegExp(table)}\\]\\s*(?:#.*)?$`).test(String(line || ''))
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)]
}

const LEGACY_SKS_AGENT_TABLE_SPECS = [
  { name: 'analysis_scout', filename: 'analysis-scout.toml', description: 'SKS scout with bounded write capability.', nicknames: ['Scout', 'Mapper'] },
  { name: 'native_agent', filename: 'native-agent-intake.toml', description: 'SKS native agent with bounded write capability.', nicknames: ['Analysis', 'Mapper'] },
  { name: 'team_consensus', filename: 'team-consensus.toml', description: 'SKS planning/debate agent with bounded write capability.', nicknames: ['Consensus', 'Atlas'] },
  { name: 'implementation_worker', filename: 'implementation-worker.toml', description: 'SKS bounded implementation worker.', nicknames: ['Builder', 'Mason'] },
  { name: 'db_safety_reviewer', filename: 'db-safety-reviewer.toml', description: 'DB safety reviewer with bounded write capability.', nicknames: ['Sentinel', 'Ledger'] },
  { name: 'qa_reviewer', filename: 'qa-reviewer.toml', description: 'QA reviewer with bounded write capability.', nicknames: ['Verifier', 'Reviewer'] }
] as const
