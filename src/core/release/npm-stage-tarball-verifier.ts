import fs from 'node:fs'
import path from 'node:path'
import {
  compareReleasePacks,
  inspectReleaseTarball,
  validateReleasePackReceipt,
  type ReleasePackReceipt
} from './release-pack-receipt.js'
import {
  NPM_STAGE_REGISTRY,
  NPM_STAGE_REVIEW_RECEIPT_SCHEMA,
  NpmStageReviewError,
  REQUIRED_NPM_STAGE_CLI_VERSION,
  STAGE_DISPATCH_NONCE_PATTERN,
  STAGE_ID_PATTERN,
  assertCommandSucceeded,
  assertMaintainerLocalEnvironment,
  compareReceiptToInspectedTarball,
  digestTarball,
  displayPath,
  hash,
  normalizePath,
  nullableString,
  npmSafeName,
  numberValue,
  parseJsonObject,
  readRequiredFile,
  recordCheck,
  recordValue,
  runReadOnlyNpm,
  stringValue,
  unique,
  validateStagePublishReceipt,
  writePrivate,
  writePrivateJson,
  type StagePublishReceipt
} from './npm-stage-tarball-verifier-support.js'
import { exactNpmStageCliInvocation } from './npm-stage-contract.js'

export {
  NPM_STAGE_REGISTRY,
  NPM_STAGE_REVIEW_RECEIPT_SCHEMA,
  NpmStageReviewError,
  REQUIRED_NPM_STAGE_CLI_VERSION
} from './npm-stage-tarball-verifier-support.js'

export interface NpmStageReviewReceipt {
  schema: typeof NPM_STAGE_REVIEW_RECEIPT_SCHEMA
  ok: boolean
  stage_id: string
  npm_cli_version: string
  registry: typeof NPM_STAGE_REGISTRY
  package_name: string
  package_version: string
  source_commit: string | null
  local: {
    receipt_path: string
    receipt_sha256: string
    tarball_path: string
    bytes: number
    unpacked_bytes: number
    file_count: number
    file_list_sha256: string
    sha256: string
    sha512: string
    integrity: string
  }
  workflow_stage: {
    receipt_path: string
    receipt_sha256: string
    dispatch_nonce: string
    physical_evidence_run_id: string
    workflow_run_id: string | null
    workflow_run_attempt: string | null
  }
  stage_view: {
    output_path: string
    output_sha256: string
    stage_id: string
    package_name: string
    package_version: string
    tag: string | null
    shasum: string | null
  }
  stage_download: {
    output_path: string
    output_sha256: string
    tarball_path: string
    bytes: number
    unpacked_bytes: number
    file_count: number
    file_list_sha256: string
    sha256: string
    sha512: string
    integrity: string
    npm_reported: {
      name: string
      version: string
      filename: string
      size: number
      unpacked_size: number
      shasum: string
      integrity: string
      entry_count: number
    }
  }
  read_only_commands: {
    view_argv: string[]
    download_argv: string[]
    view_argv_sha256: string
    download_argv_sha256: string
  }
  checks: Record<string, boolean>
  oidc_review_supported: false
  maintainer_session_required: true
  human_review_required: true
  human_2fa_pending: true
  generated_at: string
  blockers: string[]
}

export interface VerifyNpmStageTarballInput {
  root: string
  stageId: string
  expectedDispatchNonce: string
  expectedPhysicalEvidenceRunId: string
  expectedWorkflowRunId: string
  localReceiptPath: string
  localTarballPath: string
  stageReceiptPath: string
  outputDir?: string
  npmCommand?: string
  npmCommandArgs?: string[]
  env?: NodeJS.ProcessEnv
}

export interface VerifyNpmStageTarballResult {
  receipt: NpmStageReviewReceipt
  receiptPath: string
  outputDir: string
}

