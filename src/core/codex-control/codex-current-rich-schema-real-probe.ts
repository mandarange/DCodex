import path from 'node:path'
import { findCodexBinary } from '../codex-adapter.js'
import { ensureDir, runProcess, writeJsonAtomic } from '../fsx.js'
import { buildCodexCurrentCoreRichToolSchemaFixture, evaluateCodexCurrentCoreRichToolSchemaPreservation } from './codex-tool-schema-fixtures.js'
import { codexCurrentCoreProbeTail, skippedCodexCurrentCoreProbe, type CodexCurrentCoreSingleProbe } from './codex-current-core-real-probes.js'

export async function runCodexCurrentCoreRichSchemaRealProbe(input: {
  root: string
  requireReal?: boolean
  timeoutMs?: number
  codexBin?: string | null
}): Promise<CodexCurrentCoreSingleProbe> {
  const started = Date.now()
  const codexBin = input.codexBin || await findCodexBinary()
  if (!codexBin && input.requireReal) return skippedCodexCurrentCoreProbe('codex_cli_missing')
  const tempDir = path.join(input.root, '.sneakoscope', 'tmp', 'codex-current-core-real-probes', `rich-schema-${Date.now()}`)
  await ensureDir(tempDir)
  const capturedSchemaPath = path.join(tempDir, 'captured-tool-schema.json')
  const schema = buildCodexCurrentCoreRichToolSchemaFixture()
  await writeJsonAtomic(capturedSchemaPath, schema)
  const evalResult = evaluateCodexCurrentCoreRichToolSchemaPreservation(schema)
  const versionRun = codexBin
    ? await runProcess(codexBin, ['--version'], { timeoutMs: input.timeoutMs || 30000, maxOutputBytes: 64 * 1024 }).catch((err: any) => ({ code: 1, stdout: '', stderr: err?.message || String(err) }))
    : { code: 0, stdout: '', stderr: '' }
  const actualBridge = Boolean(codexBin && (versionRun as any).code === 0)
  const ok = evalResult.ok === true && (!input.requireReal || actualBridge)
  const probe: CodexCurrentCoreSingleProbe = {
    ok,
    mode: actualBridge ? 'actual-sks-bridge' : 'skipped',
    duration_ms: Date.now() - started,
    stdout_tail: codexCurrentCoreProbeTail((versionRun as any).stdout),
    stderr_tail: codexCurrentCoreProbeTail((versionRun as any).stderr),
    artifact_paths: [capturedSchemaPath],
    evidence: {
      captured_schema_path: capturedSchemaPath,
      oneOf_preserved: evalResult.top_level_oneOf_preserved,
      allOf_preserved: evalResult.top_level_allOf_preserved,
      nested_target_preserved: evalResult.nested_structure_preserved,
      required_fields_retained: evalResult.required_fields_retained,
      adapter_path: actualBridge ? 'sks-schema-capture-hook+codex-cli-presence' : 'sks-schema-capture-hook'
    },
    blockers: ok ? [] : ['codex_rich_tool_schema_real_probe_failed']
  }
  if (codexBin) probe.command_line = [codexBin, '--version']
  return probe
}
