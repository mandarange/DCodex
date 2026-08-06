import crypto from 'node:crypto'
import path from 'node:path'
import fs from 'node:fs'
import { RELEASE_ORIGIN_IDENTITY, releaseOriginIdentity } from './release-origin.js'
import {
  exactNpmStageCliInvocation,
  localNpmStageReviewEnvironmentBlocker,
  REQUIRED_NPM_STAGE_CLI_VERSION
} from './npm-stage-contract.js'
import { PHYSICAL_RELEASE_EVIDENCE_REPOSITORY } from './physical-release-gates.js'
import {
  NPM_STAGE_PUBLISH_RECEIPT_SCHEMA,
  STAGE_DISPATCH_NONCE_PATTERN
} from './npm-stage-tarball-verifier-support.js'

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
export const STAGE_RUN_NAME_PREFIX = 'npm-stage'
const NPM_REGISTRY = 'https://registry.npmjs.org/'
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
  readonly physicalEvidenceRunId?: string
  readonly physicalEvidenceArchive?: string
  readonly confirm?: boolean
  readonly run: ProcessRunner
  readonly readJsonFile?: (file: string) => unknown
  readonly artifactDir?: string
  readonly watchTimeoutMs?: number
  readonly env?: NodeJS.ProcessEnv
  /** Test seam for deterministic association; production uses 128 random bits. */
  readonly generateDispatchNonce?: () => string
}

export interface StagePublishReport {
  readonly schema: typeof STAGE_PUBLISH_SCHEMA
  readonly ok: boolean
  readonly confirmed: boolean
  readonly version: string
  readonly release_tag: string
  readonly physical_evidence_run_id: string | null
  readonly dispatch_nonce: string | null
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
  const packageIdentity = readPackageIdentity(opts.root, readJsonFile)
  const version = String(opts.version || packageIdentity.version || '').trim()
  const physicalEvidenceRunId = String(opts.physicalEvidenceRunId || '').trim()
  const confirmed = opts.confirm === true
  let commit: string | null = null
  let runId: string | null = null
  let stageId: string | null = null
  let dispatchNonce: string | null = null

  const preflight = runPreflight(opts, packageIdentity.name, version)
  steps.push(...preflight.steps)
  commit = preflight.commit
  if (!preflight.ok) return finish()

  if (!confirmed) {
    steps.push(skipped('dispatch_nonce', 'confirm_required'), skipped('push', 'confirm_required'), skipped('run_snapshot', 'confirm_required'), skipped('dispatch', 'confirm_required'))
    steps.push(skipped('watch', 'confirm_required'), skipped('download', 'confirm_required'), skipped('verify', 'confirm_required'))
    return finish()
  }

  dispatchNonce = String((opts.generateDispatchNonce || defaultDispatchNonce)()).trim()
  const dispatchNonceOk = STAGE_DISPATCH_NONCE_PATTERN.test(dispatchNonce)
  steps.push(step(
    'dispatch_nonce',
    dispatchNonceOk,
    dispatchNonceOk ? dispatchNonce : null,
    dispatchNonceOk ? null : 'stage_dispatch_nonce_invalid'
  ))
  if (!dispatchNonceOk) return finish()

  const push = opts.run('git', ['push', 'origin', RELEASE_BRANCH])
  steps.push(step('push', push.status === 0, `git push origin ${RELEASE_BRANCH}`, push.status === 0 ? null : 'stage_push_failed'))
  if (push.status !== 0) return finish()

  const priorRuns = snapshotWorkflowRunIds(opts, commit)
  steps.push(step(
    'run_snapshot',
    priorRuns.ok,
    priorRuns.ok ? `${priorRuns.ids.size} existing run(s) for release commit` : priorRuns.detail,
    priorRuns.ok ? null : 'stage_run_snapshot_failed'
  ))
  if (!priorRuns.ok) return finish()

  const dispatch = opts.run('gh', [
    'workflow', 'run', STAGE_WORKFLOW_FILE,
    '--ref', RELEASE_BRANCH,
    '-f', `version=${version}`,
    '-f', `dispatch_nonce=${dispatchNonce}`,
    '-f', `physical_evidence_run_id=${physicalEvidenceRunId}`,
    '-f', 'confirm_stage=true'
  ])
  steps.push(step('dispatch', dispatch.status === 0, `gh workflow run ${STAGE_WORKFLOW_FILE} version=${version} dispatch_nonce=${dispatchNonce} physical_evidence_run_id=${physicalEvidenceRunId} confirm_stage=true`, dispatch.status === 0 ? null : 'stage_dispatch_failed'))
  if (dispatch.status !== 0) return finish()

