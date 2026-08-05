import path from 'node:path'
import { CURRENT_CODEX_RELEASE_MANIFEST } from '../codex-compat/codex-release-manifest.js'
import { nowIso, writeJsonAtomic } from '../fsx.js'

export type CodexCurrentCoreProbeName =
  | 'code_mode_web_search'
  | 'rich_tool_schema'
  | 'doctor_env_redaction'
  | 'marketplace_source_json'
  | 'plugin_catalog_cache'
  | 'sandbox_profile_alias'
  | 'collab_agent_tool_schema'
  | 'image_referenced_path'
  | 'sandbox_proxy_environment'

export const CODEX_CURRENT_CORE_REAL_PROBE_NAMES: CodexCurrentCoreProbeName[] = [
  'code_mode_web_search',
  'rich_tool_schema',
  'doctor_env_redaction',
  'marketplace_source_json',
  'plugin_catalog_cache',
  'sandbox_profile_alias',
  'collab_agent_tool_schema',
  'image_referenced_path',
  'sandbox_proxy_environment'
]

export interface CodexCurrentCoreRealProbeResult {
  schema: 'sks.codex-current-core-real-probe-result.v1'
  target_version: string
  compatibility_origin: 'codex-current-core-real-probe-result-v1'
  compatibility_authority: 'deprecated_non_authoritative_lineage_only'
  generated_at: string
  codex_bin: string | null
  version_text: string | null
  parsed_version: string | null
  require_real: boolean
  release_authorizing: boolean
  overall_ok: boolean
  probe_timeout_ms: number
  requested_probes: CodexCurrentCoreProbeName[]
  probes: Record<CodexCurrentCoreProbeName, CodexCurrentCoreSingleProbe>
  skipped: string[]
  warnings: string[]
  external_integration_status: {
    mcp_auth: 'authentication_required' | 'not_observed'
    release_authorization_scope: 'codex_core_compatibility_only'
  }
  temp_cleanup: {
    root: string
    ok: boolean
    remaining_entries: string[]
  }
  blockers: string[]
}

export interface CodexCurrentCoreSingleProbe {
  ok: boolean
  mode: 'actual-cli' | 'actual-sdk' | 'actual-app-server' | 'actual-sks-bridge' | 'captured-real-fixture' | 'skipped'
  command_line?: string[]
  duration_ms: number
  stdout_tail?: string
  stderr_tail?: string
  artifact_paths: string[]
  evidence: Record<string, unknown>
  warnings?: string[]
  blockers: string[]
}

export function codexCurrentCoreProbeArtifactPath(root: string): string {
  return path.join(root, '.sneakoscope', 'codex-current-core-real-probes.json')
}

export function codexCurrentCoreMissionProbeArtifactPath(root: string, missionId: string): string {
  return path.join(root, '.sneakoscope', 'missions', missionId, 'codex-current-core-real-probes.json')
}

export function codexCurrentCoreDistProbeArtifactPath(root: string): string {
  return path.join(root, 'dist', 'codex-current-core-real-probes.json')
}

export async function writeCodexCurrentCoreRealProbeResult(
  root: string,
  result: CodexCurrentCoreRealProbeResult,
  opts: { missionId?: string | null; writeDist?: boolean } = {}
) {
  const rootArtifact = codexCurrentCoreProbeArtifactPath(root)
  await writeJsonAtomic(rootArtifact, result)
  let missionArtifact: string | null = null
  if (opts.missionId) {
    missionArtifact = codexCurrentCoreMissionProbeArtifactPath(root, opts.missionId)
    await writeJsonAtomic(missionArtifact, result)
  }
  let distArtifact: string | null = null
  if (opts.writeDist !== false) {
    distArtifact = codexCurrentCoreDistProbeArtifactPath(root)
    await writeJsonAtomic(distArtifact, result)
  }
  return { root_artifact: rootArtifact, mission_artifact: missionArtifact, dist_artifact: distArtifact }
}

export function skippedCodexCurrentCoreProbe(blocker: string, evidence: Record<string, unknown> = {}): CodexCurrentCoreSingleProbe {
  return {
    ok: false,
    mode: 'skipped',
    duration_ms: 0,
    artifact_paths: [],
    evidence,
    blockers: [blocker]
  }
}

export function codexCurrentCoreProbeTail(text: unknown, limit = 4000): string {
  const raw = String(text || '')
  return raw.length <= limit ? raw : raw.slice(raw.length - limit)
}

export function buildCodexCurrentCoreRealProbeResult(input: {
  codexBin: string | null
  versionText: string | null
  parsedVersion: string | null
  requireReal: boolean
  timeoutMs: number
  probes: Record<CodexCurrentCoreProbeName, CodexCurrentCoreSingleProbe>
  requiredProbeNames?: CodexCurrentCoreProbeName[]
  releaseAuthorizing?: boolean
  tempCleanup?: { root: string; ok: boolean; remaining_entries: string[] }
  extraBlockers?: string[]
}): CodexCurrentCoreRealProbeResult {
  const requiredProbeNames = input.requiredProbeNames ? [...new Set(input.requiredProbeNames)] : [...CODEX_CURRENT_CORE_REAL_PROBE_NAMES]
  const skipped = requiredProbeNames.filter((name) => input.probes[name]?.mode === 'skipped')
  const failed = requiredProbeNames.filter((name) => input.probes[name] && input.probes[name].ok !== true && input.probes[name].mode !== 'skipped')
  const blockers = [
    ...(input.extraBlockers || []),
    ...requiredProbeNames.flatMap((name) => input.probes[name]?.blockers || []),
    ...(input.requireReal && skipped.length ? skipped.map((name) => `require_real_skipped:${name}`) : [])
  ]
  const warnings = requiredProbeNames.flatMap((name) => input.probes[name]?.warnings || [])
  const overallOk = input.requireReal ? blockers.length === 0 && failed.length === 0 && skipped.length === 0 : failed.length === 0
  return {
    schema: 'sks.codex-current-core-real-probe-result.v1',
    target_version: CURRENT_CODEX_RELEASE_MANIFEST.requiredCliVersion,
    compatibility_origin: 'codex-current-core-real-probe-result-v1',
    compatibility_authority: 'deprecated_non_authoritative_lineage_only',
    generated_at: nowIso(),
    codex_bin: input.codexBin,
    version_text: input.versionText,
    parsed_version: input.parsedVersion,
    require_real: input.requireReal,
    release_authorizing: Boolean(input.releaseAuthorizing && overallOk),
    overall_ok: overallOk,
    probe_timeout_ms: input.timeoutMs,
    requested_probes: requiredProbeNames,
    probes: input.probes,
    skipped,
    warnings: [...new Set(warnings)],
    external_integration_status: {
      mcp_auth: warnings.includes('codex_real_probe_external_mcp_auth_required') ? 'authentication_required' : 'not_observed',
      release_authorization_scope: 'codex_core_compatibility_only'
    },
    temp_cleanup: input.tempCleanup || { root: '', ok: false, remaining_entries: [] },
    blockers: [...new Set(blockers)]
  }
}
