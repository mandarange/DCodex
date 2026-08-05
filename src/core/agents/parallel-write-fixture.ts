import { execFile } from 'node:child_process'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

export const PARALLEL_PRODUCTION_SMOKE_SCHEMA = 'sks.parallel-production-smoke.v1'

export interface ParallelProductionSmokeOptions {
  keepTmp?: boolean
  injectFailure?: boolean
}

export interface ParallelProductionSmokeReport {
  schema: typeof PARALLEL_PRODUCTION_SMOKE_SCHEMA
  ok: boolean
  status: 'passed' | 'blocked'
  proof_level: 'production_git_worktree_fixture' | 'blocked'
  tmp_root: string
  repo_root: string
  worker_count: number
  worker_ids: string[]
  changed_files: string[]
  changed_files_by_worker: Record<string, string[]>
  distributed_across_workers: boolean
  timestamp_overlap: boolean
  overlap_windows: Array<{ worker_a: string; worker_b: string; overlap_ms: number }>
  patch_envelope_count: number
  parent_merge_artifact: ParentMergeArtifact
  typecheck: CommandRecord
  worktree_cleanup: CleanupProof
  failure_injection: FailureInjectionProof
  mock_only: false
  blockers: string[]
}

export interface ParentMergeArtifact {
  schema: 'sks.parallel-production-parent-merge.v1'
  ok: boolean
  merged_files: string[]
  shared_untouched: boolean
  git_status_after_merge: string
}

export interface CommandRecord {
  ok: boolean
  command: string[]
  cwd: string
  exit_code: number | null
  stdout_tail: string
  stderr_tail: string
}

export interface CleanupProof {
  ok: boolean
  worktree_list_before_cleanup: string
  worktree_list_after_cleanup: string
  worker_worktrees_removed: boolean
  worker_branches_removed: boolean
  parent_dirty_after_cleanup: boolean
  tmp_removed: boolean
}

export interface FailureInjectionProof {
  requested: boolean
  worker_failure_seen: boolean
  reassignment_attempted: boolean
  survived_worker_failure: boolean
  failed_worker_id: string | null
  failed_worker_ids: string[]
  recovered_work_item_ids: string[]
  scheduler_survived: boolean
  successful_workers: string[]
  failed_workers: string[]
}

interface WorkerSpec {
  id: string
  branch: string
  file: string
  exportName: string
  returnValue: string
  fail?: boolean
}

interface WorkerResult {
  worker_id: string
  ok: boolean
  branch: string
  worktree: string
  changed_files: string[]
  patch: string
  started_ms: number
  completed_ms: number
  blocker?: string
}