  const resolvedRun = resolveRunId(
    opts,
    commit,
    priorRuns.ids,
    stageRunDisplayTitle(version, dispatchNonce, physicalEvidenceRunId)
  )
  runId = resolvedRun.runId
  steps.push(step('resolve_run', Boolean(runId), runId ? `run ${runId}` : null, runId ? null : resolvedRun.blocker))
  if (!runId) return finish()

  const watch = opts.run('gh', ['run', 'watch', runId, '--exit-status'], { timeoutMs: opts.watchTimeoutMs ?? 3 * 60 * 60 * 1000 })
  steps.push(step('watch', watch.status === 0, `gh run watch ${runId}`, watch.status === 0 ? null : 'stage_workflow_failed'))
  if (watch.status !== 0) return finish()

  const artifactDir = opts.artifactDir || path.join(opts.root, '.sneakoscope', 'reports', 'release', version, 'stage')
  const download = downloadArtifacts(opts, runId, commit, dispatchNonce, artifactDir)
  steps.push(download.step)
  if (!download.step.ok) return finish()

  const receipt = readStageReceipt(artifactDir, commit, dispatchNonce, physicalEvidenceRunId, runId, readJsonFile)
  stageId = receipt.stageId
  steps.push(step('stage_receipt', Boolean(stageId), receipt.path, stageId ? null : receipt.blocker))
  if (!stageId || !receipt.path) return finish()

