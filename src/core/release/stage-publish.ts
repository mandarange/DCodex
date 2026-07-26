import path from 'node:path'
import fs from 'node:fs'
import { RELEASE_ORIGIN_IDENTITY, releaseOriginIdentity } from './release-origin.js'

/**
 * Drives the documented staged-publish flow as far as automation is allowed to
 * go, and stops there.
 *
 * The flow is: push the verified commit to `main`, dispatch the OIDC stage
 * workflow, wait for it, download the immutable handoff and stage receipt, and
 * run the maintainer-local read-only tarball comparison. What it never does is
 * `npm stage approve` — that step is a human 2FA decision, and the release
 * contract says automation must stop before it. Nothing here holds an npm
 * write token; publication authority stays with Trusted Publishing in the
 * workflow and with the person who approves the stage.
 *
 * Every outward-facing step (push, dispatch) requires an explicit `confirm`.
 * Without it this is a read-only preflight that reports what it would do.
 */

export const STAGE_PUBLISH_SCHEMA = 'sks.release-stage-publish.v1'
export const STAGE_WORKFLOW_FILE = 'publish-npm.yml'
export const RELEASE_BRANCH = 'main'
const STAGE_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export interface ProcessResult {
  status: number | null
  stdout: string
  stderr: string
}

export type ProcessRunner = (command: string, args: readonly string[], opts?: { timeoutMs?: number }) => ProcessResult

export interface StagePublishStep {
  readonly id: string
  readonly ok: boolean
  readonly attempted: boolean
  readonly detail?: string | null
  readonly blocker?: string | null
}

export interface StagePublishOptions {
  readonly root: string
  readonly version?: string
  readonly confirm?: boolean
  readonly run: ProcessRunner
  readonly readJsonFile?: (file: string) => unknown
  readonly artifactDir?: string
  readonly watchTimeoutMs?: number
}

export interface StagePublishReport {
  readonly schema: typeof STAGE_PUBLISH_SCHEMA
  readonly ok: boolean
  readonly confirmed: boolean
  readonly version: string
  readonly commit: string | null
  readonly run_id: string | null
  readonly stage_id: string | null
  readonly steps: readonly StagePublishStep[]
  readonly blockers: readonly string[]
  /** Printed for the operator; this command must never execute it. */
  readonly approval_command: string | null
  readonly approval_is_human_2fa_step: true
  readonly next_actions: readonly string[]
}