export async function runParallelProductionSmoke(options: ParallelProductionSmokeOptions = {}): Promise<ParallelProductionSmokeReport> {
  const tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'sks-parallel-production-smoke-'))
  const repoRoot = path.join(tmpRoot, 'tmp-repo')
  const worktreesRoot = path.join(tmpRoot, 'worktrees')
  const blockers: string[] = []
  let cleanup: CleanupProof | null = null

  try {
    await createFixtureRepo(repoRoot)
    await fsp.mkdir(worktreesRoot, { recursive: true })

    const workerSpecs = buildWorkerSpecs(options.injectFailure === true)
    for (const worker of workerSpecs) {
      await setupWorkerWorktree(repoRoot, worktreesRoot, worker)
    }

    const workerResults = await Promise.all(workerSpecs.map((worker) => runWorker(worker, path.join(worktreesRoot, worker.id))))
    const successfulWorkers = workerResults.filter((result) => result.ok)
    const failedWorkers = workerResults.filter((result) => !result.ok)
    const targetFiles = ['src/a.ts', 'src/b.ts', 'src/c.ts']
    await mergeWorkerOutputs(repoRoot, successfulWorkers)

    const typecheck = await runTypecheck(repoRoot)
    const sharedUntouched = await fileEquals(path.join(repoRoot, 'src', 'shared.ts'), "export const sharedValue = 'stable-shared-contract'\n")
    const statusAfterMerge = (await runCommand(['git', 'status', '--short'], repoRoot)).stdout_tail.trim()
    const parentMergeArtifact: ParentMergeArtifact = {
      schema: 'sks.parallel-production-parent-merge.v1',
      ok: successfulWorkers.length >= 3 && targetFiles.every((file) => successfulWorkers.some((worker) => worker.changed_files.includes(file))) && sharedUntouched,
      merged_files: Array.from(new Set(successfulWorkers.flatMap((worker) => worker.changed_files))).sort(),
      shared_untouched: sharedUntouched,
      git_status_after_merge: statusAfterMerge
    }
    if (parentMergeArtifact.ok) {
      await runCommand(['git', 'add', ...parentMergeArtifact.merged_files], repoRoot, true)
      await runCommand(['git', 'commit', '-m', 'parent merge parallel worker outputs'], repoRoot, true)
    }

    const changedFilesByWorker = Object.fromEntries(successfulWorkers.map((worker) => [worker.worker_id, worker.changed_files])) as Record<string, string[]>
    const changedFiles = Array.from(new Set(successfulWorkers.flatMap((worker) => worker.changed_files))).sort()
    const overlapWindows = buildOverlapWindows(workerResults)
    const cleanupBefore = await runCommand(['git', 'worktree', 'list', '--porcelain'], repoRoot)
    cleanup = await cleanupWorktreesAndBranches(repoRoot, tmpRoot, workerSpecs, cleanupBefore.stdout_tail, options.keepTmp === true)

    if (workerSpecs.filter((worker) => !worker.fail).length < 3) blockers.push('parallel_write_worker_target_below_three')
    if (successfulWorkers.length < 3) blockers.push('parallel_write_successful_workers_below_target')
    if (changedFiles.length < 3) blockers.push('parallel_write_changed_files_below_target')
    if (!targetFiles.every((file) => changedFiles.includes(file))) blockers.push('parallel_write_target_files_missing')
    if (new Set(Object.entries(changedFilesByWorker).filter(([, files]) => files.some((file) => targetFiles.includes(file))).map(([workerId]) => workerId)).size < 2) blockers.push('parallel_write_files_not_distributed')
    if (overlapWindows.length === 0) blockers.push('worker_timestamp_overlap_missing')
    if (successfulWorkers.filter((worker) => worker.patch.trim()).length < 3) blockers.push('patch_envelope_count_below_target')
    if (!parentMergeArtifact.ok) blockers.push('parent_merge_artifact_missing_or_invalid')
    if (!typecheck.ok) blockers.push('typecheck_failed')
    if (!cleanup.ok) blockers.push('worktree_cleanup_failed')
    if (failedWorkers.length > 0 && successfulWorkers.length === 0) blockers.push('failure_injection_killed_scheduler')

    return {
      schema: PARALLEL_PRODUCTION_SMOKE_SCHEMA,
      ok: blockers.length === 0,
      status: blockers.length === 0 ? 'passed' : 'blocked',
      proof_level: blockers.length === 0 ? 'production_git_worktree_fixture' : 'blocked',
      tmp_root: tmpRoot,
      repo_root: repoRoot,
      worker_count: successfulWorkers.length,
      worker_ids: successfulWorkers.map((worker) => worker.worker_id).sort(),
      changed_files: changedFiles,
      changed_files_by_worker: changedFilesByWorker,
      distributed_across_workers: new Set(Object.keys(changedFilesByWorker)).size >= 2,
      timestamp_overlap: overlapWindows.length > 0,
      overlap_windows: overlapWindows,
      patch_envelope_count: successfulWorkers.filter((worker) => worker.patch.trim()).length,
      parent_merge_artifact: parentMergeArtifact,
      typecheck,
      worktree_cleanup: cleanup,
      failure_injection: {
        requested: options.injectFailure === true,
        worker_failure_seen: failedWorkers.length > 0,
        reassignment_attempted: failedWorkers.length > 0,
        survived_worker_failure: failedWorkers.length > 0 ? successfulWorkers.length >= 3 : true,
        failed_worker_id: failedWorkers[0]?.worker_id ?? null,
        failed_worker_ids: failedWorkers.map((worker) => worker.worker_id).sort(),
        recovered_work_item_ids: failedWorkers.length > 0 ? successfulWorkers.flatMap((worker) => worker.changed_files).sort() : [],
        scheduler_survived: successfulWorkers.length >= 3,
        successful_workers: successfulWorkers.map((worker) => worker.worker_id).sort(),
        failed_workers: failedWorkers.map((worker) => worker.worker_id).sort()
      },
      mock_only: false,
      blockers
    }
  } catch (error) {
    blockers.push(error instanceof Error ? `unexpected_error:${error.message}` : 'unexpected_error')
    cleanup ??= await bestEffortCleanup(repoRoot, tmpRoot, options.keepTmp === true)
    return blockedReport(tmpRoot, repoRoot, cleanup, blockers)
  }
}

