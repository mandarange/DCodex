import path from 'node:path'
import { findCodexBinary } from '../codex-adapter.js'
import { ensureDir, runProcess } from '../fsx.js'
import { redactCodexDoctorEnvDetails } from './codex-current-core-capability.js'
import { codexCurrentCoreProbeTail, skippedCodexCurrentCoreProbe, type CodexCurrentCoreSingleProbe } from './codex-current-core-real-probes.js'

export async function runCodexCurrentCoreDoctorEnvRealProbe(input: {
  root: string
  requireReal?: boolean
  timeoutMs?: number
  codexBin?: string | null
}): Promise<CodexCurrentCoreSingleProbe> {
  const started = Date.now()
  const codexBin = input.codexBin || await findCodexBinary()
  if (!codexBin) return skippedCodexCurrentCoreProbe('codex_cli_missing')
  const tempDir = path.join(input.root, '.sneakoscope', 'tmp', 'codex-current-core-real-probes', `doctor-${Date.now()}`)
  await ensureDir(tempDir)
  const isolatedHome = path.join(tempDir, 'home')
  const isolatedCodexHome = path.join(isolatedHome, '.codex')
  await ensureDir(isolatedCodexHome)
  const env = {
    ...process.env,
    HOME: isolatedHome,
    CODEX_HOME: isolatedCodexHome,
    EDITOR: 'vim',
    PAGER: 'less',
    TERM: 'xterm-256color',
    OPENAI_API_KEY: 'sk-test-secret-value',
    CODEX_AUTH_TOKEN: 'test-secret-token'
  }
  const result = await runProcess(codexBin, ['doctor', '--json'], {
    cwd: tempDir,
    env,
    timeoutMs: input.timeoutMs || 60000,
    maxOutputBytes: 512 * 1024,
    stdoutFile: path.join(tempDir, 'codex-doctor.stdout.json'),
    stderrFile: path.join(tempDir, 'codex-doctor.stderr.log')
  }).catch((err: any) => ({ code: 1, stdout: '', stderr: err?.message || String(err) }))
  const combined = `${(result as any).stdout || ''}\n${(result as any).stderr || ''}`
  const redacted = redactCodexDoctorEnvDetails(parseJson((result as any).stdout) || combined)
  const redactedText = JSON.stringify(redacted)
  const editorPagerPresent = /(EDITOR|editor|vim)/.test(combined) && /(PAGER|pager|less)/.test(combined)
  const rawSecretAbsent = !combined.includes('sk-test-secret-value') && !combined.includes('test-secret-token')
  const redactedMarkerOrOmitted = rawSecretAbsent || /redacted|omitted|hidden/i.test(combined)
  const processExitedSuccessfully = (result as any).code === 0
  const ok = editorPagerPresent && rawSecretAbsent && redactedMarkerOrOmitted
  return {
    ok,
    mode: 'actual-cli',
    command_line: [codexBin, 'doctor', '--json'],
    duration_ms: Date.now() - started,
    stdout_tail: codexCurrentCoreProbeTail((result as any).stdout),
    stderr_tail: codexCurrentCoreProbeTail((result as any).stderr),
    artifact_paths: [tempDir],
    evidence: {
      editor_pager_present: editorPagerPresent,
      raw_secret_absent: rawSecretAbsent,
      redacted_marker_or_omitted: redactedMarkerOrOmitted,
      redacted_sample_contains_secret: redactedText.includes('sk-test-secret-value') || redactedText.includes('test-secret-token'),
      process_exited_successfully: processExitedSuccessfully,
      process_warning: processExitedSuccessfully ? null : 'codex doctor returned nonzero after emitting the scoped env/redaction evidence.',
      isolated_codex_home: true
    },
    blockers: ok ? [] : ['codex_doctor_env_redaction_real_probe_failed']
  }
}

function parseJson(text: string) {
  try {
    return JSON.parse(String(text || ''))
  } catch {
    return null
  }
}
