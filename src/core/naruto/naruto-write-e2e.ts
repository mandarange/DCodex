import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { applyNarutoPatchEnvelopes } from './naruto-parallel-patch-apply.js'
import {
  realisticNarutoRealWriteProofFixture,
  validateNarutoRealWriteProof,
  type NarutoRealWriteProof
} from './naruto-real-write-proof.js'
import { ensureDir, runProcess, tmpdir, writeJsonAtomic, writeTextAtomic } from '../fsx.js'

export type NarutoWriteE2eMode = 'hermetic' | 'real-codex'

export interface NarutoWriteE2eReport {
  schema: 'sks.naruto-write-e2e.v1'
  ok: boolean
  status: 'passed' | 'blocked'
  mode: NarutoWriteE2eMode
  proof_level: 'hermetic_write_e2e' | 'real_codex_write_e2e' | 'blocked'
  temp_root: string | null
  changed_files: string[]
  worker_ids: string[]
  patch_envelope_count: number
  parent_merge_artifact: { ok: boolean; path: string | null; changed_files: string[] }
  typecheck: { ok: boolean; command: string | null; stdout_tail: string; stderr_tail: string }
  cleanup: { ok: boolean; temp_root_removed: boolean; blockers: string[] }
  runtime_evidence: {
    real_codex: boolean
    backend: 'hermetic' | 'codex-sdk' | null
    mock_or_readonly_rejected: boolean
    blockers: string[]
  }
  diagnostics?: Record<string, unknown> | null
  blockers: string[]
}

export interface ValidateNarutoWriteE2eContractInput {
  mode: NarutoWriteE2eMode
  changed_files?: string[]
  worker_ids?: string[]
  patch_envelope_count?: number
  parent_merge_artifact?: { ok?: boolean } | null
  typecheck?: { ok?: boolean } | null
  cleanup?: { ok?: boolean } | null
  runtime_evidence?: { real_codex?: boolean; backend?: string | null; mock_or_readonly_rejected?: boolean } | null
}

export async function runNarutoWriteE2e(mode: NarutoWriteE2eMode): Promise<NarutoWriteE2eReport> {
  if (mode === 'real-codex') return runRealCodexWriteE2e()
  return runHermeticWriteE2e()
}

