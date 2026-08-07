import path from 'node:path'
import { findCodexBinary } from '../codex-adapter.js'
import { compareSemverLike, parseCodexVersionText } from '../codex-compat/codex-version-policy.js'
import { CURRENT_CODEX_RUNTIME_CONTRACT } from '../codex-compat/codex-runtime-contract.js'
import { nowIso, runProcess, writeJsonAtomic } from '../fsx.js'

// Current Codex surface retained by SKS:
// - Code mode can call standalone web search directly (incl. nested JS tool calls).
// - Tool/connector input schemas preserve `oneOf`/`allOf`; large schemas keep more
//   shallow structure when compacted (richer MCP tool + output schema support).
// - `codex doctor` reports editor/pager env details (redacted in JSON output).
// - `codex plugin marketplace list --json` includes each marketplace `source`,
//   and plugin lists can return from the cached remote catalog before a
//   background refresh.
// - `-P` sandbox permissions profile alias on the CLI.
// - Multi-agent v2: `close_agent` renamed to `interrupt_agent`, residency LRU,
//   concurrency counted by active execution, descendants not reopened on resume.
export interface CodexCurrentCoreCapability {
  schema: 'sks.codex-current-core-capability.v1'
  ok: boolean
  probe_mode: 'version-only' | 'feature-probe'
  probe_timeout_ms: number
  probe_error_summary: string[]
  codex_bin: string | null
  version_text: string | null
  parsed_version: string | null
  supports_code_mode_web_search: boolean
  supports_code_mode_web_search_real_verified?: boolean
  supports_rich_tool_schemas: boolean
  supports_doctor_env_details: boolean
  supports_marketplace_source_field: boolean
  supports_plugin_catalog_cache: boolean
  supports_sandbox_profile_alias: boolean
  supports_interrupt_agent_rename: boolean
  feature_probe_results: {
    marketplace_list_json?: 'passed' | 'failed' | 'skipped'
    sandbox_profile_alias?: 'passed' | 'failed' | 'skipped'
    interrupt_agent_event_mapping?: 'passed' | 'failed' | 'skipped'
    rich_tool_schema_preservation?: 'passed' | 'failed' | 'skipped'
    doctor_env_redaction?: 'passed' | 'failed' | 'skipped'
    code_mode_web_search?: 'passed' | 'failed' | 'skipped'
  }
  blockers: string[]
}

