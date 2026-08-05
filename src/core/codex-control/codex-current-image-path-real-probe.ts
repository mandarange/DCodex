import fs from 'node:fs/promises'
import path from 'node:path'
import { buildCodexExecArgs, findCodexBinary, runCodexExec } from '../codex-adapter.js'
import { ensureDir, runProcess, writeBinaryAtomic } from '../fsx.js'
import { buildImageArtifactPathContract } from '../image/image-artifact-path-contract.js'
import { codexCurrentCoreProbeTail, skippedCodexCurrentCoreProbe, type CodexCurrentCoreSingleProbe } from './codex-current-core-real-probes.js'
import { prepareCodexAppServerRuntimeEnv } from './codex-app-server-runtime-env.js'

const ONE_BY_ONE_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4//8/AAX+Av4N70a4AAAAAElFTkSuQmCC',
  'base64'
)

export async function runCodexCurrentCoreImageReferencedPathRealProbe(input: {
  root: string
  requireReal?: boolean
  timeoutMs?: number
  codexBin?: string | null
  env?: NodeJS.ProcessEnv
  recoveryFetch?: typeof fetch
  runProcessImpl?: typeof runProcess
}): Promise<CodexCurrentCoreSingleProbe> {
  const started = Date.now()
  const tempDir = path.join(input.root, '.sneakoscope', 'tmp', 'codex-current-core-real-probes', `image-path-${Date.now()}`)
  await ensureDir(tempDir)
  const inputA = path.join(tempDir, 'input-a.png')
  const inputB = path.join(tempDir, 'input-b.png')
  await writeBinaryAtomic(inputA, ONE_BY_ONE_PNG)
  await writeBinaryAtomic(inputB, ONE_BY_ONE_PNG)
  const contract = await buildImageArtifactPathContract(input.root, {
    missionId: 'codex-current-image-path-real-probe',
    images: [
      { id: 'input-a', kind: 'input_attachment', filePath: inputA, route: 'codex-current-core-real-probe', stage: 'candidate' },
      { id: 'input-b', kind: 'input_attachment', filePath: inputB, route: 'codex-current-core-real-probe', stage: 'referenced' }
    ]
  })
  const codexBin = input.codexBin || await findCodexBinary()
  const exactReferencedPath = contract.images.find((image) => image.id === 'input-b')?.file_path === inputB
  if (!codexBin) {
    return {
      ...skippedCodexCurrentCoreProbe('codex_cli_missing', {
        codex_bin: codexBin,
        created_images: [inputA, inputB],
        exact_referenced_path_contract: exactReferencedPath,
        contract_blockers: contract.blockers
      }),
      duration_ms: Date.now() - started,
      artifact_paths: [tempDir]
    }
  }
  if (process.env.SKS_CODEX_CURRENT_IMAGE_REAL_PROBE_ALLOW_SKIP === '1' || process.env.SKS_CODEX_CURRENT_CORE_IMAGE_REAL_PROBE_ALLOW_SKIP === '1') {
    return {
      ...skippedCodexCurrentCoreProbe('codex_image_edit_actual_api_skipped', {
        codex_bin: codexBin,
        created_images: [inputA, inputB],
        exact_referenced_path_contract: exactReferencedPath,
        contract_blockers: contract.blockers
      }),
      duration_ms: Date.now() - started,
      artifact_paths: [tempDir]
    }
  }
  const outputFile = path.join(tempDir, 'last-message.txt')
  const prompt = [
    'This is a Current Codex 0.146.0 image path routing probe.',
    `Only the image file named ${path.basename(inputB)} is intentionally referenced.`,
    `Return compact JSON {"referenced_path":"${inputB.replace(/\\/g, '\\\\')}","saw_image":true}.`,
    'Do not edit files and do not reference any other image path.'
  ].join(' ')
  const extraArgs = ['-c', 'mcp_servers={}', '--image', inputB, '--skip-git-repo-check', '--ephemeral']
  const args = buildCodexExecArgs({ root: tempDir, prompt, outputFile, json: true, extraArgs })
  const runtimeEnv = await prepareCodexAppServerRuntimeEnv({ env: input.env || process.env })
  const result = await runCodexExec({
    root: tempDir,
    recoveryRoot: input.root,
    prompt,
    outputFile,
    json: true,
    extraArgs,
    timeoutMs: input.timeoutMs || 60000,
    maxBufferBytes: 512 * 1024,
    codexBin,
    env: runtimeEnv,
    ...(typeof input.recoveryFetch === 'function' ? { recoveryFetch: input.recoveryFetch } : {}),
    ...(typeof input.runProcessImpl === 'function' ? { runProcessImpl: input.runProcessImpl } : {})
  }).catch((err: any) => ({ code: 1, stdout: '', stderr: err?.message || String(err) }))
  const outputText = await fs.readFile(outputFile, 'utf8').catch(() => '')
  const combined = `${(result as any).stdout || ''}\n${(result as any).stderr || ''}\n${outputText}`
  const commandReferencesOnlyInputB = args.includes(inputB) && !args.includes(inputA)
  const outputReferencesInputB = combined.includes(inputB)
  const processExitedSuccessfully = (result as any).code === 0
  const ok = exactReferencedPath
    && commandReferencesOnlyInputB
    && outputReferencesInputB
    && processExitedSuccessfully
    && contract.blockers.length === 0
  return {
    ok,
    mode: 'actual-cli',
    command_line: [codexBin, ...args],
    duration_ms: Date.now() - started,
    stdout_tail: codexCurrentCoreProbeTail((result as any).stdout),
    stderr_tail: codexCurrentCoreProbeTail((result as any).stderr),
    artifact_paths: [tempDir, outputFile],
    evidence: {
      created_images: [inputA, inputB],
      referenced_path: inputB,
      exact_referenced_path_contract: exactReferencedPath,
      command_references_only_input_b: commandReferencesOnlyInputB,
      output_references_input_b: outputReferencesInputB,
      process_exited_successfully: processExitedSuccessfully,
      process_warning: processExitedSuccessfully ? null : 'Codex emitted the referenced path evidence before process timeout/nonzero exit.',
      output_file: outputFile,
      codex_lb_tool_output_recovery: (result as any).codexLbToolOutputRecovery || null,
      contract_blockers: contract.blockers
    },
    blockers: ok ? [] : [
      ...(processExitedSuccessfully ? [] : ['codex_image_referenced_path_process_failed_or_timed_out']),
      ...((result as any).codexLbToolOutputRecovery?.blockers || []),
      ...(!exactReferencedPath || !commandReferencesOnlyInputB || !outputReferencesInputB || contract.blockers.length > 0
        ? ['codex_image_referenced_path_actual_cli_probe_failed']
        : [])
    ]
  }
}