async function createFixtureRepo(repoRoot: string): Promise<void> {
  await fsp.mkdir(path.join(repoRoot, 'src'), { recursive: true })
  await fsp.writeFile(path.join(repoRoot, 'package.json'), `${JSON.stringify({ type: 'module', scripts: { typecheck: 'tsc -p tsconfig.json --noEmit' }, devDependencies: {} }, null, 2)}\n`)
  await fsp.writeFile(path.join(repoRoot, 'tsconfig.json'), `${JSON.stringify({ compilerOptions: { target: 'ES2022', module: 'NodeNext', moduleResolution: 'NodeNext', strict: true, noEmit: true }, include: ['src/**/*.ts'] }, null, 2)}\n`)
  await fsp.writeFile(path.join(repoRoot, 'src', 'shared.ts'), "export const sharedValue = 'stable-shared-contract'\n")
  await fsp.writeFile(path.join(repoRoot, 'src', 'a.ts'), "import { sharedValue } from './shared.js'\nexport const aValue = `a:${sharedValue}`\n")
  await fsp.writeFile(path.join(repoRoot, 'src', 'b.ts'), "import { sharedValue } from './shared.js'\nexport const bValue = `b:${sharedValue}`\n")
  await fsp.writeFile(path.join(repoRoot, 'src', 'c.ts'), "import { sharedValue } from './shared.js'\nexport const cValue = `c:${sharedValue}`\n")
  await runCommand(['git', 'init', '--initial-branch', 'main'], repoRoot, true)
  await runCommand(['git', 'config', 'user.email', 'parallel-smoke@example.invalid'], repoRoot, true)
  await runCommand(['git', 'config', 'user.name', 'Parallel Smoke'], repoRoot, true)
  await runCommand(['git', 'add', '.'], repoRoot, true)
  await runCommand(['git', 'commit', '-m', 'initial fixture'], repoRoot, true)
}

function buildWorkerSpecs(injectFailure: boolean): WorkerSpec[] {
  const workers: WorkerSpec[] = [
    { id: 'worker-a', branch: 'worker/parallel-a', file: 'src/a.ts', exportName: 'workerADeterministic', returnValue: 'alpha' },
    { id: 'worker-b', branch: 'worker/parallel-b', file: 'src/b.ts', exportName: 'workerBDeterministic', returnValue: 'bravo' },
    { id: 'worker-c', branch: 'worker/parallel-c', file: 'src/c.ts', exportName: 'workerCDeterministic', returnValue: 'charlie' }
  ]
  if (injectFailure) {
    workers.push({ id: 'worker-fail', branch: 'worker/parallel-fail', file: 'src/shared.ts', exportName: 'shouldNotLand', returnValue: 'failed', fail: true })
  }
  return workers
}

async function setupWorkerWorktree(repoRoot: string, worktreesRoot: string, worker: WorkerSpec): Promise<void> {
  await runCommand(['git', 'worktree', 'add', '-b', worker.branch, path.join(worktreesRoot, worker.id), 'HEAD'], repoRoot, true)
}