export async function detectCodexCurrentCoreCapability(input: { codexBin?: string | null } = {}): Promise<CodexCurrentCoreCapability> {
  const fake = process.env.SKS_CODEX_CURRENT_CORE_FAKE === '1'
  const codexBin = fake
    ? input.codexBin || process.env.CODEX_BIN || 'codex'
    : input.codexBin || process.env.CODEX_BIN || await findCodexBinary()
  const versionText = fake
    ? String(process.env.SKS_CODEX_VERSION_FAKE || `codex-cli ${CURRENT_CODEX_RUNTIME_CONTRACT.requiredCliVersion}`)
    : await readCodexVersionText(codexBin)
  const parsed = parseCodexVersionText(versionText)
  const currentRelease = Boolean(parsed && compareSemverLike(parsed, CURRENT_CODEX_RUNTIME_CONTRACT.requiredCliVersion) >= 0)
  const probeMode = process.env.SKS_CODEX_CURRENT_CORE_PROBE === '1' ? 'feature-probe' : 'version-only'
  const probeTimeoutMs = Math.max(1, Number(process.env.SKS_CODEX_CURRENT_CORE_PROBE_TIMEOUT_MS || 3000) || 3000)
  const featureProbeResults = probeMode === 'feature-probe'
    ? await probeCodexCurrentCoreFeatures(codexBin, { fake, timeoutMs: probeTimeoutMs })
    : {
        marketplace_list_json: 'skipped' as const,
        sandbox_profile_alias: 'skipped' as const,
        interrupt_agent_event_mapping: 'skipped' as const,
        rich_tool_schema_preservation: 'skipped' as const,
        doctor_env_redaction: 'skipped' as const,
        code_mode_web_search: 'skipped' as const
      }
  const marketplaceOk = currentRelease && (probeMode === 'version-only' || featureProbeResults.marketplace_list_json !== 'failed')
  const profileAliasOk = currentRelease && (probeMode === 'version-only' || featureProbeResults.sandbox_profile_alias !== 'failed')
  const interruptAgentOk = currentRelease && (probeMode === 'version-only' || featureProbeResults.interrupt_agent_event_mapping !== 'failed')
  const richSchemaOk = currentRelease && (probeMode === 'version-only' || featureProbeResults.rich_tool_schema_preservation !== 'failed')
  const doctorEnvOk = currentRelease && (probeMode === 'version-only' || featureProbeResults.doctor_env_redaction !== 'failed')
  const codeSearchOk = currentRelease && (probeMode === 'version-only' || featureProbeResults.code_mode_web_search !== 'failed')
  const probeErrorSummary = Object.entries(featureProbeResults)
    .filter(([, status]) => status === 'failed')
    .map(([name]) => `${name}:failed`)
  const blockers = [
    ...(!codexBin ? ['codex_cli_missing'] : []),
    ...(currentRelease ? [] : ['codex_current_release_required_for_search_schema_marketplace_features']),
    ...(probeMode === 'feature-probe' && featureProbeResults.marketplace_list_json === 'failed' ? ['codex_marketplace_list_json_probe_failed'] : []),
    ...(probeMode === 'feature-probe' && featureProbeResults.sandbox_profile_alias === 'failed' ? ['codex_sandbox_profile_alias_probe_failed'] : []),
    ...(probeMode === 'feature-probe' && featureProbeResults.interrupt_agent_event_mapping === 'failed' ? ['codex_interrupt_agent_probe_failed'] : []),
    ...(probeMode === 'feature-probe' && featureProbeResults.rich_tool_schema_preservation === 'failed' ? ['codex_rich_tool_schema_probe_failed'] : []),
    ...(probeMode === 'feature-probe' && featureProbeResults.doctor_env_redaction === 'failed' ? ['codex_doctor_env_redaction_probe_failed'] : []),
    ...(probeMode === 'feature-probe' && featureProbeResults.code_mode_web_search === 'failed' ? ['codex_code_mode_web_search_probe_failed'] : [])
  ]
  return {
    schema: 'sks.codex-current-core-capability.v1',
    ok: currentRelease && blockers.length === 0,
    probe_mode: probeMode,
    probe_timeout_ms: probeTimeoutMs,
    probe_error_summary: probeErrorSummary,
    codex_bin: codexBin || null,
    version_text: versionText || null,
    parsed_version: parsed,
    supports_code_mode_web_search: codeSearchOk,
    supports_code_mode_web_search_real_verified: false,
    supports_rich_tool_schemas: richSchemaOk,
    supports_doctor_env_details: doctorEnvOk,
    supports_marketplace_source_field: marketplaceOk,
    supports_plugin_catalog_cache: currentRelease,
    supports_sandbox_profile_alias: profileAliasOk,
    supports_interrupt_agent_rename: interruptAgentOk,
    feature_probe_results: featureProbeResults,
    blockers
  }
}

export async function writeCodexCurrentCoreCapabilityArtifacts(root: string, input: { missionId?: string | null; codexBin?: string | null } = {}) {
  const capability = await detectCodexCurrentCoreCapability({ codexBin: input.codexBin || null })
  const report = { ...capability, generated_at: nowIso() }
  const rootArtifact = path.join(root, '.sneakoscope', 'codex-current-core-capability.json')
  await writeJsonAtomic(rootArtifact, report)
  let missionArtifact: string | null = null
  if (input.missionId) {
    missionArtifact = path.join(root, '.sneakoscope', 'missions', input.missionId, 'codex-current-core-capability.json')
    await writeJsonAtomic(missionArtifact, report)
  }
  return { report, root_artifact: rootArtifact, mission_artifact: missionArtifact }
}

async function readCodexVersionText(codexBin: string | null): Promise<string | null> {
  if (!codexBin) return null
  const result = await runProcess(codexBin, ['--version'], { timeoutMs: 10_000, maxOutputBytes: 16 * 1024 }).catch((err: any) => ({
    code: 1,
    stdout: '',
    stderr: err?.message || String(err)
  }))
  const text = `${result.stdout || ''}${result.stderr || ''}`.trim()
  return result.code === 0 ? text : text || null
}