  const verify = runLocalVerify(opts, {
    handoffDir: receipt.handoffDir,
    stageReceiptPath: receipt.path,
    version,
    stageId,
    dispatchNonce,
    physicalEvidenceRunId,
    workflowRunId: runId
  })
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
      release_tag: `v${version}`,
      physical_evidence_run_id: /^\d+$/.test(physicalEvidenceRunId) ? physicalEvidenceRunId : null,
      dispatch_nonce: dispatchNonce,
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

function runPreflight(opts: StagePublishOptions, packageName: string, version: string): { ok: boolean; commit: string | null; steps: StagePublishStep[] } {
  const steps: StagePublishStep[] = []
  const branch = text(opts.run('git', ['rev-parse', '--abbrev-ref', 'HEAD']))
  steps.push(step('branch', branch === RELEASE_BRANCH, branch, branch === RELEASE_BRANCH ? null : 'stage_requires_main_branch'))
  const commit = text(opts.run('git', ['rev-parse', 'HEAD'])) || null

  const status = opts.run('git', ['status', '--porcelain'])
  const clean = status.status === 0 && text(status) === ''
  steps.push(step('clean_tree', clean, clean ? 'clean' : 'dirty', clean ? null : 'stage_requires_clean_tree'))

  const versionOk = /^\d+\.\d+\.\d+$/.test(version)
  steps.push(step('version', versionOk, version || null, versionOk ? null : 'stage_version_invalid'))

  const releaseTag = versionOk ? `v${version}` : ''
  const localTag = releaseTag
    ? text(opts.run('git', ['rev-parse', `refs/tags/${releaseTag}^{commit}`]))
    : ''
  const localTagOk = Boolean(commit) && localTag === commit
  steps.push(step(
    'local_release_tag', localTagOk, localTag || releaseTag || null,
    localTagOk ? null : 'stage_local_release_tag_mismatch'
  ))
  const remoteTagResult = releaseTag
    ? opts.run('git', ['ls-remote', '--exit-code', 'origin', `refs/tags/${releaseTag}`, `refs/tags/${releaseTag}^{}`])
    : { status: 1, stdout: '', stderr: '' }
  const remoteTag = remoteTagResult.status === 0 ? remoteReleaseTagCommit(remoteTagResult.stdout, releaseTag) : ''
  const remoteTagOk = Boolean(commit) && remoteTag === commit
  steps.push(step(
    'remote_release_tag', remoteTagOk, remoteTag || releaseTag || null,
    remoteTagOk ? null : 'stage_remote_release_tag_mismatch'
  ))

  const packageNameOk = packageName.length > 0
  steps.push(step('package_name', packageNameOk, packageName || null, packageNameOk ? null : 'stage_package_name_invalid'))

  const origin = releaseOriginIdentity(opts.root)
  const originOk = origin.identity === RELEASE_ORIGIN_IDENTITY
  steps.push(step('origin', originOk, origin.identity || null, originOk ? null : 'stage_origin_identity_mismatch'))

  const stampVerifier = path.join(opts.root, 'dist', 'scripts', 'release-check-stamp.js')
  const stamp = opts.run(process.execPath, [stampVerifier, 'verify'])
  const stampOk = stamp.status === 0
  steps.push(step(
    'release_stamp',
    stampOk,
    stampOk ? 'current source-bound full release stamp verified' : compactProcessOutput(stamp),
    stampOk ? null : 'stage_release_stamp_invalid'
  ))

  const verifier = path.join(opts.root, 'dist', 'scripts', 'npm-stage-tarball-verifier.js')
  const verifierReady = fs.existsSync(verifier)
  steps.push(step(
    'local_review_verifier',
    verifierReady,
    verifierReady ? verifier : null,
    verifierReady ? null : 'stage_verifier_unavailable_outside_checkout'
  ))

  const physicalVerifier = path.join(opts.root, 'dist', 'scripts', 'release-physical-gates-check.js')
  const physicalEvidenceRunId = String(opts.physicalEvidenceRunId || '').trim()
  const physicalEvidenceRunIdReady = /^\d+$/.test(physicalEvidenceRunId)
  steps.push(step(
    'physical_evidence_run_id',
    physicalEvidenceRunIdReady,
    physicalEvidenceRunId || null,
    physicalEvidenceRunIdReady ? null : 'stage_physical_evidence_run_id_invalid'
  ))
  const physicalArgs = [
    physicalVerifier,
    ...(opts.physicalEvidenceArchive ? ['--archive', path.resolve(opts.root, opts.physicalEvidenceArchive)] : []),
    '--evidence-run-id', physicalEvidenceRunId,
    '--repository', PHYSICAL_RELEASE_EVIDENCE_REPOSITORY
  ]
  const physical = physicalEvidenceRunIdReady
    ? opts.run(process.execPath, physicalArgs)
    : { status: 1, stdout: '', stderr: 'physical evidence run id missing or invalid' }
  const physicalReport = safeJsonObject(physical.stdout)
  const physicalReady = physical.status === 0
    && physicalReport?.schema === 'sks.release-physical-gates-inspection.v2'
    && physicalReport?.ok === true
    && physicalReport?.status === 'passed'
    && physicalReport?.release_authorizing === true
    && physicalReport?.inspector_platform === 'darwin'
  steps.push(step(
    'physical_release_gates',
    physicalReady,
    physicalReady
      ? 'all five source-bound physical release receipts and live Desktop Bridge artifacts verified on macOS'
      : compactPhysicalGateFailure(physical, physicalReport),
    physicalReady ? null : 'stage_physical_release_gates_invalid'
  ))

  const reviewEnvironmentBlocker = localNpmStageReviewEnvironmentBlocker(opts.env || process.env)
  steps.push(step(
    'local_review_environment',
    reviewEnvironmentBlocker === null,
    reviewEnvironmentBlocker === null ? 'maintainer-local' : reviewEnvironmentBlocker,
    reviewEnvironmentBlocker === null ? null : `stage_${reviewEnvironmentBlocker}`
  ))

  const npmInvocation = exactNpmStageCliInvocation()
  const npmStageCli = opts.run(npmInvocation.command, [...npmInvocation.args, '--version'])
  const npmStageCliVersion = text(npmStageCli)
  const npmStageCliReady = npmStageCli.status === 0 && npmStageCliVersion === REQUIRED_NPM_STAGE_CLI_VERSION
  steps.push(step(
    'npm_stage_cli',
    npmStageCliReady,
    npmStageCliReady
      ? `${npmStageCliVersion} via ${[npmInvocation.command, ...npmInvocation.args].join(' ')}`
      : compactProcessOutput(npmStageCli) || npmStageCliVersion || null,
    npmStageCliReady
      ? null
      : npmStageCli.status === 0
        ? 'stage_npm_cli_version_mismatch'
        : 'stage_npm_cli_unavailable'
  ))

  if (npmStageCliReady) {
    const npmAuth = opts.run(npmInvocation.command, [
      ...npmInvocation.args,
      'whoami',
      '--registry', NPM_REGISTRY
    ])
    const npmUser = text(npmAuth)
    const npmAuthReady = npmAuth.status === 0 && npmUser.length > 0
    steps.push(step(
      'npm_auth',
      npmAuthReady,
      npmAuthReady ? npmUser : compactProcessOutput(npmAuth),
      npmAuthReady ? null : 'stage_npm_not_authenticated'
    ))

    if (npmAuthReady && packageNameOk) {
      const maintainersResult = opts.run(npmInvocation.command, [
        ...npmInvocation.args,
        'view', packageName, 'maintainers',
        '--json',
        '--registry', NPM_REGISTRY
      ])
      const maintainers = maintainersResult.status === 0 ? npmMaintainerNames(maintainersResult.stdout) : []
      const maintainerListReady = maintainersResult.status === 0 && maintainers.length > 0
      const maintainerMatch = maintainerListReady && maintainers.includes(npmUser)
      steps.push(step(
        'npm_maintainer',
        maintainerListReady && maintainerMatch,
        maintainerListReady
          ? maintainerMatch ? `${npmUser} is a ${packageName} maintainer` : `${npmUser} not in ${maintainers.join(', ')}`
          : compactProcessOutput(maintainersResult),
        maintainerListReady
          ? maintainerMatch ? null : 'stage_npm_user_not_maintainer'
          : 'stage_npm_maintainers_unavailable'
      ))

      if (maintainerListReady && maintainerMatch) {
        const staged = opts.run(npmInvocation.command, [
          ...npmInvocation.args,
          'stage', 'list', packageName,
          '--json',
          '--registry', NPM_REGISTRY
        ])
        const stagedItems = staged.status === 0 ? safeJsonArray(staged.stdout) : []
        const stagedVersion = stagedItems.find((item: any) => String(item?.version || '') === version)
        const stageListReady = staged.status === 0
        steps.push(step(
          'npm_stage_access',
          stageListReady,
          stageListReady ? `${stagedItems.length} staged version(s) visible` : compactProcessOutput(staged),
          stageListReady ? null : 'stage_npm_stage_list_unavailable'
        ))
        if (stageListReady) {
          steps.push(step(
            'npm_stage_version',
            !stagedVersion,
            stagedVersion ? stageItemDetail(stagedVersion) : `${packageName}@${version} is not staged`,
            stagedVersion ? 'stage_version_already_staged' : null
          ))
        }
      }
    }
  }

  const gh = opts.run('gh', ['auth', 'status'])
  steps.push(step('gh_auth', gh.status === 0, gh.status === 0 ? 'authenticated' : null, gh.status === 0 ? null : 'stage_gh_not_authenticated'))

  return { ok: steps.every((entry) => entry.ok), commit, steps }
}

function remoteReleaseTagCommit(output: string, tag: string): string {
  const rows = String(output || '').trim().split(/\r?\n/).filter(Boolean)
  const peeled = rows.find((row) => row.endsWith(`refs/tags/${tag}^{}`))
  return text({ status: 0, stdout: peeled || rows[0] || '', stderr: '' }).split(/\s+/, 1)[0] || ''
}

export function stageRunDisplayTitle(version: string, dispatchNonce: string, physicalEvidenceRunId: string): string {
  return `${STAGE_RUN_NAME_PREFIX}-${version}-${dispatchNonce}-physical-${physicalEvidenceRunId}`
}

function defaultDispatchNonce(): string {
  return crypto.randomBytes(16).toString('hex')
}

interface StageRunResolution {
  readonly runId: string | null
  readonly blocker: 'stage_run_not_found' | 'stage_run_ambiguous'
}

/**
 * The dispatch returns before the run is queryable. The pre-dispatch snapshot
 * excludes old runs, while the run-name nonce excludes concurrent dispatches
 * for the same commit. More than one exact match is an ambiguity, never a
 * reason to guess.
 */
function resolveRunId(
  opts: StagePublishOptions,
  commit: string | null,
  priorRunIds: ReadonlySet<string>,
  expectedDisplayTitle: string
): StageRunResolution {
  if (!commit) return { runId: null, blocker: 'stage_run_not_found' }
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const listed = listWorkflowRuns(opts)
    if (listed.status === 0) {
      const rows = safeJsonArray(listed.stdout)
      const matches = rows.filter((row: any) => {
        const id = String(row?.databaseId ?? '')
        const event = String(row?.event || '')
        return String(row?.headSha || '') === commit
          && String(row?.displayTitle || '') === expectedDisplayTitle
          && id.length > 0
          && !priorRunIds.has(id)
          && event === 'workflow_dispatch'
      })
      if (matches.length > 1) return { runId: null, blocker: 'stage_run_ambiguous' }
      if (matches[0]?.databaseId != null) {
        return { runId: String(matches[0].databaseId), blocker: 'stage_run_not_found' }
      }
    }
    opts.run('sleep', ['2'])
  }
  return { runId: null, blocker: 'stage_run_not_found' }
}