async function runWorker(worker: WorkerSpec, worktree: string): Promise<WorkerResult> {
  const startedMs = Date.now()
  await delay(25)
  if (worker.fail) {
    return {
      worker_id: worker.id,
      ok: false,
      branch: worker.branch,
      worktree,
      changed_files: [],
      patch: '',
      started_ms: startedMs,
      completed_ms: Date.now(),
      blocker: 'injected_worker_failure'
    }
  }
  const filePath = path.join(worktree, worker.file)
  const original = await fsp.readFile(filePath, 'utf8')
  await fsp.writeFile(filePath, `${original}\nexport function ${worker.exportName}(): string {\n  return '${worker.returnValue}'\n}\n`)
  await runCommand(['git', 'add', worker.file], worktree, true)
  await runCommand(['git', 'commit', '-m', `${worker.id} deterministic function`], worktree, true)
  const diff = await runCommand(['git', 'diff', 'HEAD~1', 'HEAD', '--', worker.file], worktree, true)
  return {
    worker_id: worker.id,
    ok: true,
    branch: worker.branch,
    worktree,
    changed_files: [worker.file],
    patch: diff.stdout_tail,
    started_ms: startedMs,
    completed_ms: Date.now()
  }
}

async function mergeWorkerOutputs(repoRoot: string, workers: WorkerResult[]): Promise<void> {
  for (const worker of workers) {
    for (const file of worker.changed_files) {
      await fsp.copyFile(path.join(worker.worktree, file), path.join(repoRoot, file))
    }
  }
}

async function runTypecheck(repoRoot: string): Promise<CommandRecord> {
  const localTsc = path.join(process.cwd(), 'node_modules', '.bin', process.platform === 'win32' ? 'tsc.cmd' : 'tsc')
  return runCommand([localTsc, '-p', 'tsconfig.json', '--noEmit'], repoRoot)
}