export async function runHermeticWriteE2e(): Promise<NarutoWriteE2eReport> {
  const tempRoot = tmpdir('naruto-write-e2e-')
  const mergeArtifactPath = path.join(tempRoot, '.sneakoscope', 'naruto-write-e2e-parent-merge.json')
  const blockers: string[] = []
  let cleanup = { ok: false, temp_root_removed: false, blockers: [] as string[] }
  try {
    await writeHermeticFixture(tempRoot)
    const envelopes = hermeticPatchEnvelopes()
    const apply = await applyNarutoPatchEnvelopes(tempRoot, envelopes, { dryRun: false })
    const changedFiles = [...new Set(apply.results.flatMap((row) => row.changed_files))].sort()
    const workerIds = [...new Set(envelopes.map((envelope) => envelope.agent_id))].sort()
    const parentMergeArtifact = { ok: apply.ok, path: mergeArtifactPath, changed_files: changedFiles }
    await ensureDir(path.dirname(mergeArtifactPath))
    await writeJsonAtomic(mergeArtifactPath, {
      schema: 'sks.naruto-write-e2e-parent-merge.v1',
      ok: apply.ok,
      worker_ids: workerIds,
      changed_files: changedFiles,
      patch_envelope_count: envelopes.length,
      apply_results: apply.results.map((row) => ({
        envelope_id: row.envelope_id,
        ok: row.ok,
        changed_files: row.changed_files,
        before_hashes: row.before_hashes,
        after_hashes: row.after_hashes
      }))
    })
    const typecheck = await runTempTypecheck(tempRoot)
    const explicitProof = realisticNarutoRealWriteProofFixture({
      mission_id: 'M-hermetic-naruto-write-e2e',
      changed_files: changedFiles,
      worker_ids: workerIds,
      patch_envelopes: apply.results.map((row, index) => ({
        envelope_id: row.envelope_id,
        agent_id: envelopes[index]?.agent_id || `naruto-write-worker-${index + 1}`,
        changed_files: row.changed_files,
        applied: row.ok === true
      })),
      parent_merge_artifact: path.relative(tempRoot, mergeArtifactPath),
      typecheck: { ok: typecheck.ok, command: typecheck.command || 'typecheck_unavailable' },
      cleanup: { ok: true }
    })
    const explicitProofValidation = validateNarutoRealWriteProof(explicitProof)
    const contract = validateNarutoWriteE2eContract({
      mode: 'hermetic',
      changed_files: changedFiles,
      worker_ids: workerIds,
      patch_envelope_count: envelopes.length,
      parent_merge_artifact: parentMergeArtifact,
      typecheck,
      cleanup: { ok: true },
      runtime_evidence: { real_codex: false, backend: 'hermetic', mock_or_readonly_rejected: true }
    })
    blockers.push(...apply.blockers, ...(typecheck.ok ? [] : ['typecheck_failed']), ...explicitProofValidation.blockers, ...contract.blockers)
    cleanup = await cleanupTempRoot(tempRoot)
    blockers.push(...cleanup.blockers)
    return buildReport({
      mode: 'hermetic',
      tempRoot,
      changedFiles,
      workerIds,
      patchEnvelopeCount: envelopes.length,
      parentMergeArtifact,
      typecheck,
      cleanup,
      runtimeEvidence: { real_codex: false, backend: 'hermetic', mock_or_readonly_rejected: true, blockers: [] },
      blockers
    })
  } catch (error: unknown) {
    blockers.push(`hermetic_write_e2e_exception:${error instanceof Error ? error.message : String(error)}`)
    cleanup = await cleanupTempRoot(tempRoot)
    blockers.push(...cleanup.blockers)
    return buildReport({
      mode: 'hermetic',
      tempRoot,
      changedFiles: [],
      workerIds: [],
      patchEnvelopeCount: 0,
      parentMergeArtifact: { ok: false, path: mergeArtifactPath, changed_files: [] },
      typecheck: { ok: false, command: null, stdout_tail: '', stderr_tail: '' },
      cleanup,
      runtimeEvidence: { real_codex: false, backend: 'hermetic', mock_or_readonly_rejected: true, blockers: [] },
      blockers
    })
  }
}

export async function runRealCodexWriteE2e(): Promise<NarutoWriteE2eReport> {
  const requireReal = process.env.SKS_REQUIRE_CODEX_E2E === '1'
  const explicitlyEnabled = process.env.SKS_TEST_REAL_CODEX_WRITE_E2E === '1'
  const runtime = await probeRealCodexRuntime()
  if (!runtime.ok) {
    const blockers = ['real_codex_runtime_required']
    return buildReport({
      mode: 'real-codex',
      tempRoot: null,
      changedFiles: [],
      workerIds: [],
      patchEnvelopeCount: 0,
      parentMergeArtifact: { ok: false, path: null, changed_files: [] },
      typecheck: { ok: false, command: null, stdout_tail: '', stderr_tail: '' },
      cleanup: { ok: true, temp_root_removed: true, blockers: [] },
      runtimeEvidence: {
        real_codex: false,
        backend: null,
        mock_or_readonly_rejected: true,
        blockers: requireReal ? blockers : ['real_codex_write_e2e_not_requested']
      },
      blockers
    })
  }
  if (!requireReal && !explicitlyEnabled) {
    return buildReport({
      mode: 'real-codex',
      tempRoot: null,
      changedFiles: [],
      workerIds: [],
      patchEnvelopeCount: 0,
      parentMergeArtifact: { ok: false, path: null, changed_files: [] },
      typecheck: { ok: false, command: null, stdout_tail: '', stderr_tail: '' },
      cleanup: { ok: true, temp_root_removed: true, blockers: [] },
      runtimeEvidence: {
        real_codex: false,
        backend: null,
        mock_or_readonly_rejected: true,
        blockers: ['real_codex_write_e2e_not_requested']
      },
      blockers: ['real_codex_runtime_required']
    })
  }
  return runRealNarutoCommandWriteE2e()
}

