import path from 'node:path'
import { CURRENT_CODEX_RELEASE_MANIFEST } from '../codex-compat/codex-release-manifest.js'
import { readJson } from '../fsx.js'

export async function readCodexCurrentCoreDoctorRealProbeStatus(root: string) {
  const summary = await readJson(path.join(root, '.sneakoscope', 'codex-current-core-real-probe-summary.json'), null)
  const result = await readJson(path.join(root, '.sneakoscope', 'codex-current-core-real-probes.json'), null)
  return {
    schema: 'sks.doctor-codex-current-core-real-probes.v1',
    codex_cli_version: result?.version_text || null,
    capability_version_flag: result?.parsed_version === CURRENT_CODEX_RELEASE_MANIFEST.requiredCliVersion,
    real_probes_last_run_status: summary ? (summary.ok ? 'ok' : 'blocked') : 'not_run',
    skipped_probes: result?.skipped || [],
    strict_probe_command: 'node ./dist/scripts/codex-current-core-real-probes-check.js --require-real --allow-network',
    unsafe_auto_fix: false
  }
}