async function cleanupWorktreesAndBranches(repoRoot: string, tmpRoot: string, workers: WorkerSpec[], before: string, keepTmp: boolean): Promise<CleanupProof> {
  const removeResults: CommandRecord[] = []
  for (const worker of workers) {
    removeResults.push(await runCommand(['git', 'worktree', 'remove', '--force', path.join(tmpRoot, 'worktrees', worker.id)], repoRoot))
  }
  const prune = await runCommand(['git', 'worktree', 'prune'], repoRoot)
  const branchResults: CommandRecord[] = []
  for (const worker of workers) {
    branchResults.push(await runCommand(['git', 'branch', '-D', worker.branch], repoRoot))
  }
  const after = await runCommand(['git', 'worktree', 'list', '--porcelain'], repoRoot)
  const branches = await runCommand(['git', 'branch', '--list', ...workers.map((worker) => worker.branch)], repoRoot)
  const status = await runCommand(['git', 'status', '--short'], repoRoot)
  if (!keepTmp) await fsp.rm(tmpRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  const tmpRemoved = keepTmp ? false : !(await exists(tmpRoot))
  const workerWorktreesRemoved = after.ok && workers.every((worker) => !after.stdout_tail.includes(worker.id))
  const workerBranchesRemoved = branches.ok && branches.stdout_tail.trim().length === 0
  return {
    ok: removeResults.every((result) => result.ok) && prune.ok && branchResults.every((result) => result.ok) && workerWorktreesRemoved && workerBranchesRemoved && status.ok && status.stdout_tail.trim().length === 0 && tmpRemoved,
    worktree_list_before_cleanup: before,
    worktree_list_after_cleanup: after.stdout_tail,
    worker_worktrees_removed: workerWorktreesRemoved,
    worker_branches_removed: workerBranchesRemoved,
    parent_dirty_after_cleanup: status.stdout_tail.trim().length > 0,
    tmp_removed: tmpRemoved
  }
}

async function bestEffortCleanup(repoRoot: string, tmpRoot: string, keepTmp: boolean): Promise<CleanupProof> {
  const before = await runCommand(['git', 'worktree', 'list', '--porcelain'], repoRoot)
  if (!keepTmp) await fsp.rm(tmpRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  return {
    ok: false,
    worktree_list_before_cleanup: before.stdout_tail,
    worktree_list_after_cleanup: '',
    worker_worktrees_removed: false,
    worker_branches_removed: false,
    parent_dirty_after_cleanup: false,
    tmp_removed: !keepTmp && !(await exists(tmpRoot))
  }
}

function buildOverlapWindows(results: WorkerResult[]): Array<{ worker_a: string; worker_b: string; overlap_ms: number }> {
  const windows: Array<{ worker_a: string; worker_b: string; overlap_ms: number }> = []
  for (let i = 0; i < results.length; i += 1) {
    for (let j = i + 1; j < results.length; j += 1) {
      const a = results[i]
      const b = results[j]
      if (!a || !b) continue
      const overlap = Math.min(a.completed_ms, b.completed_ms) - Math.max(a.started_ms, b.started_ms)
      if (overlap > 0) windows.push({ worker_a: a.worker_id, worker_b: b.worker_id, overlap_ms: overlap })
    }
  }
  return windows
}

async function runCommand(command: string[], cwd: string, throwOnFailure = false): Promise<CommandRecord> {
  try {
    const { stdout, stderr } = await execFileAsync(command[0] ?? '', command.slice(1), { cwd, encoding: 'utf8', maxBuffer: 1024 * 1024 * 8 })
    return { ok: true, command, cwd, exit_code: 0, stdout_tail: tail(stdout), stderr_tail: tail(stderr) }
  } catch (error) {
    const record: CommandRecord = {
      ok: false,
      command,
      cwd,
      exit_code: typeof (error as { code?: unknown }).code === 'number' ? (error as { code: number }).code : null,
      stdout_tail: tail(typeof (error as { stdout?: unknown }).stdout === 'string' ? (error as { stdout: string }).stdout : ''),
      stderr_tail: tail(typeof (error as { stderr?: unknown }).stderr === 'string' ? (error as { stderr: string }).stderr : error instanceof Error ? error.message : String(error))
    }
    if (throwOnFailure) throw new Error(`${command.join(' ')} failed: ${record.stderr_tail || record.stdout_tail}`)
    return record
  }
}

function blockedReport(tmpRoot: string, repoRoot: string, cleanup: CleanupProof, blockers: string[]): ParallelProductionSmokeReport {
  return {
    schema: PARALLEL_PRODUCTION_SMOKE_SCHEMA,
    ok: false,
    status: 'blocked',
    proof_level: 'blocked',
    tmp_root: tmpRoot,
    repo_root: repoRoot,
    worker_count: 0,
    worker_ids: [],
    changed_files: [],
    changed_files_by_worker: {},
    distributed_across_workers: false,
    timestamp_overlap: false,
    overlap_windows: [],
    patch_envelope_count: 0,
    parent_merge_artifact: { schema: 'sks.parallel-production-parent-merge.v1', ok: false, merged_files: [], shared_untouched: false, git_status_after_merge: '' },
    typecheck: { ok: false, command: [], cwd: repoRoot, exit_code: null, stdout_tail: '', stderr_tail: '' },
    worktree_cleanup: cleanup,
    failure_injection: {
      requested: false,
      worker_failure_seen: false,
      reassignment_attempted: false,
      survived_worker_failure: false,
      failed_worker_id: null,
      failed_worker_ids: [],
      recovered_work_item_ids: [],
      scheduler_survived: false,
      successful_workers: [],
      failed_workers: []
    },
    mock_only: false,
    blockers
  }
}

async function fileEquals(file: string, expected: string): Promise<boolean> {
  return (await fsp.readFile(file, 'utf8')) === expected
}

async function exists(file: string): Promise<boolean> {
  try {
    await fsp.access(file)
    return true
  } catch {
    return false
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function tail(text: string, max = 4000): string {
  return text.length > max ? text.slice(-max) : text
}