export function verifyNpmStageTarball(input: VerifyNpmStageTarballInput): VerifyNpmStageTarballResult {
  const root = path.resolve(input.root)
  const stageId = String(input.stageId || '').trim().toLowerCase()
  if (!STAGE_ID_PATTERN.test(stageId)) throw new NpmStageReviewError('stage_id_uuid_invalid')
  const expectedDispatchNonce = String(input.expectedDispatchNonce || '').trim()
  if (!STAGE_DISPATCH_NONCE_PATTERN.test(expectedDispatchNonce)) throw new NpmStageReviewError('dispatch_nonce_invalid')
  const expectedPhysicalEvidenceRunId = String(input.expectedPhysicalEvidenceRunId || '').trim()
  if (!/^\d+$/.test(expectedPhysicalEvidenceRunId)) throw new NpmStageReviewError('physical_evidence_run_id_invalid')
  const expectedWorkflowRunId = String(input.expectedWorkflowRunId || '').trim()
  if (!/^\d+$/.test(expectedWorkflowRunId)) throw new NpmStageReviewError('workflow_run_id_invalid')

  const env = { ...process.env, ...(input.env || {}) }
  assertMaintainerLocalEnvironment(env)

  const localReceiptFile = path.resolve(root, input.localReceiptPath)
  const localTarballFile = path.resolve(root, input.localTarballPath)
  const stageReceiptFile = path.resolve(root, input.stageReceiptPath)
  const localReceiptBytes = readRequiredFile(localReceiptFile, 'local_pack_receipt_missing_or_unreadable')
  const localTarballBytes = readRequiredFile(localTarballFile, 'local_tarball_missing_or_unreadable')
  const stageReceiptBytes = readRequiredFile(stageReceiptFile, 'workflow_stage_receipt_missing_or_unreadable')
  const localReceipt = parseJsonObject(localReceiptBytes.toString('utf8'), 'local_pack_receipt_json_invalid') as unknown as ReleasePackReceipt
  const stageReceipt = parseJsonObject(stageReceiptBytes.toString('utf8'), 'workflow_stage_receipt_json_invalid') as StagePublishReceipt

  const localValidation = validateReleasePackReceipt(localReceipt, 'local', { requireNpmPackProof: true })
  if (!localValidation.ok) {
    throw new NpmStageReviewError('local_pack_receipt_invalid', localValidation.blockers.join(','))
  }
  const stageReceiptBlockers = validateStagePublishReceipt(stageReceipt, {
    stageId,
    dispatchNonce: expectedDispatchNonce,
    physicalEvidenceRunId: expectedPhysicalEvidenceRunId,
    workflowRunId: expectedWorkflowRunId,
    localReceipt,
    localReceiptSha256: hash(localReceiptBytes, 'sha256', 'hex'),
    localTarballSha512: hash(localTarballBytes, 'sha512', 'hex')
  })
  if (stageReceiptBlockers.length > 0) {
    throw new NpmStageReviewError('workflow_stage_receipt_invalid', stageReceiptBlockers.join(','))
  }

  const localInspected = inspectReleaseTarball({
    tarball: localTarballFile,
    kind: 'staged',
    root
  })
  const localInputBlockers = compareReceiptToInspectedTarball(localReceipt, localInspected)
  if (localInputBlockers.length > 0) {
    throw new NpmStageReviewError('local_tarball_receipt_binding_invalid', localInputBlockers.join(','))
  }

  const outputDir = path.resolve(
    root,
    input.outputDir || path.join(
      '.sneakoscope',
      'reports',
      'release',
      localReceipt.package_version,
      'npm-stage-review',
      stageId
    )
  )
  if (fs.existsSync(outputDir)) throw new NpmStageReviewError('review_output_already_exists')
  const outputParent = path.dirname(outputDir)
  fs.mkdirSync(outputParent, { recursive: true, mode: 0o700 })
  const temporaryOutput = fs.mkdtempSync(path.join(outputParent, '.npm-stage-review-'))
  fs.chmodSync(temporaryOutput, 0o700)

  try {
    const inputDir = path.join(temporaryOutput, 'inputs')
    const downloadDir = path.join(temporaryOutput, 'downloaded')
    fs.mkdirSync(inputDir, { recursive: true, mode: 0o700 })
    fs.mkdirSync(downloadDir, { recursive: true, mode: 0o700 })
    writePrivate(path.join(inputDir, 'local-pack-receipt.json'), localReceiptBytes)
    writePrivate(path.join(inputDir, 'workflow-stage-receipt.json'), stageReceiptBytes)

    const npmInvocation = input.npmCommand
      ? { command: input.npmCommand, args: [...(input.npmCommandArgs || [])] }
      : exactNpmStageCliInvocation()
    const runNpm = (args: string[], cwd: string) => runReadOnlyNpm(
      npmInvocation.command,
      [...npmInvocation.args, ...args],
      cwd,
      env
    )
    const versionResult = runNpm(['--version'], temporaryOutput)
    assertCommandSucceeded(versionResult, 'npm_version_check_failed')
    const npmVersion = versionResult.stdout.trim()
    if (npmVersion !== REQUIRED_NPM_STAGE_CLI_VERSION) {
      throw new NpmStageReviewError('npm_stage_cli_version_mismatch', `expected ${REQUIRED_NPM_STAGE_CLI_VERSION}, received ${npmVersion || 'empty'}`)
    }

    const viewArgv = ['stage', 'view', stageId, '--json', '--registry', NPM_STAGE_REGISTRY]
    const viewResult = runNpm(viewArgv, temporaryOutput)
    assertCommandSucceeded(viewResult, 'npm_stage_view_failed')
    const viewOutputFile = path.join(temporaryOutput, 'stage-view.json')
    writePrivate(viewOutputFile, Buffer.from(viewResult.stdout))
    const view = parseJsonObject(viewResult.stdout, 'npm_stage_view_json_invalid')

    const downloadArgv = ['stage', 'download', stageId, '--json', '--registry', NPM_STAGE_REGISTRY]
    const downloadResult = runNpm(downloadArgv, downloadDir)
    assertCommandSucceeded(downloadResult, 'npm_stage_download_failed')
    const downloadOutputFile = path.join(temporaryOutput, 'stage-download.json')
    writePrivate(downloadOutputFile, Buffer.from(downloadResult.stdout))
    const downloadOutput = parseJsonObject(downloadResult.stdout, 'npm_stage_download_json_invalid')
    const npmDownloadInfo = recordValue(downloadOutput[localReceipt.package_name])
    if (!npmDownloadInfo) throw new NpmStageReviewError('npm_stage_download_package_key_missing')

    const downloadedTarballs = fs.readdirSync(downloadDir)
      .filter((file) => file.endsWith('.tgz'))
      .sort()
    if (downloadedTarballs.length !== 1) throw new NpmStageReviewError('npm_stage_download_tarball_count_invalid')
    const downloadedTarballName = downloadedTarballs[0]
    if (!downloadedTarballName) throw new NpmStageReviewError('npm_stage_download_tarball_missing')
    const downloadedTarballFile = path.join(downloadDir, downloadedTarballName)
    fs.chmodSync(downloadedTarballFile, 0o600)
    const downloadedTarballBytes = readRequiredFile(downloadedTarballFile, 'npm_stage_download_tarball_unreadable')
    const downloaded = inspectReleaseTarball({ tarball: downloadedTarballFile, kind: 'staged', root })

    const localDigests = digestTarball(localTarballBytes)
    const downloadedDigests = digestTarball(downloadedTarballBytes)
    const viewStageId = stringValue(view.id).toLowerCase()
    const viewPackageName = stringValue(view.packageName)
    const viewPackageVersion = stringValue(view.version)
    const viewTag = nullableString(view.tag)
    const viewShasum = nullableString(view.shasum)
    const npmReported = {
      name: stringValue(npmDownloadInfo.name),
      version: stringValue(npmDownloadInfo.version),
      filename: stringValue(npmDownloadInfo.filename),
      size: numberValue(npmDownloadInfo.size),
      unpacked_size: numberValue(npmDownloadInfo.unpackedSize),
      shasum: stringValue(npmDownloadInfo.shasum),
      integrity: stringValue(npmDownloadInfo.integrity),
      entry_count: numberValue(npmDownloadInfo.entryCount)
    }
    const expectedNpmFilename = `${npmSafeName(localReceipt.package_name)}-${localReceipt.package_version}.tgz`
    const expectedDownloadedFilename = `${npmSafeName(localReceipt.package_name)}-${localReceipt.package_version}-${stageId}.tgz`
    const actualShasum = hash(downloadedTarballBytes, 'sha1', 'hex')
    const checks: Record<string, boolean> = {}
    const blockers: string[] = []
    recordCheck(checks, blockers, 'view_stage_id_match', viewStageId === stageId)
    recordCheck(checks, blockers, 'view_package_name_match', viewPackageName === localReceipt.package_name)
    recordCheck(checks, blockers, 'view_package_version_match', viewPackageVersion === localReceipt.package_version)
    recordCheck(checks, blockers, 'download_filename_match', downloadedTarballName === expectedDownloadedFilename)
    recordCheck(checks, blockers, 'download_json_package_name_match', npmReported.name === localReceipt.package_name)
    recordCheck(checks, blockers, 'download_json_package_version_match', npmReported.version === localReceipt.package_version)
    recordCheck(checks, blockers, 'download_json_filename_match', npmReported.filename === expectedNpmFilename)
    recordCheck(checks, blockers, 'download_json_bytes_match', npmReported.size === downloadedTarballBytes.length)
    recordCheck(checks, blockers, 'download_json_unpacked_bytes_match', npmReported.unpacked_size === downloaded.unpacked_bytes)
    recordCheck(checks, blockers, 'download_json_file_count_match', npmReported.entry_count === downloaded.file_count)
    recordCheck(checks, blockers, 'download_json_shasum_match', npmReported.shasum === actualShasum)
    recordCheck(checks, blockers, 'download_json_integrity_match', npmReported.integrity === downloadedDigests.integrity)
    recordCheck(checks, blockers, 'view_shasum_match', viewShasum === null || viewShasum === actualShasum)
    recordCheck(checks, blockers, 'package_name_match', downloaded.package_name === localReceipt.package_name)
    recordCheck(checks, blockers, 'package_version_match', downloaded.package_version === localReceipt.package_version)
    recordCheck(checks, blockers, 'packed_bytes_match', downloadedTarballBytes.length === localTarballBytes.length)
    recordCheck(checks, blockers, 'unpacked_bytes_match', downloaded.unpacked_bytes === localReceipt.unpacked_bytes)
    recordCheck(checks, blockers, 'file_count_match', downloaded.file_count === localReceipt.file_count)
    recordCheck(checks, blockers, 'file_list_match', downloaded.file_list_sha256 === localReceipt.file_list_sha256)
    recordCheck(checks, blockers, 'exact_bytes_match', localTarballBytes.equals(downloadedTarballBytes))
    recordCheck(checks, blockers, 'sha256_match', localDigests.sha256 === downloadedDigests.sha256)
    recordCheck(checks, blockers, 'sha512_match', localDigests.sha512 === downloadedDigests.sha512)
    recordCheck(checks, blockers, 'integrity_match', localDigests.integrity === downloadedDigests.integrity)
    recordCheck(checks, blockers, 'stage_receipt_sha256_match', downloadedDigests.sha256 === stringValue(stageReceipt.tarball_sha256))
    recordCheck(checks, blockers, 'stage_receipt_sha512_match', downloadedDigests.sha512 === stringValue(stageReceipt.tarball_sha512))
    recordCheck(checks, blockers, 'stage_receipt_integrity_match', downloadedDigests.integrity === stringValue(stageReceipt.tarball_integrity))
    recordCheck(checks, blockers, 'stage_receipt_bytes_match', downloadedTarballBytes.length === numberValue(stageReceipt.packed_bytes))
    recordCheck(checks, blockers, 'stage_receipt_unpacked_bytes_match', downloaded.unpacked_bytes === numberValue(stageReceipt.unpacked_bytes))
    recordCheck(checks, blockers, 'stage_receipt_file_count_match', downloaded.file_count === numberValue(stageReceipt.file_count))
    recordCheck(checks, blockers, 'download_inspection_ok', downloaded.ok === true)
    for (const blocker of downloaded.blockers) blockers.push(`downloaded_tarball:${blocker}`)
    const comparison = compareReleasePacks(localReceipt, downloaded)
    recordCheck(checks, blockers, 'release_pack_comparison_ok', comparison.ok === true)
    blockers.push(...comparison.blockers.map((blocker) => `release_pack_compare:${blocker}`))

    const receipt: NpmStageReviewReceipt = {
      schema: NPM_STAGE_REVIEW_RECEIPT_SCHEMA,
      ok: unique(blockers).length === 0,
      stage_id: stageId,
      npm_cli_version: npmVersion,
      registry: NPM_STAGE_REGISTRY,
      package_name: localReceipt.package_name,
      package_version: localReceipt.package_version,
      source_commit: localReceipt.source_commit,
      local: {
        receipt_path: displayPath(root, localReceiptFile),
        receipt_sha256: hash(localReceiptBytes, 'sha256', 'hex'),
        tarball_path: displayPath(root, localTarballFile),
        bytes: localTarballBytes.length,
        unpacked_bytes: localInspected.unpacked_bytes,
        file_count: localInspected.file_count,
        file_list_sha256: localInspected.file_list_sha256,
        sha256: localDigests.sha256,
        sha512: localDigests.sha512,
        integrity: localDigests.integrity
      },
      workflow_stage: {
        receipt_path: displayPath(root, stageReceiptFile),
        receipt_sha256: hash(stageReceiptBytes, 'sha256', 'hex'),
        dispatch_nonce: expectedDispatchNonce,
        physical_evidence_run_id: expectedPhysicalEvidenceRunId,
        workflow_run_id: nullableString(stageReceipt.workflow_run_id),
        workflow_run_attempt: nullableString(stageReceipt.workflow_run_attempt)
      },
      stage_view: {
        output_path: 'stage-view.json',
        output_sha256: hash(Buffer.from(viewResult.stdout), 'sha256', 'hex'),
        stage_id: viewStageId,
        package_name: viewPackageName,
        package_version: viewPackageVersion,
        tag: viewTag,
        shasum: viewShasum
      },
      stage_download: {
        output_path: 'stage-download.json',
        output_sha256: hash(Buffer.from(downloadResult.stdout), 'sha256', 'hex'),
        tarball_path: normalizePath(path.join('downloaded', downloadedTarballName)),
        bytes: downloadedTarballBytes.length,
        unpacked_bytes: downloaded.unpacked_bytes,
        file_count: downloaded.file_count,
        file_list_sha256: downloaded.file_list_sha256,
        sha256: downloadedDigests.sha256,
        sha512: downloadedDigests.sha512,
        integrity: downloadedDigests.integrity,
        npm_reported: npmReported
      },
      read_only_commands: {
        view_argv: [npmInvocation.command, ...npmInvocation.args, ...viewArgv],
        download_argv: [npmInvocation.command, ...npmInvocation.args, ...downloadArgv],
        view_argv_sha256: hash(Buffer.from(JSON.stringify([npmInvocation.command, ...npmInvocation.args, ...viewArgv])), 'sha256', 'hex'),
        download_argv_sha256: hash(Buffer.from(JSON.stringify([npmInvocation.command, ...npmInvocation.args, ...downloadArgv])), 'sha256', 'hex')
      },
      checks,
      oidc_review_supported: false,
      maintainer_session_required: true,
      human_review_required: true,
      human_2fa_pending: true,
      generated_at: new Date().toISOString(),
      blockers: unique(blockers)
    }
    receipt.ok = receipt.blockers.length === 0
    writePrivateJson(path.join(temporaryOutput, 'stage-review-receipt.json'), receipt)
    fs.renameSync(temporaryOutput, outputDir)
    fs.chmodSync(outputDir, 0o700)
    return {
      receipt,
      receiptPath: path.join(outputDir, 'stage-review-receipt.json'),
      outputDir
    }
  } catch (error) {
    fs.rmSync(temporaryOutput, { recursive: true, force: true })
    throw error
  }
}