export function stagePublish(opts: StagePublishOptions): StagePublishReport {
  const readJsonFile = opts.readJsonFile || defaultReadJson
  const steps: StagePublishStep[] = []
  const version = String(opts.version || readPackageVersion(opts.root, readJsonFile) || '').trim()
  const confirmed = opts.confirm === true
  let commit: string | null = null
  let runId: string | null = null
  let stageId: string | null = null

  const preflight = runPreflight(opts, version)
  steps.push(...preflight.steps)
  commit = preflight.commit
  if (!preflight.ok) return finish()

  if (!confirmed) {
    steps.push(skipped('push', 'confirm_required'), skipped('dispatch', 'confirm_required'))
    steps.push(skipped('watch', 'confirm_required'), skipped('download', 'confirm_required'), skipped('verify', 'confirm_required'))
    return finish()
  }

  const push = opts.run('git', ['push', 'origin', RELEASE_BRANCH])
  steps.push(step('push', push.status === 0, `git push origin ${RELEASE_BRANCH}`, push.status === 0 ? null : 'stage_push_failed'))
  if (push.status !== 0) return finish()

  const dispatch = opts.run('gh', [
    'workflow', 'run', STAGE_WORKFLOW_FILE,
    '--ref', RELEASE_BRANCH,
    '-f', `version=${version}`,
    '-f', 'confirm_stage=true'
  ])
  steps.push(step('dispatch', dispatch.status === 0, `gh workflow run ${STAGE_WORKFLOW_FILE} version=${version} confirm_stage=true`, dispatch.status === 0 ? null : 'stage_dispatch_failed'))
  if (dispatch.status !== 0) return finish()

  runId = resolveRunId(opts, commit)
  steps.push(step('resolve_run', Boolean(runId), runId ? `run ${runId}` : null, runId ? null : 'stage_run_not_found'))
  if (!runId) return finish()

  const watch = opts.run('gh', ['run', 'watch', runId, '--exit-status'], { timeoutMs: opts.watchTimeoutMs ?? 3 * 60 * 60 * 1000 })
  steps.push(step('watch', watch.status === 0, `gh run watch ${runId}`, watch.status === 0 ? null : 'stage_workflow_failed'))
  if (watch.status !== 0) return finish()

  const artifactDir = opts.artifactDir || path.join(opts.root, '.sneakoscope', 'reports', 'release', version, 'stage')
  const download = downloadArtifacts(opts, runId, commit, artifactDir)
  steps.push(download.step)
  if (!download.step.ok) return finish()

  const receipt = readStageReceipt(artifactDir, readJsonFile)
  stageId = receipt.stageId
  steps.push(step('stage_receipt', Boolean(stageId), receipt.path, stageId ? null : receipt.blocker))
  if (!stageId) return finish()

  const verify = runLocalVerify(opts, { artifactDir, version, stageId })
  steps.push(verify)
  return finish()

  function finish(): StagePublishReport {
    const blockers = steps.filter((entry) => entry.blocker).map((entry) => String(entry.blocker))
    const reachedApproval = Boolean(stageId) && steps.every((entry) => entry.ok || entry.blocker === null)
    return {
      schema: STAGE_PUBLISH_SCHEMA,
      ok: blockers.length === 0 && (confirmed ? reachedApproval : true),
      confirmed,
      version,
      commit,
      run_id: runId,
      stage_id: stageId,
      steps,
      blockers,
      approval_command: stageId ? `npm stage approve ${stageId}` : null,
      approval_is_human_2fa_step: true,
      next_actions: nextActions({ confirmed, stageId, blockers })
    }
  }
}

function nextActions(state: { confirmed: boolean; stageId: string | null; blockers: readonly string[] }): string[] {
  if (!state.confirmed) return ['Re-run with --confirm to push, dispatch the stage workflow, and verify the staged tarball.']
  if (state.blockers.length) return ['Resolve the blockers above, then re-run with --confirm.']
  if (!state.stageId) return ['No stage id was produced; inspect the workflow run before retrying.']
  return [
    `Review the comparison receipt, then approve with 2FA yourself: npm stage approve ${state.stageId}`,
    'Staging is not publication. Nothing is public until that approval completes.'
  ]
}

function runPreflight(opts: StagePublishOptions, version: string): { ok: boolean; commit: string | null; steps: StagePublishStep[] } {
  const steps: StagePublishStep[] = []
  const branch = text(opts.run('git', ['rev-parse', '--abbrev-ref', 'HEAD']))
  steps.push(step('branch', branch === RELEASE_BRANCH, branch, branch === RELEASE_BRANCH ? null : 'stage_requires_main_branch'))

  const status = opts.run('git', ['status', '--porcelain'])
  const clean = status.status === 0 && text(status) === ''
  steps.push(step('clean_tree', clean, clean ? 'clean' : 'dirty', clean ? null : 'stage_requires_clean_tree'))

  const versionOk = /^\d+\.\d+\.\d+$/.test(version)
  steps.push(step('version', versionOk, version || null, versionOk ? null : 'stage_version_invalid'))

  const origin = releaseOriginIdentity(opts.root)
  const originOk = origin.identity === RELEASE_ORIGIN_IDENTITY
  steps.push(step('origin', originOk, origin.identity || null, originOk ? null : 'stage_origin_identity_mismatch'))

  const gh = opts.run('gh', ['auth', 'status'])
  steps.push(step('gh_auth', gh.status === 0, gh.status === 0 ? 'authenticated' : null, gh.status === 0 ? null : 'stage_gh_not_authenticated'))

  const commit = text(opts.run('git', ['rev-parse', 'HEAD'])) || null
  return { ok: steps.every((entry) => entry.ok), commit, steps }
}

