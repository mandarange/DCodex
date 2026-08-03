import fsSync from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'
import { nowIso, readJson, writeJsonAtomic } from '../fsx.js'

export const FAST_MODE_POLICY_SCHEMA = 'sks.fast-mode-policy.v1'
export const FAST_MODE_PROPAGATION_PROOF_SCHEMA = 'sks.fast-mode-propagation-proof.v1'
export const FAST_MODE_PREFERENCE_SCHEMA = 'sks.fast-mode-preference.v1'
export type AgentServiceTier = 'fast' | 'standard'
export type CodexDesktopServiceTier = 'priority' | 'default'
export type FastModePreferenceMode = AgentServiceTier

export interface FastModePolicy {
  schema: typeof FAST_MODE_POLICY_SCHEMA
  generated_at: string
  fast_mode: boolean
  service_tier: AgentServiceTier
  codex_desktop_service_tier: CodexDesktopServiceTier
  default_fast_mode: boolean
  disabled_by: 'none' | 'no-fast' | 'service-tier-standard' | 'preference-standard'
  explicit_fast: boolean
  explicit_no_fast: boolean
  explicit_service_tier: AgentServiceTier | null
  preference_mode: FastModePreferenceMode | null
  preference_path: string | null
  preference_source: 'project-state' | null
}

export interface FastModePreference {
  schema: typeof FAST_MODE_PREFERENCE_SCHEMA
  updated_at: string
  mode: FastModePreferenceMode
  fast_mode: boolean
  service_tier: AgentServiceTier
  codex_desktop_service_tier: CodexDesktopServiceTier
  source: string
}

export function resolveFastModePolicy(input: any = {}): FastModePolicy {
  const explicitTier = normalizeServiceTier(input.serviceTier ?? input.service_tier, null)
  const explicitNoFast = input.fastMode === false || input.fast_mode === false || input.noFast === true || input.no_fast === true
  const explicitFast = input.fastMode === true || input.fast_mode === true || input.fast === true
  const preference = explicitNoFast || explicitFast || explicitTier
    ? null
    : readFastModePreferenceSync(input.preferenceRoot || input.preference_root || input.root)
  const serviceTier: AgentServiceTier = explicitNoFast
    ? 'standard'
    : explicitTier === 'standard'
      ? 'standard'
      : preference?.mode === 'standard'
        ? 'standard'
        : 'fast'
  return {
    schema: FAST_MODE_POLICY_SCHEMA,
    generated_at: nowIso(),
    fast_mode: serviceTier === 'fast',
    service_tier: serviceTier,
    codex_desktop_service_tier: codexDesktopServiceTier(serviceTier),
    default_fast_mode: true,
    disabled_by: explicitNoFast ? 'no-fast' : explicitTier === 'standard' ? 'service-tier-standard' : preference?.mode === 'standard' ? 'preference-standard' : 'none',
    explicit_fast: explicitFast,
    explicit_no_fast: explicitNoFast,
    explicit_service_tier: explicitTier,
    preference_mode: preference?.mode || null,
    preference_path: preference?.path || null,
    preference_source: preference ? 'project-state' : null
  }
}

export function fastModePreferencePath(root: string = process.cwd()) {
  return path.join(path.resolve(root), '.sneakoscope', 'state', 'fast-mode.json')
}

export function readFastModePreferenceSync(root?: string | null): (FastModePreference & { path: string }) | null {
  if (!root) return null
  const file = fastModePreferencePath(root)
  try {
    const parsed = JSON.parse(fsSync.readFileSync(file, 'utf8'))
    const mode = normalizeServiceTier(parsed?.mode ?? parsed?.service_tier, null)
    if (!mode) return null
    return normalizeFastModePreference({ ...parsed, mode }, file)
  } catch {
    return null
  }
}

export async function readFastModePreference(root: string = process.cwd()): Promise<(FastModePreference & { path: string }) | null> {
  const file = fastModePreferencePath(root)
  const parsed = await readJson<any>(file, null)
  const mode = normalizeServiceTier(parsed?.mode ?? parsed?.service_tier, null)
  if (!mode) return null
  return normalizeFastModePreference({ ...parsed, mode }, file)
}

export async function writeFastModePreference(root: string = process.cwd(), mode: FastModePreferenceMode, source = 'sks fast-mode'): Promise<FastModePreference & { path: string }> {
  const normalized = normalizeServiceTier(mode, 'fast') || 'fast'
  const file = fastModePreferencePath(root)
  const preference: FastModePreference = {
    schema: FAST_MODE_PREFERENCE_SCHEMA,
    updated_at: nowIso(),
    mode: normalized,
    fast_mode: normalized === 'fast',
    service_tier: normalized,
    codex_desktop_service_tier: codexDesktopServiceTier(normalized),
    source
  }
  await writeJsonAtomic(file, preference)
  return { ...preference, path: file }
}

export async function clearFastModePreference(root: string = process.cwd()): Promise<{ path: string; removed: boolean }> {
  const file = fastModePreferencePath(root)
  const existed = fsSync.existsSync(file)
  await fs.rm(file, { force: true }).catch(() => {})
  return { path: file, removed: existed }
}

export function fastModeEnv(policy: FastModePolicy): NodeJS.ProcessEnv {
  return {
    SKS_FAST_MODE: policy.fast_mode ? '1' : '0',
    SKS_SERVICE_TIER: policy.service_tier,
    SKS_CODEX_DESKTOP_SERVICE_TIER: policy.codex_desktop_service_tier,
    SKS_REASONING_PROFILE_SUFFIX: policy.fast_mode ? 'fast' : 'standard'
  }
}

