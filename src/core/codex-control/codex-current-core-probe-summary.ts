import path from 'node:path'
import { codexCurrentCoreProbeArtifactPath, type CodexCurrentCoreRealProbeResult } from './codex-current-core-real-probes.js'
import { readJson, writeJsonAtomic } from '../fsx.js'

export interface CodexCurrentCoreRealProbeSummary {
  schema: 'sks.codex-current-core-real-probe-summary.v1'
  target_version: string
  compatibility_authority: 'deprecated_non_authoritative_lineage_only'
  ok: boolean
  require_real: boolean
  codex_bin: string | null
  parsed_version: string | null
  actual_cli_probe_count: number
  actual_sdk_probe_count: number
  actual_app_server_probe_count: number
  actual_sks_bridge_probe_count: number
  skipped_count: number
  failed_count: number
  probes: Record<string, {
    ok: boolean
    mode: string
    blockers: string[]
  }>
}

export async function buildCodexCurrentCoreRealProbeSummary(root: string): Promise<CodexCurrentCoreRealProbeSummary> {
  const result = await readJson<CodexCurrentCoreRealProbeResult>(codexCurrentCoreProbeArtifactPath(root))
  const requested = new Set<string>((result.requested_probes?.length ? result.requested_probes : Object.keys(result.probes || {})).map(String))
  const requestedEntries = Object.entries(result.probes || {}).filter(([name]) => requested.has(name))
  const probes = Object.fromEntries(requestedEntries.map(([name, probe]) => [name, {
    ok: probe.ok === true,
    mode: probe.mode,
    blockers: probe.blockers || []
  }]))
  const values = requestedEntries.map(([, probe]) => probe)
  const skippedCount = values.filter((probe) => probe.mode === 'skipped').length
  const failedCount = values.filter((probe) => probe.ok !== true && probe.mode !== 'skipped').length
  return {
    schema: 'sks.codex-current-core-real-probe-summary.v1',
    target_version: result.target_version,
    compatibility_authority: 'deprecated_non_authoritative_lineage_only',
    ok: result.overall_ok === true,
    require_real: result.require_real,
    codex_bin: result.codex_bin,
    parsed_version: result.parsed_version,
    actual_cli_probe_count: values.filter((probe) => probe.mode === 'actual-cli').length,
    actual_sdk_probe_count: values.filter((probe) => probe.mode === 'actual-sdk').length,
    actual_app_server_probe_count: values.filter((probe) => probe.mode === 'actual-app-server').length,
    actual_sks_bridge_probe_count: values.filter((probe) => probe.mode === 'actual-sks-bridge').length,
    skipped_count: skippedCount,
    failed_count: failedCount,
    probes
  }
}

export async function writeCodexCurrentCoreRealProbeSummary(root: string) {
  const summary = await buildCodexCurrentCoreRealProbeSummary(root)
  const rootArtifact = path.join(root, '.sneakoscope', 'codex-current-core-real-probe-summary.json')
  const distArtifact = path.join(root, 'dist', 'codex-current-core-real-probe-summary.json')
  await writeJsonAtomic(rootArtifact, summary)
  await writeJsonAtomic(distArtifact, summary)
  return { summary, root_artifact: rootArtifact, dist_artifact: distArtifact }
}