function snapshotWorkflowRunIds(opts: StagePublishOptions, commit: string | null): { ok: boolean; ids: Set<string>; detail: string | null } {
  if (!commit) return { ok: false, ids: new Set(), detail: 'release commit unavailable' }
  const listed = listWorkflowRuns(opts)
  if (listed.status !== 0) return { ok: false, ids: new Set(), detail: compactProcessOutput(listed) }
  const ids = new Set(
    safeJsonArray(listed.stdout)
      .filter((row: any) => String(row?.headSha || '') === commit)
      .map((row: any) => String(row?.databaseId ?? ''))
      .filter(Boolean)
  )
  return { ok: true, ids, detail: null }
}

function listWorkflowRuns(opts: StagePublishOptions): ProcessResult {
  return opts.run('gh', [
    'run', 'list',
    '--workflow', STAGE_WORKFLOW_FILE,
    '--branch', RELEASE_BRANCH,
    '--limit', '100',
    '--json', 'databaseId,headSha,status,event,displayTitle'
  ])
}

function downloadArtifacts(
  opts: StagePublishOptions,
  runId: string,
  commit: string | null,
  dispatchNonce: string,
  dir: string
): { step: StagePublishStep } {
  const names = stageArtifactNames(commit, dispatchNonce)
  if (!names) return { step: step('download', false, null, 'stage_commit_unknown') }
  const args = ['run', 'download', runId, '--dir', dir]
  for (const name of [names.handoff, names.receipt]) args.push('--name', name)
  const result = opts.run('gh', args)
  return { step: step('download', result.status === 0, dir, result.status === 0 ? null : 'stage_artifact_download_failed') }
}