export function applyFastModeToRoster<T extends Record<string, any>>(roster: T, policy: FastModePolicy): T {
  const rows = Array.isArray(roster?.roster) ? roster.roster : []
  return {
    ...roster,
    service_tier: policy.service_tier,
    fast_mode: policy.fast_mode,
    roster: rows.map((entry: any) => ({
      ...entry,
      service_tier: policy.service_tier,
      fast_mode: policy.fast_mode,
      reasoning_profile: normalizeReasoningProfile(entry.reasoning_profile, policy)
    })),
    effort_policy: roster?.effort_policy
      ? {
          ...roster.effort_policy,
          service_tier: policy.service_tier,
          fast_mode: policy.fast_mode,
          decisions: Array.isArray(roster.effort_policy.decisions)
            ? roster.effort_policy.decisions.map((entry: any) => ({
                ...entry,
                service_tier: policy.service_tier,
                fast_mode: policy.fast_mode,
                reasoning_profile: normalizeReasoningProfile(entry.reasoning_profile, policy)
              }))
            : roster.effort_policy.decisions
        }
      : roster?.effort_policy
  }
}

export async function writeFastModePropagationProof(root: string, input: { policy: FastModePolicy; backend?: string; results?: any[] } = { policy: resolveFastModePolicy() }) {
  const workerProcessReports = await collectNamedJson(root, 'worker-process-report.json')
  const agentProcessReports = await collectNamedJson(root, 'agent-process-report.json')
  const madReports = await collectNamedJson(root, 'mad-sks-worker-report.json')
  const defaultFastExpected = input.policy.fast_mode === true
  const childReports = [...workerProcessReports, ...agentProcessReports, ...madReports]
  const missingFast = defaultFastExpected
    ? childReports.filter((row) => row.json?.fast_mode !== true && row.json?.fast_mode !== 'true')
    : []
  const missingTier = childReports.filter((row) => {
    const value = String(row.json?.service_tier || '')
    return value && value !== input.policy.service_tier
  })
  const missingCliOverride: any[] = []
  const workerMissing = defaultFastExpected && workerProcessReports.length === 0
    ? ['fast_mode_worker_reports_missing']
    : []
  const report = {
    schema: FAST_MODE_PROPAGATION_PROOF_SCHEMA,
    generated_at: nowIso(),
    ok: missingFast.length === 0 && missingTier.length === 0 && workerMissing.length === 0 && missingCliOverride.length === 0,
    policy: input.policy,
    backend: input.backend || null,
    default_fast_mode: input.policy.default_fast_mode,
    service_tier: input.policy.service_tier,
    fast_mode: input.policy.fast_mode,
    worker_fast_report_count: 0,
    worker_process_report_count: workerProcessReports.length,
    codex_sdk_process_report_count: agentProcessReports.filter((row) => row.json?.backend === 'codex-sdk').length,
    process_report_count: agentProcessReports.filter((row) => row.json?.backend === 'process').length,
    mad_report_count: madReports.length,
    child_report_count: childReports.length,
    artifacts: childReports.map((row) => row.relative_path),
    blockers: [
      ...workerMissing,
      ...missingFast.map((row) => `fast_mode_missing:${row.relative_path}`),
      ...missingTier.map((row) => `service_tier_mismatch:${row.relative_path}`),
      ...missingCliOverride.map((row) => `service_tier_cli_override_missing:${row.relative_path}`)
    ]
  }
  await writeJsonAtomic(path.join(root, 'fast-mode-propagation-proof.json'), report)
  return report
}

export function normalizeServiceTier(value: unknown, fallback: AgentServiceTier | null = 'fast'): AgentServiceTier | null {
  const text = String(value || '').toLowerCase()
  if (text === 'fast' || text === 'standard') return text
  if (text === 'priority') return 'fast'
  if (text === 'default') return 'standard'
  return fallback
}

export function codexDesktopServiceTier(tier: AgentServiceTier): CodexDesktopServiceTier {
  return tier === 'fast' ? 'priority' : 'default'
}

function normalizeFastModePreference(parsed: any, file: string): FastModePreference & { path: string } {
  const mode = normalizeServiceTier(parsed?.mode ?? parsed?.service_tier, 'fast') || 'fast'
  return {
    schema: FAST_MODE_PREFERENCE_SCHEMA,
    updated_at: typeof parsed?.updated_at === 'string' ? parsed.updated_at : nowIso(),
    mode,
    fast_mode: mode === 'fast',
    service_tier: mode,
    codex_desktop_service_tier: codexDesktopServiceTier(mode),
    source: typeof parsed?.source === 'string' ? parsed.source : 'unknown',
    path: file
  }
}

function normalizeReasoningProfile(value: unknown, policy: FastModePolicy) {
  const profile = String(value || 'sks-agent-medium-fast')
  return policy.fast_mode ? profile.replace(/-standard$/, '-fast') : profile.replace(/-fast$/, '-standard')
}

async function collectNamedJson(root: string, filename: string) {
  const out: Array<{ path: string; relative_path: string; json: any }> = []
  await walk(root, async (file) => {
    if (path.basename(file) !== filename) return
    const json = await readJson<any>(file, null).catch(() => null)
    if (json) out.push({ path: file, relative_path: path.relative(root, file), json })
  })
  return out
}

async function walk(dir: string, visit: (file: string) => Promise<void>) {
  let entries: Array<import('node:fs').Dirent>
  try {
    entries = await fs.readdir(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) await walk(full, visit)
    else await visit(full)
  }
}
