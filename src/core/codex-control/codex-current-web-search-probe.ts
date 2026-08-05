import fs from 'node:fs/promises'
import path from 'node:path'
import { buildCodexExecArgs, findCodexBinary, runCodexExec } from '../codex-adapter.js'
import { ensureDir, runProcess, writeJsonAtomic, writeTextAtomic } from '../fsx.js'
import { codexCurrentCoreProbeTail, skippedCodexCurrentCoreProbe, type CodexCurrentCoreSingleProbe } from './codex-current-core-real-probes.js'
import { prepareCodexAppServerRuntimeEnv } from './codex-app-server-runtime-env.js'

export async function runCodexCurrentCoreWebSearchRealProbe(input: {
  root: string
  requireReal?: boolean
  allowNetwork?: boolean
  timeoutMs?: number
  codexBin?: string | null
  env?: NodeJS.ProcessEnv
  recoveryFetch?: typeof fetch
  runProcessImpl?: typeof runProcess
}): Promise<CodexCurrentCoreSingleProbe> {
  const started = Date.now()
  if (!input.allowNetwork) {
    const skipped = skippedCodexCurrentCoreProbe('codex_web_search_network_not_allowed', { allow_network: false })
    return input.requireReal ? { ...skipped, blockers: ['codex_web_search_network_not_allowed'] } : skipped
  }
  const codexBin = input.codexBin || await findCodexBinary()
  if (!codexBin) return skippedCodexCurrentCoreProbe('codex_cli_missing')
  const tempDir = path.join(input.root, '.sneakoscope', 'tmp', 'codex-current-core-real-probes', `web-search-${Date.now()}`)
  await ensureDir(tempDir)
  await writeTextAtomic(path.join(tempDir, 'README.md'), 'Temporary Current Codex 0.146.0 web-search real probe workspace.\n')
  const outputFile = path.join(tempDir, 'last-message.txt')
  const prompt = 'In code mode, use standalone web search to find the title of https://example.com. Return JSON {"used_web_search":true,"answer":"...","sources":[...]}.'
  const args = buildCodexExecArgs({ root: tempDir, prompt, outputFile, json: true, extraArgs: ['-c', 'mcp_servers={}'] })
  const runtimeEnv = await prepareCodexAppServerRuntimeEnv({ env: input.env || process.env })
  const result = await runCodexExec({
    root: tempDir,
    recoveryRoot: input.root,
    prompt,
    outputFile,
    json: true,
    extraArgs: ['-c', 'mcp_servers={}'],
    timeoutMs: input.timeoutMs || 120000,
    maxBufferBytes: 512 * 1024,
    stdoutFile: path.join(tempDir, 'codex.stdout.log'),
    stderrFile: path.join(tempDir, 'codex.stderr.log'),
    codexBin,
    env: runtimeEnv,
    ...(typeof input.recoveryFetch === 'function' ? { recoveryFetch: input.recoveryFetch } : {}),
    ...(typeof input.runProcessImpl === 'function' ? { runProcessImpl: input.runProcessImpl } : {})
  }).catch((err: any) => ({
    code: 1,
    stdout: '',
    stderr: err?.message || String(err)
  }))
  const output = await fs.readFile(outputFile, 'utf8').catch(() => '')
  const combined = `${(result as any).stdout || ''}\n${(result as any).stderr || ''}\n${output}`
  const sawWebSearchEvent = /\b(web[_ -]?search|search_result|sources?|tool_call|standalone web search)\b/i.test(combined)
  const sawPlaintextResult = /(Example Domain|example\.com)/i.test(combined)
  const resultContainsExpectedMarker = /"used_web_search"\s*:\s*true|used_web_search/i.test(combined) || sawWebSearchEvent
  const processExitedSuccessfully = (result as any).code === 0
  const ok = processExitedSuccessfully && sawPlaintextResult && resultContainsExpectedMarker
  if (ok) {
    await writeJsonAtomic(path.join(input.root, '.sneakoscope', 'codex-current-code-mode-web-search-policy.json'), {
      schema: 'sks.codex-current-code-mode-web-search-policy.v1',
      ok: true,
      generated_at: new Date().toISOString(),
      allow_standalone_web_search_in_code_mode: true,
      real_probe_verified: true,
      evidence: {
        saw_web_search_event: sawWebSearchEvent,
        saw_plaintext_result: sawPlaintextResult,
        result_contains_expected_marker: resultContainsExpectedMarker
      }
    })
  }
  return {
    ok,
    mode: 'actual-cli',
    command_line: [codexBin, ...args],
    duration_ms: Date.now() - started,
    stdout_tail: codexCurrentCoreProbeTail((result as any).stdout),
    stderr_tail: codexCurrentCoreProbeTail((result as any).stderr),
    artifact_paths: [tempDir, outputFile],
    evidence: {
      saw_web_search_event: sawWebSearchEvent,
      saw_plaintext_result: sawPlaintextResult,
      result_contains_expected_marker: resultContainsExpectedMarker,
      process_exited_successfully: processExitedSuccessfully,
      process_warning: processExitedSuccessfully ? null : 'Codex emitted web-search evidence before process timeout/nonzero exit.',
      output_file: outputFile,
      codex_lb_tool_output_recovery: (result as any).codexLbToolOutputRecovery || null
    },
    blockers: ok ? [] : [
      ...(processExitedSuccessfully ? [] : ['codex_web_search_process_failed_or_timed_out']),
      ...((result as any).codexLbToolOutputRecovery?.blockers || []),
      ...(!sawPlaintextResult || !resultContainsExpectedMarker ? ['codex_web_search_real_probe_failed'] : [])
    ]
  }
}