async function probeCodexCurrentCoreFeatures(codexBin: string | null, opts: { fake?: boolean; timeoutMs?: number } = {}): Promise<CodexCurrentCoreCapability['feature_probe_results']> {
  if (opts.fake) {
    return {
      marketplace_list_json: process.env.SKS_CODEX_CURRENT_CORE_FAKE_MARKETPLACE_FAIL === '1' ? 'failed' : 'passed',
      sandbox_profile_alias: process.env.SKS_CODEX_CURRENT_CORE_FAKE_PROFILE_ALIAS_FAIL === '1' ? 'failed' : 'passed',
      interrupt_agent_event_mapping: process.env.SKS_CODEX_CURRENT_CORE_FAKE_INTERRUPT_FAIL === '1' ? 'failed' : 'passed',
      rich_tool_schema_preservation: process.env.SKS_CODEX_CURRENT_CORE_FAKE_RICH_SCHEMA_FAIL === '1' ? 'failed' : 'passed',
      doctor_env_redaction: process.env.SKS_CODEX_CURRENT_CORE_FAKE_DOCTOR_ENV_FAIL === '1' ? 'failed' : 'passed',
      code_mode_web_search: process.env.SKS_CODEX_CURRENT_CORE_FAKE_WEB_SEARCH_FAIL === '1' ? 'failed' : 'passed'
    }
  }
  const timeoutMs = Math.max(1, Number(opts.timeoutMs || process.env.SKS_CODEX_CURRENT_CORE_PROBE_TIMEOUT_MS || 3000) || 3000)
  if (!codexBin) {
    return {
      marketplace_list_json: 'failed',
      sandbox_profile_alias: 'failed',
      interrupt_agent_event_mapping: 'skipped',
      rich_tool_schema_preservation: 'skipped',
      doctor_env_redaction: 'skipped',
      code_mode_web_search: 'skipped'
    }
  }
  const marketplace = await runProcess(codexBin, ['plugin', 'marketplace', 'list', '--json'], { timeoutMs, maxOutputBytes: 256 * 1024 }).catch(() => ({ code: 1, stdout: '' }))
  const marketplaceListJson = marketplace.code === 0 && marketplaceSourcesPresent((marketplace as any).stdout) ? 'passed' as const : 'failed' as const
  const help = await runProcess(codexBin, ['--help'], { timeoutMs, maxOutputBytes: 256 * 1024 }).catch(() => ({ code: 1, stdout: '' }))
  const sandboxHelp = await runProcess(codexBin, ['sandbox', '--help'], { timeoutMs, maxOutputBytes: 256 * 1024 }).catch(() => ({ code: 1, stdout: '' }))
  const aliasOk = help.code === 0 && codexHelpSupportsSandboxProfileAlias((help as any).stdout)
    || sandboxHelp.code === 0 && codexHelpSupportsSandboxProfileAlias((sandboxHelp as any).stdout)
  return {
    marketplace_list_json: marketplaceListJson,
    sandbox_profile_alias: aliasOk ? 'passed' : 'failed',
    interrupt_agent_event_mapping: 'skipped',
    rich_tool_schema_preservation: 'skipped',
    doctor_env_redaction: 'skipped',
    code_mode_web_search: 'skipped'
  }
}

export function marketplaceSourcesPresent(stdout: unknown): boolean {
  try {
    const parsed = JSON.parse(String(stdout || ''))
    const rows = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.marketplaces) ? parsed.marketplaces : Array.isArray(parsed?.items) ? parsed.items : []
    if (!rows.length) return true
    return rows.every((row: any) => typeof row?.source === 'string' && row.source.length > 0
      || typeof row?.marketplaceSource?.source === 'string' && row.marketplaceSource.source.length > 0
      || typeof row?.root === 'string' && row.root.length > 0)
  } catch {
    return false
  }
}

export function codexHelpSupportsSandboxProfileAlias(stdout: unknown): boolean {
  return /(^|\s)-P[,\s]+--(?:permissions-)?profile\b|--(?:permissions-)?profile[,\s]+-P\b|(^|\s)-P\b/m.test(String(stdout || ''))
}

export function redactCodexDoctorEnvDetails(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => redactCodexDoctorEnvDetails(item))
  if (!value || typeof value !== 'object') {
    return secretLikeValue(value) ? '<redacted>' : value
  }
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, entry]) => {
    if (secretLikeKey(key) || secretLikeValue(entry)) return [key, '<redacted>']
    return [key, redactCodexDoctorEnvDetails(entry)]
  }))
}

function secretLikeKey(key: string): boolean {
  return /(?:api[_-]?key|auth[_-]?token|secret|password|credential|bearer|session[_-]?token)/i.test(key)
}

function secretLikeValue(value: unknown): boolean {
  const text = typeof value === 'string' ? value : ''
  return /(?:sk-[A-Za-z0-9_-]{6,}|Bearer\s+[A-Za-z0-9._-]{8,}|[A-Za-z0-9._-]{12,}\.[A-Za-z0-9._-]{12,}\.[A-Za-z0-9._-]{12,})/.test(text)
}