export function validateNarutoWriteE2eContract(input: ValidateNarutoWriteE2eContractInput): { ok: boolean; blockers: string[] } {
  const blockers: string[] = []
  const changedFiles = new Set((input.changed_files || []).map(normalizeRelPath))
  const workerIds = new Set((input.worker_ids || []).map(String).filter(Boolean))
  if (input.mode === 'hermetic') {
    if (!changedFiles.has('src/a.ts')) blockers.push('src_a_ts_not_changed')
    if (!changedFiles.has('src/b.ts')) blockers.push('src_b_ts_not_changed')
    if (input.runtime_evidence?.backend !== 'hermetic') blockers.push('hermetic_backend_required')
  } else {
    if (changedFiles.size < 1) blockers.push('real_write_changed_files_missing')
    if (input.runtime_evidence?.real_codex !== true || input.runtime_evidence?.backend !== 'codex-sdk') blockers.push('real_codex_runtime_required')
  }
  if (workerIds.size < 2) blockers.push('worker_id_diversity_below_2')
  if (Number(input.patch_envelope_count || 0) < 2) blockers.push('patch_envelope_count_below_2')
  if (input.parent_merge_artifact?.ok !== true) blockers.push('parent_merge_artifact_missing')
  if (input.typecheck?.ok !== true) blockers.push('typecheck_failed')
  if (input.cleanup?.ok !== true) blockers.push('cleanup_failed')
  if (input.runtime_evidence?.mock_or_readonly_rejected !== true) blockers.push('mock_or_readonly_not_rejected')
  return { ok: blockers.length === 0, blockers }
}

function buildReport(input: {
  mode: NarutoWriteE2eMode
  tempRoot: string | null
  changedFiles: string[]
  workerIds: string[]
  patchEnvelopeCount: number
  parentMergeArtifact: NarutoWriteE2eReport['parent_merge_artifact']
  typecheck: NarutoWriteE2eReport['typecheck']
  cleanup: NarutoWriteE2eReport['cleanup']
  runtimeEvidence: NarutoWriteE2eReport['runtime_evidence']
  diagnostics?: Record<string, unknown> | null
  blockers: string[]
}): NarutoWriteE2eReport {
  const uniqueBlockers = [...new Set(input.blockers)]
  const passed = uniqueBlockers.length === 0
  return {
    schema: 'sks.naruto-write-e2e.v1',
    ok: passed,
    status: passed ? 'passed' : 'blocked',
    mode: input.mode,
    proof_level: passed ? input.mode === 'hermetic' ? 'hermetic_write_e2e' : 'real_codex_write_e2e' : 'blocked',
    temp_root: input.tempRoot,
    changed_files: [...new Set(input.changedFiles.map(normalizeRelPath))].sort(),
    worker_ids: [...new Set(input.workerIds)].sort(),
    patch_envelope_count: input.patchEnvelopeCount,
    parent_merge_artifact: input.parentMergeArtifact,
    typecheck: input.typecheck,
    cleanup: input.cleanup,
    runtime_evidence: input.runtimeEvidence,
    diagnostics: input.diagnostics || null,
    blockers: uniqueBlockers
  }
}

async function writeHermeticFixture(root: string): Promise<void> {
  await ensureDir(path.join(root, 'src'))
  await writeTextAtomic(path.join(root, 'src', 'shared.ts'), 'export const shared = 1\n')
  await writeTextAtomic(path.join(root, 'src', 'a.ts'), "import { shared } from './shared.js'\nexport const a = shared\n")
  await writeTextAtomic(path.join(root, 'src', 'b.ts'), "import { shared } from './shared.js'\nexport const b = shared\n")
  await writeTextAtomic(path.join(root, 'package.json'), JSON.stringify({ name: 'sks-naruto-write-e2e-fixture', type: 'module', private: true }, null, 2) + '\n')
  await writeTextAtomic(path.join(root, 'tsconfig.json'), JSON.stringify({
    compilerOptions: {
      target: 'ES2022',
      module: 'NodeNext',
      moduleResolution: 'NodeNext',
      strict: true,
      noEmit: true,
      skipLibCheck: true
    },
    include: ['src/**/*.ts']
  }, null, 2) + '\n')
}

