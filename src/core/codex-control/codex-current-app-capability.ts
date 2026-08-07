import path from 'node:path'
import { findCodexBinary } from '../codex-adapter.js'
import { compareSemverLike, parseCodexVersionText } from '../codex-compat/codex-version-policy.js'
import { CURRENT_CODEX_RUNTIME_CONTRACT } from '../codex-compat/codex-runtime-contract.js'
import { nowIso, runProcess, writeJsonAtomic } from '../fsx.js'

export interface CodexCurrentAppCapability {
  schema: 'sks.codex-current-app-capability.v1'
  ok: boolean
  probe_mode: 'version-only' | 'feature-probe'
  codex_bin: string | null
  version_text: string | null
  parsed_version: string | null
  supports_app_handoff: boolean
  supports_plugin_json: boolean
  supports_image_path_exposure: boolean
  supports_model_defined_efforts: boolean
  supports_app_server_token_usage: boolean
  supports_v2_pat_auth: boolean
  supports_oauth_mcp_prerefresh: boolean
  feature_probe_results: {
    plugin_json?: 'passed' | 'failed' | 'skipped'
    app_handoff_platform?: 'passed' | 'failed' | 'skipped'
    image_path_exposure_contract?: 'sks-enforced'
  }
  blockers: string[]
}

export async function detectCodexCurrentAppCapability(input: { codexBin?: string | null } = {}): Promise<CodexCurrentAppCapability> {
  const fake = process.env.SKS_CODEX_CURRENT_APP_FAKE === '1'
  const codexBin = fake
    ? input.codexBin || process.env.CODEX_BIN || 'codex'
    : input.codexBin || process.env.CODEX_BIN || await findCodexBinary()
  const versionText = fake
    ? String(process.env.SKS_CODEX_VERSION_FAKE || `codex-cli ${CURRENT_CODEX_RUNTIME_CONTRACT.requiredCliVersion}`)
    : await readCodexVersionText(codexBin)
  const parsed = parseCodexVersion(versionText)
  const currentRelease = Boolean(parsed && semverGte(parsed, CURRENT_CODEX_RUNTIME_CONTRACT.requiredCliVersion))
  const probeMode = process.env.SKS_CODEX_CURRENT_APP_PROBE === '1' ? 'feature-probe' : 'version-only'
  const featureProbeResults = probeMode === 'feature-probe'
    ? await probeCodexCurrentAppFeatures(codexBin, { fake })
    : {
        plugin_json: 'skipped' as const,
        app_handoff_platform: 'skipped' as const,
        image_path_exposure_contract: 'sks-enforced' as const
      }
  const pluginJsonOk = currentRelease && (probeMode === 'version-only' || featureProbeResults.plugin_json !== 'failed')
  const appHandoffOk = currentRelease && (probeMode === 'version-only' || featureProbeResults.app_handoff_platform === 'passed')
  const imagePathExposureOk = currentRelease && process.env.SKS_CODEX_CURRENT_APP_FAKE_IMAGE_PATH_FAIL !== '1'
  const blockers = [
    ...(!codexBin ? ['codex_cli_missing'] : []),
    ...(currentRelease ? [] : ['codex_current_release_required_for_app_plugin_features']),
    ...(probeMode === 'feature-probe' && featureProbeResults.plugin_json === 'failed' ? ['codex_plugin_json_probe_failed'] : [])
  ]
  return {
    schema: 'sks.codex-current-app-capability.v1',
    ok: currentRelease && blockers.length === 0,
    probe_mode: probeMode,
    codex_bin: codexBin || null,
    version_text: versionText || null,
    parsed_version: parsed,
    supports_app_handoff: appHandoffOk,
    supports_plugin_json: pluginJsonOk,
    supports_image_path_exposure: imagePathExposureOk,
    supports_model_defined_efforts: currentRelease,
    supports_app_server_token_usage: currentRelease,
    supports_v2_pat_auth: currentRelease,
    supports_oauth_mcp_prerefresh: currentRelease,
    feature_probe_results: featureProbeResults,
    blockers
  }
}

export async function writeCodexCurrentAppCapabilityArtifacts(root: string, input: { missionId?: string | null; codexBin?: string | null } = {}) {
  const capability = await detectCodexCurrentAppCapability({ codexBin: input.codexBin || null })
  const report = { ...capability, generated_at: nowIso() }
  const rootArtifact = path.join(root, '.sneakoscope', 'codex-current-app-capability.json')
  await writeJsonAtomic(rootArtifact, report)
  let missionArtifact: string | null = null
  if (input.missionId) {
    missionArtifact = path.join(root, '.sneakoscope', 'missions', input.missionId, 'codex-current-app-capability.json')
    await writeJsonAtomic(missionArtifact, report)
  }
  return { report, root_artifact: rootArtifact, mission_artifact: missionArtifact }
}

export function parseCodexVersion(text: unknown): string | null {
  return parseCodexVersionText(text)
}

export function semverGte(actual: unknown, minimum: unknown): boolean {
  return compareSemverLike(actual, minimum) >= 0
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

async function probeCodexCurrentAppFeatures(codexBin: string | null, opts: { fake?: boolean } = {}): Promise<CodexCurrentAppCapability['feature_probe_results']> {
  if (opts.fake) {
    return {
      plugin_json: process.env.SKS_CODEX_CURRENT_APP_FAKE_PLUGIN_JSON_FAIL === '1' ? 'failed' : 'passed',
      app_handoff_platform: process.env.SKS_CODEX_CURRENT_APP_FAKE_APP_HANDOFF_FAIL === '1'
        ? 'failed'
        : process.platform === 'darwin' || process.platform === 'win32' ? 'passed' : 'failed',
      image_path_exposure_contract: 'sks-enforced'
    }
  }
  const timeoutMs = Math.max(1, Number(process.env.SKS_CODEX_CURRENT_APP_PROBE_TIMEOUT_MS || 3000) || 3000)
  const platformSupported = process.platform === 'darwin' || process.platform === 'win32'
  if (!codexBin) {
    return {
      plugin_json: 'failed',
      app_handoff_platform: platformSupported ? 'skipped' : 'failed',
      image_path_exposure_contract: 'sks-enforced'
    }
  }
  const list = await runProcess(codexBin, ['plugin', 'list', '--json'], { timeoutMs, maxOutputBytes: 64 * 1024 }).catch(() => ({ code: 1 }))
  const detailHelp = await runProcess(codexBin, ['plugin', 'detail', '--help'], { timeoutMs, maxOutputBytes: 64 * 1024 }).catch(() => ({ code: 1 }))
  return {
    plugin_json: list.code === 0 && detailHelp.code === 0 ? 'passed' : 'failed',
    app_handoff_platform: platformSupported ? 'passed' : 'failed',
    image_path_exposure_contract: 'sks-enforced'
  }
}