interface StageArtifactNames {
  readonly handoff: string
  readonly receipt: string
}

function stageArtifactNames(commit: string | null, dispatchNonce: string): StageArtifactNames | null {
  if (!commit || !STAGE_DISPATCH_NONCE_PATTERN.test(dispatchNonce)) return null
  return {
    handoff: `stage-input-${commit}-${dispatchNonce}`,
    receipt: `npm-stage-receipt-${commit}-${dispatchNonce}`
  }
}

interface StageReceiptLocation {
  readonly stageId: string | null
  readonly path: string | null
  readonly handoffDir: string
  readonly blocker: string | null
}

function readStageReceipt(
  dir: string,
  commit: string | null,
  dispatchNonce: string,
  physicalEvidenceRunId: string,
  workflowRunId: string,
  readJsonFile: (file: string) => unknown
): StageReceiptLocation {
  const names = stageArtifactNames(commit, dispatchNonce)
  const layouts = names
    ? [
        {
          receiptDir: path.join(dir, names.receipt),
          handoffDir: path.join(dir, names.handoff)
        },
        { receiptDir: dir, handoffDir: dir }
      ]
    : [{ receiptDir: dir, handoffDir: dir }]

  for (const layout of layouts) {
    for (const candidate of ['stage-receipt.json', 'stage-output.json', 'npm-stage-receipt.json']) {
      const file = path.join(layout.receiptDir, candidate)
      const payload = readJsonFile(file) as {
        schema?: unknown
        stage_id?: unknown
        dispatch_nonce?: unknown
        physical_evidence_run_id?: unknown
        workflow_run_id?: unknown
      } | null
      const stageId = String(payload?.stage_id || '').trim()
      if (!stageId) continue
      if (payload?.schema !== NPM_STAGE_PUBLISH_RECEIPT_SCHEMA) {
        return { stageId: null, path: file, handoffDir: layout.handoffDir, blocker: 'stage_receipt_schema_invalid' }
      }
      if (!STAGE_ID_RE.test(stageId)) {
        return { stageId: null, path: file, handoffDir: layout.handoffDir, blocker: 'stage_id_uuid_invalid' }
      }
      if (String(payload?.dispatch_nonce || '') !== dispatchNonce) {
        return { stageId: null, path: file, handoffDir: layout.handoffDir, blocker: 'stage_receipt_dispatch_nonce_mismatch' }
      }
      if (String(payload?.physical_evidence_run_id || '') !== physicalEvidenceRunId) {
        return { stageId: null, path: file, handoffDir: layout.handoffDir, blocker: 'stage_receipt_physical_evidence_run_id_mismatch' }
      }
      if (String(payload?.workflow_run_id || '') !== workflowRunId) {
        return { stageId: null, path: file, handoffDir: layout.handoffDir, blocker: 'stage_receipt_workflow_run_id_mismatch' }
      }
      return { stageId, path: file, handoffDir: layout.handoffDir, blocker: null }
    }
  }
  return { stageId: null, path: null, handoffDir: dir, blocker: 'stage_receipt_missing' }
}