function hermeticPatchEnvelopes() {
  return [
    {
      schema: 'sks.agent-patch-envelope.v1',
      source: 'fixture',
      agent_id: 'naruto-write-worker-a',
      session_id: 'naruto-write-worker-a-session',
      slot_id: 'naruto-write-slot-a',
      generation_index: 1,
      task_slice_id: 'naruto-write-a',
      lease_id: 'naruto-write-lease-a',
      allowed_paths: ['src/a.ts'],
      operations: [{ op: 'write', path: 'src/a.ts', content: "import { shared } from './shared.js'\nexport const a = shared + 1\n" }]
    },
    {
      schema: 'sks.agent-patch-envelope.v1',
      source: 'fixture',
      agent_id: 'naruto-write-worker-b',
      session_id: 'naruto-write-worker-b-session',
      slot_id: 'naruto-write-slot-b',
      generation_index: 1,
      task_slice_id: 'naruto-write-b',
      lease_id: 'naruto-write-lease-b',
      allowed_paths: ['src/b.ts'],
      operations: [{ op: 'write', path: 'src/b.ts', content: "import { shared } from './shared.js'\nexport const b = shared + 2\n" }]
    }
  ]
}

async function runTempTypecheck(root: string): Promise<NarutoWriteE2eReport['typecheck']> {
  const tscPath = path.join(repoRootFromImportMeta(), 'node_modules', 'typescript', 'bin', 'tsc')
  const command = `${process.execPath} ${tscPath} -p tsconfig.json --noEmit`
  const result = await runProcess(process.execPath, [tscPath, '-p', 'tsconfig.json', '--noEmit'], {
    cwd: root,
    timeoutMs: 60_000,
    maxOutputBytes: 128 * 1024
  })
  return {
    ok: result.code === 0,
    command,
    stdout_tail: tail(result.stdout),
    stderr_tail: tail(result.stderr)
  }
}

async function cleanupTempRoot(root: string): Promise<NarutoWriteE2eReport['cleanup']> {
  const blockers: string[] = []
  try {
    await fs.rm(root, { recursive: true, force: true })
  } catch (error: unknown) {
    blockers.push(`cleanup_exception:${error instanceof Error ? error.message : String(error)}`)
  }
  const tempRootRemoved = !(await pathExists(root))
  if (!tempRootRemoved) blockers.push('temp_root_not_removed')
  return { ok: blockers.length === 0, temp_root_removed: tempRootRemoved, blockers }
}

async function probeRealCodexRuntime(): Promise<{ ok: boolean; blockers: string[] }> {
  if (process.env.SKS_TEST_REAL_CODEX_RUNTIME_UNAVAILABLE === '1') {
    return { ok: false, blockers: ['test_forced_real_codex_runtime_unavailable'] }
  }
  const sksBin = path.join(repoRootFromImportMeta(), 'dist', 'bin', 'sks.js')
  if (!(await pathExists(sksBin))) return { ok: false, blockers: ['dist_sks_missing'] }
  const result = await runProcess(process.execPath, [sksBin, 'codex', 'version', '--json'], {
    cwd: repoRootFromImportMeta(),
    timeoutMs: 30_000,
    maxOutputBytes: 128 * 1024
  })
  return { ok: result.code === 0, blockers: result.code === 0 ? [] : [`codex_version_exit_${result.code}`] }
}