/**
 * The dispatch returns before the run is queryable, so the run is matched by
 * the exact pushed commit rather than by "most recent".
 */
function resolveRunId(opts: StagePublishOptions, commit: string | null): string | null {
  if (!commit) return null
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const listed = opts.run('gh', [
      'run', 'list',
      '--workflow', STAGE_WORKFLOW_FILE,
      '--branch', RELEASE_BRANCH,
      '--limit', '20',
      '--json', 'databaseId,headSha,status'
    ])
    if (listed.status === 0) {
      const rows = safeJsonArray(listed.stdout)
      const match = rows.find((row: any) => String(row?.headSha || '') === commit)
      if (match?.databaseId != null) return String(match.databaseId)
    }
    opts.run('sleep', ['2'])
  }
  return null
}

function downloadArtifacts(opts: StagePublishOptions, runId: string, commit: string | null, dir: string): { step: StagePublishStep } {
  const names = commit ? [`stage-input-${commit}`, `npm-stage-receipt-${commit}`] : []
  if (!names.length) return { step: step('download', false, null, 'stage_commit_unknown') }
  const args = ['run', 'download', runId, '--dir', dir]
  for (const name of names) args.push('--name', name)
  const result = opts.run('gh', args)
  return { step: step('download', result.status === 0, dir, result.status === 0 ? null : 'stage_artifact_download_failed') }
}

function readStageReceipt(dir: string, readJsonFile: (file: string) => unknown): { stageId: string | null; path: string | null; blocker: string | null } {
  for (const candidate of ['stage-receipt.json', 'stage-output.json', 'npm-stage-receipt.json']) {
    const file = path.join(dir, candidate)
    const payload = readJsonFile(file) as { stage_id?: unknown } | null
    const stageId = String(payload?.stage_id || '').trim()
    if (!stageId) continue
    if (!STAGE_ID_RE.test(stageId)) return { stageId: null, path: file, blocker: 'stage_id_uuid_invalid' }
    return { stageId, path: file, blocker: null }
  }
  return { stageId: null, path: null, blocker: 'stage_receipt_missing' }
}

function runLocalVerify(opts: StagePublishOptions, input: { artifactDir: string; version: string; stageId: string }): StagePublishStep {
  // The verifier is deliberately excluded from the published tarball; this
  // whole subcommand only runs from a source checkout of this repository.
  const verifier = path.join(opts.root, 'dist', 'scripts', 'npm-stage-tarball-verifier.js')
  if (!fs.existsSync(verifier)) return step('verify', false, verifier, 'stage_verifier_unavailable_outside_checkout')
  const result = opts.run(process.execPath, [
    verifier,
    '--stage-id', input.stageId,
    '--local-receipt', path.join(input.artifactDir, 'pack-receipt.json'),
    '--local-tarball', path.join(input.artifactDir, `sneakoscope-${input.version}.tgz`),
    '--stage-receipt', path.join(input.artifactDir, 'stage-receipt.json')
  ])
  return step('verify', result.status === 0, 'npm-stage-tarball-verifier', result.status === 0 ? null : 'stage_tarball_comparison_failed')
}

function readPackageVersion(root: string, readJsonFile: (file: string) => unknown): string {
  const pkg = readJsonFile(path.join(root, 'package.json')) as { version?: unknown } | null
  return String(pkg?.version || '')
}

function defaultReadJson(file: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

function safeJsonArray(value: string): any[] {
  try {
    const parsed = JSON.parse(value)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

function text(result: ProcessResult): string {
  return String(result.stdout || '').trim()
}

function step(id: string, ok: boolean, detail: string | null = null, blocker: string | null = null): StagePublishStep {
  return { id, ok, attempted: true, detail, blocker }
}

function skipped(id: string, blocker: string | null): StagePublishStep {
  return { id, ok: true, attempted: false, detail: null, blocker: null, ...(blocker ? { detail: blocker } : {}) }
}