function runLocalVerify(opts: StagePublishOptions, input: {
  handoffDir: string
  stageReceiptPath: string
  version: string
  stageId: string
  dispatchNonce: string
  physicalEvidenceRunId: string
  workflowRunId: string
}): StagePublishStep {
  // The verifier is deliberately excluded from the published tarball; this
  // whole subcommand only runs from a source checkout of this repository.
  const verifier = path.join(opts.root, 'dist', 'scripts', 'npm-stage-tarball-verifier.js')
  if (!fs.existsSync(verifier)) return step('verify', false, verifier, 'stage_verifier_unavailable_outside_checkout')
  const result = opts.run(process.execPath, [
    verifier,
    '--stage-id', input.stageId,
    '--dispatch-nonce', input.dispatchNonce,
    '--physical-evidence-run-id', input.physicalEvidenceRunId,
    '--workflow-run-id', input.workflowRunId,
    '--local-receipt', path.join(input.handoffDir, 'pack-receipt.json'),
    '--local-tarball', path.join(input.handoffDir, `sneakoscope-${input.version}.tgz`),
    '--stage-receipt', input.stageReceiptPath
  ])
  return step('verify', result.status === 0, 'npm-stage-tarball-verifier', result.status === 0 ? null : 'stage_tarball_comparison_failed')
}

function readPackageIdentity(root: string, readJsonFile: (file: string) => unknown): { name: string; version: string } {
  const pkg = readJsonFile(path.join(root, 'package.json')) as { name?: unknown; version?: unknown } | null
  return { name: String(pkg?.name || ''), version: String(pkg?.version || '') }
}

function stageItemDetail(item: any): string {
  const id = String(item?.id || item?.stageId || item?.stage_id || '').trim()
  const version = String(item?.version || '').trim()
  return id ? `${version} already staged as ${id}` : `${version} is already staged`
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

function safeJsonObject(value: string): any | null {
  try {
    const parsed = JSON.parse(value)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null
  } catch {
    return null
  }
}

function npmMaintainerNames(value: string): string[] {
  let parsed: any
  try {
    parsed = JSON.parse(value)
  } catch {
    parsed = value
  }
  const values = Array.isArray(parsed) ? parsed : [parsed]
  return [...new Set(values.flatMap((entry: any) => {
    if (typeof entry === 'string') {
      const name = entry.trim().match(/^([^\s<]+)/)?.[1]
      return name ? [name] : []
    }
    const name = String(entry?.name || '').trim()
    return name ? [name] : []
  }))]
}

function compactPhysicalGateFailure(result: ProcessResult, report: any | null): string | null {
  if (Array.isArray(report?.blockers) && report.blockers.length > 0) {
    return report.blockers.map(String).slice(0, 8).join(', ')
  }
  return compactProcessOutput(result)
}

function text(result: ProcessResult): string {
  return String(result.stdout || '').trim()
}

function compactProcessOutput(result: ProcessResult): string | null {
  return String(result.stderr || result.stdout || '')
    .trim()
    .replace(/\s+/g, ' ')
    .slice(0, 240) || null
}

function step(id: string, ok: boolean, detail: string | null = null, blocker: string | null = null): StagePublishStep {
  return { id, ok, attempted: true, detail, blocker }
}

function skipped(id: string, blocker: string | null): StagePublishStep {
  return { id, ok: true, attempted: false, detail: null, blocker: null, ...(blocker ? { detail: blocker } : {}) }
}