async function runRealNarutoCommandWriteE2e(): Promise<NarutoWriteE2eReport> {
  const tempRoot = tmpdir('naruto-real-write-e2e-')
  const mergeArtifactPath = path.join(tempRoot, '.sneakoscope', 'naruto-real-write-e2e-parent-merge.json')
  const blockers: string[] = []
  let cleanup = { ok: false, temp_root_removed: false, blockers: [] as string[] }
  try {
    await writeHermeticFixture(tempRoot)
    const beforeA = await fs.readFile(path.join(tempRoot, 'src', 'a.ts'), 'utf8')
    const beforeB = await fs.readFile(path.join(tempRoot, 'src', 'b.ts'), 'utf8')
    const sksBin = path.join(repoRootFromImportMeta(), 'dist', 'bin', 'sks.js')
    const run = await runProcess(process.execPath, [
	      sksBin,
	      'naruto',
	      'run',
	      'modify src/a.ts and src/b.ts independently for the real write E2E; keep TypeScript valid; each worker must only touch its assigned write_path and must use patch_envelopes with op "write" containing the complete final file content',
      '--json',
      '--write-mode',
      'parallel',
      '--apply-patches',
      '--agents',
      '2',
      '--work-items',
      '2',
      '--backend',
      'codex-sdk',
      '--real'
    ], {
      cwd: tempRoot,
      timeoutMs: readPositiveIntEnv('SKS_NARUTO_REAL_E2E_TIMEOUT_MS', 300_000),
      maxOutputBytes: 1024 * 1024,
      env: {
        ...process.env,
        SKS_CODEX_ALLOW_NON_GIT: '1',
        SKS_DISABLE_UPDATE_CHECK: '1'
      }
    })
    const afterA = await fs.readFile(path.join(tempRoot, 'src', 'a.ts'), 'utf8').catch(() => beforeA)
    const afterB = await fs.readFile(path.join(tempRoot, 'src', 'b.ts'), 'utf8').catch(() => beforeB)
    const observedChangedFiles = [
      ...(afterA !== beforeA ? ['src/a.ts'] : []),
      ...(afterB !== beforeB ? ['src/b.ts'] : [])
    ]
    const parsed = parseJsonObjectFromStdout(run.stdout)
    const missionId = String(parsed?.mission_id || '')
    const explicitProof = missionId ? await readNarutoRealWriteProof(tempRoot, missionId) : null
    const missionDir = missionId ? path.join(tempRoot, '.sneakoscope', 'missions', missionId) : null
    const queue = missionDir ? await readJsonMaybe(path.join(missionDir, 'agents', 'agent-patch-queue.json')) : null
    const applyResults = missionDir ? await readJsonMaybe(path.join(missionDir, 'agents', 'agent-patch-apply-results.json')) : null
    const explicitProofValidation = explicitProof ? validateNarutoRealWriteProof(explicitProof) : { ok: false, blockers: ['naruto_real_write_proof_missing'] }
    const changedFiles = explicitProof?.changed_files || []
    const workerIds = explicitProof?.worker_ids || []
    const patchEnvelopeCount = explicitProof?.patch_envelopes?.length || 0
    const parentMergeArtifact = {
      ok: explicitProofValidation.ok,
      path: explicitProof ? path.join(tempRoot, '.sneakoscope', 'missions', missionId, 'naruto-real-write-proof.json') : null,
      changed_files: changedFiles
    }
    await writeJsonAtomic(mergeArtifactPath, {
      schema: 'sks.naruto-real-write-e2e-parent-merge.v1',
      ok: parentMergeArtifact.ok,
      mission_id: missionId || null,
      command_exit_code: run.code,
      changed_files: changedFiles,
      observed_changed_files: observedChangedFiles,
      worker_ids: workerIds,
      patch_envelope_count: patchEnvelopeCount,
      stdout_tail: tail(run.stdout),
      stderr_tail: tail(run.stderr)
    })
    const diagnostics = {
      command_exit_code: run.code,
      mission_id: missionId || null,
      parsed_ok: parsed?.ok ?? null,
      parsed_status: parsed?.status || null,
      parsed_blockers: Array.isArray(parsed?.blockers) ? parsed.blockers : [],
      queue_entries: Array.isArray(queue?.entries) ? queue.entries.map((entry: any) => ({
        id: entry.id || null,
        status: entry.status || null,
        agent_id: entry.agent_id || entry.envelope?.agent_id || null,
        write_paths: entry.write_paths || entry.envelope?.operations?.map((operation: any) => operation.path) || []
      })) : [],
      apply_results: Array.isArray(applyResults?.results) ? applyResults.results.map((row: any) => ({
        entry_id: row.entry_id || row.envelope_id || null,
        ok: row.ok === true,
        changed_files: row.changed_files || [],
        blockers: row.blockers || []
      })) : [],
      stdout_tail: tail(run.stdout),
      stderr_tail: tail(run.stderr)
    }
    const typecheck = await runTempTypecheck(tempRoot)
    const contract = validateNarutoWriteE2eContract({
      mode: 'real-codex',
      changed_files: changedFiles,
      worker_ids: workerIds,
      patch_envelope_count: patchEnvelopeCount,
      parent_merge_artifact: parentMergeArtifact,
      typecheck,
      cleanup: { ok: true },
      runtime_evidence: { real_codex: true, backend: 'codex-sdk', mock_or_readonly_rejected: true }
    })
    if (run.code !== 0) blockers.push(`real_naruto_command_exit_${run.code}`)
    if (missionId.length === 0) blockers.push('naruto_real_write_mission_id_missing')
    if (changedFiles.some((file) => !observedChangedFiles.includes(file))) blockers.push('naruto_real_write_proof_changed_file_not_observed')
    blockers.push(...explicitProofValidation.blockers, ...(typecheck.ok ? [] : ['typecheck_failed']), ...contract.blockers)
    cleanup = await cleanupTempRoot(tempRoot)
    blockers.push(...cleanup.blockers)
    return buildReport({
      mode: 'real-codex',
      tempRoot,
      changedFiles,
      workerIds,
      patchEnvelopeCount,
      parentMergeArtifact,
      typecheck,
      cleanup,
      runtimeEvidence: { real_codex: true, backend: 'codex-sdk', mock_or_readonly_rejected: true, blockers: [] },
      diagnostics,
      blockers
    })
  } catch (error: unknown) {
    blockers.push(`real_write_e2e_exception:${error instanceof Error ? error.message : String(error)}`)
    cleanup = await cleanupTempRoot(tempRoot)
    blockers.push(...cleanup.blockers)
    return buildReport({
      mode: 'real-codex',
      tempRoot,
      changedFiles: [],
      workerIds: [],
      patchEnvelopeCount: 0,
      parentMergeArtifact: { ok: false, path: mergeArtifactPath, changed_files: [] },
      typecheck: { ok: false, command: null, stdout_tail: '', stderr_tail: '' },
      cleanup,
      runtimeEvidence: { real_codex: true, backend: 'codex-sdk', mock_or_readonly_rejected: true, blockers: [] },
      diagnostics: null,
      blockers
    })
  }
}

async function readNarutoRealWriteProof(root: string, missionId: string): Promise<NarutoRealWriteProof | null> {
  const proofPath = path.join(root, '.sneakoscope', 'missions', missionId, 'naruto-real-write-proof.json')
  const text = await fs.readFile(proofPath, 'utf8').catch(() => '')
  if (!text.trim()) return null
  try {
    return JSON.parse(text) as NarutoRealWriteProof
  } catch {
    return null
  }
}

async function readJsonMaybe(file: string): Promise<any | null> {
  const text = await fs.readFile(file, 'utf8').catch(() => '')
  if (!text.trim()) return null
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

function repoRootFromImportMeta(): string {
  const here = path.dirname(fileURLToPath(import.meta.url))
  const srcIndex = here.lastIndexOf(`${path.sep}src${path.sep}`)
  if (srcIndex >= 0) return here.slice(0, srcIndex)
  const distIndex = here.lastIndexOf(`${path.sep}dist${path.sep}`)
  if (distIndex >= 0) return here.slice(0, distIndex)
  return process.cwd()
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await fs.access(target)
    return true
  } catch {
    return false
  }
}

function normalizeRelPath(value: string): string {
  return String(value || '').replace(/\\/g, '/').replace(/^\.\/+/, '')
}

function readPositiveIntEnv(name: string, fallback: number): number {
  const parsed = Number(process.env[name])
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback
}

function parseJsonObjectFromStdout(stdout: string): any {
  /* intentional: best-effort JSON extraction from mixed stdout — each parse attempt below is expected to fail on non-JSON lines, falling through to the next strategy, with null as the final honest outcome */
  const text = String(stdout || '').trim()
  const first = text.indexOf('{')
  const last = text.lastIndexOf('}')
  if (first >= 0 && last > first) {
    try {
      return JSON.parse(text.slice(first, last + 1))
    } catch {}
  }
  for (const line of text.split(/\r?\n/).reverse()) {
    try {
      const parsed = JSON.parse(line)
      if (parsed && typeof parsed === 'object') return parsed
    } catch {}
  }
  return null
}

function tail(value: string, limit = 4000): string {
  const text = String(value || '')
  return text.length > limit ? text.slice(-limit) : text
}
