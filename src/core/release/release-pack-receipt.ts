import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { tmpdir } from '../fsx.js'
import { DEFAULT_MAX_PACK_BYTES, DEFAULT_MAX_UNPACKED_BYTES } from './package-size-budget.js'
import { readCurrentNpmPackGateArtifacts } from './npm-pack-proof.js'
import {
  scanTarballTextContents,
  type ReleasePackContentPattern
} from './release-pack-content-scanner.js'
import {
  RELEASE_PACK_COMPARE_SCHEMA,
  RELEASE_PACK_RECEIPT_SCHEMA,
  type ReleasePackCompare,
  type ReleasePackKind,
  type ReleasePackReceipt
} from './release-pack-contract.js'
import { tarInventory, tarPackageJson, tarUnpackedBytes } from './release-pack-tarball.js'

export {
  RELEASE_PACK_COMPARE_SCHEMA,
  RELEASE_PACK_RECEIPT_SCHEMA,
  type ReleasePackCompare,
  type ReleasePackKind,
  type ReleasePackReceipt
} from './release-pack-contract.js'

export function releaseProofDir(root: string, version: string): string {
  return path.join(root, '.sneakoscope', 'reports', 'release', version)
}

export function inspectReleaseTarball(input: {
  tarball: string
  kind: ReleasePackKind
  sourceCommit?: string | null
  npmPackProof?: ReleasePackReceipt['npm_pack_proof']
  root?: string
}): ReleasePackReceipt {
  const tarball = path.resolve(input.tarball)
  const blockers: string[] = []
  let bytes = Buffer.alloc(0)
  try {
    bytes = fs.readFileSync(tarball)
  } catch {
    blockers.push('tarball_missing_or_unreadable')
  }
  const inventory = bytes.length ? tarInventory(tarball) : { files: [], blockers: ['tarball_inventory_unavailable'] }
  blockers.push(...inventory.blockers)
  const packageJson = bytes.length ? tarPackageJson(tarball) : null
  if (!packageJson) blockers.push('tarball_package_json_missing_or_invalid')
  const files = [...inventory.files].sort()
  const retiredPackagedFiles = files.filter((file) => RETIRED_PACKAGED_FILE_PATTERNS.some((pattern) => pattern.test(file)))
  blockers.push(...retiredPackagedFiles.map((file) => `retired_package_file_present:${file}`))
  const unpackedBytes = bytes.length && inventory.blockers.length === 0 ? tarUnpackedBytes(tarball) : 0
  const secretScan = bytes.length && inventory.blockers.length === 0
    ? scanTarballContents(tarball)
    : { ok: false, scanned_files: 0, scanned_bytes: 0, findings: [], blockers: ['tarball_secret_scan_unavailable'] }
  blockers.push(...secretScan.blockers)
  const retiredSurfaceScan = bytes.length && inventory.blockers.length === 0
    ? scanRetiredSurfaceContents(tarball)
    : { ok: false, scanned_files: 0, scanned_bytes: 0, allowlisted_finding_count: 0, findings: [], blockers: ['tarball_retired_surface_scan_unavailable'] }
  blockers.push(...retiredSurfaceScan.blockers)
  if (bytes.length && unpackedBytes <= 0) blockers.push('tarball_unpacked_size_unavailable')
  const sha256 = bytes.length ? hash(bytes, 'sha256', 'hex') : ''
  const sha512Base64 = bytes.length ? hash(bytes, 'sha512', 'base64') : ''
  const sourceBinding = input.kind === 'local' && input.root && input.sourceCommit && bytes.length && inventory.blockers.length === 0
    ? inspectSourcePackageBinding(input.root, input.sourceCommit, tarball, files, sha256)
    : null
  if (sourceBinding) blockers.push(...sourceBinding.blockers)
  const budgetBlockers = [
    ...(bytes.length > DEFAULT_MAX_PACK_BYTES ? ['packed_bytes_over_limit'] : []),
    ...(unpackedBytes > DEFAULT_MAX_UNPACKED_BYTES ? ['unpacked_bytes_over_limit'] : []),
    ...(files.length > 2100 ? ['file_count_over_limit'] : [])
  ]
  blockers.push(...budgetBlockers.map((blocker) => `package_budget:${blocker}`))
  return {
    schema: RELEASE_PACK_RECEIPT_SCHEMA,
    ok: blockers.length === 0,
    kind: input.kind,
    package_name: String(packageJson?.name || ''),
    package_version: String(packageJson?.version || ''),
    source_commit: input.sourceCommit || null,
    source_tree_sha256: sourceBinding?.source_tree_sha256 || null,
    source_package_sha256: sourceBinding?.source_package_sha256 || null,
    source_package_binding_sha256: sourceBinding?.source_package_binding_sha256 || null,
    tarball_name: path.basename(tarball),
    tarball_path: input.root ? normalizePath(path.relative(input.root, tarball)) : normalizePath(tarball),
    bytes: bytes.length,
    unpacked_bytes: unpackedBytes,
    sha256,
    sha512_integrity: sha512Base64 ? `sha512-${sha512Base64}` : '',
    file_count: files.length,
    file_list_sha256: hash(Buffer.from(files.join('\n')), 'sha256', 'hex'),
    secret_scan: secretScan,
    retired_surface_scan: retiredSurfaceScan,
    budget: {
      ok: budgetBlockers.length === 0,
      max_packed_bytes: DEFAULT_MAX_PACK_BYTES,
      max_unpacked_bytes: DEFAULT_MAX_UNPACKED_BYTES,
      max_file_count: 2100,
      blockers: budgetBlockers
    },
    npm_pack_proof: input.npmPackProof || null,
    generated_at: new Date().toISOString(),
    blockers: unique(blockers)
  }
}

export function compareReleasePacks(local: ReleasePackReceipt, staged: ReleasePackReceipt): ReleasePackCompare {
  const blockers: string[] = []
  const localValidation = validateReleasePackReceipt(local, 'local', { requireNpmPackProof: true })
  const stagedValidation = validateReleasePackReceipt(staged, 'staged')
  if (!localValidation.ok) blockers.push('local_receipt_invalid', ...localValidation.blockers.map((blocker) => `local_receipt:${blocker}`))
  if (!stagedValidation.ok) blockers.push('staged_receipt_invalid', ...stagedValidation.blockers.map((blocker) => `staged_receipt:${blocker}`))
  if (local?.package_name !== staged?.package_name) blockers.push('package_name_mismatch')
  if (local?.package_version !== staged?.package_version) blockers.push('package_version_mismatch')
  if (local?.bytes !== staged?.bytes) blockers.push('tarball_size_mismatch')
  if (local?.unpacked_bytes !== staged?.unpacked_bytes) blockers.push('tarball_unpacked_size_mismatch')
  if (local?.sha256 !== staged?.sha256) blockers.push('tarball_sha256_mismatch')
  if (local?.sha512_integrity !== staged?.sha512_integrity) blockers.push('tarball_integrity_mismatch')
  if (local?.file_count !== staged?.file_count) blockers.push('file_count_mismatch')
  if (local?.file_list_sha256 !== staged?.file_list_sha256) blockers.push('file_list_mismatch')
  return {
    schema: RELEASE_PACK_COMPARE_SCHEMA,
    ok: blockers.length === 0,
    package_name: local?.package_name || staged?.package_name || null,
    package_version: local?.package_version || staged?.package_version || null,
    local_sha256: local?.sha256 || null,
    staged_sha256: staged?.sha256 || null,
    blockers: unique(blockers),
    compared_at: new Date().toISOString()
  }
}

export function validateReleasePackReceipt(value: unknown, expectedKind?: ReleasePackKind, options: { requireNpmPackProof?: boolean } = {}) {
  const receipt = value as Partial<ReleasePackReceipt> | null
  const blockers: string[] = []
  if ((receipt as { schema?: unknown } | null)?.schema === 'sks.release-pack-receipt.v1') {
    blockers.push('receipt_schema_v1_outdated_regenerate_with_npm_run_release:pack-receipt')
  } else if (!receipt || receipt.schema !== RELEASE_PACK_RECEIPT_SCHEMA) blockers.push('schema_invalid')
  if (receipt?.ok !== true) blockers.push('not_ok')
  if (receipt?.kind !== 'local' && receipt?.kind !== 'staged') blockers.push('kind_invalid')
  if (expectedKind && receipt?.kind !== expectedKind) blockers.push(`kind_not_${expectedKind}`)
  if (!receipt?.package_name) blockers.push('package_name_missing')
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(String(receipt?.package_version || ''))) blockers.push('package_version_invalid')
  if (!receipt?.tarball_name || !String(receipt.tarball_name).endsWith('.tgz')) blockers.push('tarball_name_invalid')
  if (!receipt?.tarball_path || !String(receipt.tarball_path).endsWith('.tgz')) blockers.push('tarball_path_invalid')
  if (!Number.isSafeInteger(receipt?.bytes) || Number(receipt?.bytes) <= 0) blockers.push('bytes_invalid')
  if (!Number.isSafeInteger(receipt?.unpacked_bytes) || Number(receipt?.unpacked_bytes) <= 0) blockers.push('unpacked_bytes_invalid')
  if (!/^[a-f0-9]{64}$/i.test(String(receipt?.sha256 || ''))) blockers.push('sha256_invalid')
  if (!/^sha512-[A-Za-z0-9+/]+={0,2}$/.test(String(receipt?.sha512_integrity || ''))) blockers.push('sha512_integrity_invalid')
  if (!Number.isSafeInteger(receipt?.file_count) || Number(receipt?.file_count) <= 0) blockers.push('file_count_invalid')
  if (!/^[a-f0-9]{64}$/i.test(String(receipt?.file_list_sha256 || ''))) blockers.push('file_list_sha256_invalid')
  if (receipt?.secret_scan?.ok !== true
    || !Number.isSafeInteger(receipt?.secret_scan?.scanned_files)
    || Number(receipt?.secret_scan?.scanned_files) <= 0
    || !Number.isSafeInteger(receipt?.secret_scan?.scanned_bytes)
    || Number(receipt?.secret_scan?.scanned_bytes) <= 0
    || !Array.isArray(receipt?.secret_scan?.findings)
    || receipt.secret_scan.findings.length > 0
    || !Array.isArray(receipt?.secret_scan?.blockers)
    || receipt.secret_scan.blockers.length > 0) {
    blockers.push('secret_scan_invalid_or_failed')
  }
  if (receipt?.retired_surface_scan?.ok !== true
    || !Number.isSafeInteger(receipt?.retired_surface_scan?.scanned_files)
    || Number(receipt?.retired_surface_scan?.scanned_files) <= 0
    || !Number.isSafeInteger(receipt?.retired_surface_scan?.scanned_bytes)
    || Number(receipt?.retired_surface_scan?.scanned_bytes) <= 0
    || !Number.isSafeInteger(receipt?.retired_surface_scan?.allowlisted_finding_count)
    || Number(receipt?.retired_surface_scan?.allowlisted_finding_count) < 0
    || !Array.isArray(receipt?.retired_surface_scan?.findings)
    || receipt.retired_surface_scan.findings.length > 0
    || !Array.isArray(receipt?.retired_surface_scan?.blockers)
    || receipt.retired_surface_scan.blockers.length > 0) {
    blockers.push('retired_surface_scan_invalid_or_failed')
  }
  if (!receipt?.generated_at || Number.isNaN(Date.parse(String(receipt.generated_at)))) blockers.push('generated_at_invalid')
  if (!Array.isArray(receipt?.blockers) || receipt.blockers.length > 0) blockers.push('receipt_blockers_present')
  const computedBudgetBlockers = [
    ...(Number(receipt?.bytes || 0) > DEFAULT_MAX_PACK_BYTES ? ['packed_bytes_over_limit'] : []),
    ...(Number(receipt?.unpacked_bytes || 0) > DEFAULT_MAX_UNPACKED_BYTES ? ['unpacked_bytes_over_limit'] : []),
    ...(Number(receipt?.file_count || 0) > 2100 ? ['file_count_over_limit'] : [])
  ]
  if (receipt?.budget?.max_packed_bytes !== DEFAULT_MAX_PACK_BYTES
    || receipt?.budget?.max_unpacked_bytes !== DEFAULT_MAX_UNPACKED_BYTES
    || receipt?.budget?.max_file_count !== 2100
    || receipt?.budget?.ok !== (computedBudgetBlockers.length === 0)
    || !Array.isArray(receipt?.budget?.blockers)
    || JSON.stringify([...receipt.budget.blockers].sort()) !== JSON.stringify([...computedBudgetBlockers].sort())) {
    blockers.push('package_budget_invalid_or_failed')
  }
  if (options.requireNpmPackProof) {
    if (!/^[a-f0-9]{64}$/i.test(String(receipt?.npm_pack_proof?.proof_id || ''))) blockers.push('npm_pack_proof_id_invalid')
    if (!/^[a-f0-9]{64}$/i.test(String(receipt?.npm_pack_proof?.info_sha256 || ''))) blockers.push('npm_pack_info_sha256_invalid')
    if (!/^[a-f0-9]{64}$/i.test(String(receipt?.npm_pack_proof?.file_list_sha256 || ''))) blockers.push('npm_pack_file_list_sha256_invalid')
  }
  if (receipt?.kind === 'local') {
    if (!/^[a-f0-9]{40}$/i.test(String(receipt?.source_commit || ''))) blockers.push('source_commit_invalid')
    if (!/^[a-f0-9]{64}$/i.test(String(receipt?.source_tree_sha256 || ''))) blockers.push('source_tree_sha256_invalid')
    if (!/^[a-f0-9]{64}$/i.test(String(receipt?.source_package_sha256 || ''))) blockers.push('source_package_sha256_invalid')
    if (!/^[a-f0-9]{64}$/i.test(String(receipt?.source_package_binding_sha256 || ''))) blockers.push('source_package_binding_sha256_invalid')
    const expectedBinding = sourcePackageBindingSha256(
      String(receipt?.source_commit || ''),
      String(receipt?.source_tree_sha256 || ''),
      String(receipt?.source_package_sha256 || ''),
      String(receipt?.sha256 || '')
    )
    if (receipt?.source_package_binding_sha256 !== expectedBinding) blockers.push('source_package_binding_sha256_mismatch')
  }
  return { ok: blockers.length === 0, receipt: receipt || null, blockers: unique(blockers) }
}

export function validateLocalReleasePackBinding(root: string, value: unknown) {
  const validation = validateReleasePackReceipt(value, 'local', { requireNpmPackProof: true })
  const receipt = validation.receipt
  const blockers = [...validation.blockers]
  const gate = readCurrentNpmPackGateArtifacts(root)
  if (!gate.ok || !gate.proof) blockers.push(...gate.blockers.map((blocker) => `npm_pack_gate:${blocker}`))
  else {
    const info = gate.proof.info || {}
    if (receipt?.npm_pack_proof?.proof_id !== gate.proof.proof_id) blockers.push('npm_pack_proof_id_mismatch')
    if (receipt?.npm_pack_proof?.info_sha256 !== gate.proof.info_digest) blockers.push('npm_pack_info_sha256_mismatch')
    if (receipt?.npm_pack_proof?.file_list_sha256 !== gate.proof.file_list_digest) blockers.push('npm_pack_file_list_sha256_mismatch')
    if (receipt?.package_name !== gate.proof.package_name || receipt?.package_version !== gate.proof.package_version) blockers.push('npm_pack_package_identity_mismatch')
    if (receipt?.tarball_name !== info.filename) blockers.push('npm_pack_tarball_name_mismatch')
    if (receipt?.bytes !== info.size) blockers.push('npm_pack_size_mismatch')
    if (receipt?.unpacked_bytes !== info.unpackedSize) blockers.push('npm_pack_unpacked_size_mismatch')
    if (receipt?.file_count !== info.entryCount) blockers.push('npm_pack_file_count_mismatch')
    if (receipt?.sha512_integrity !== info.integrity) blockers.push('npm_pack_integrity_mismatch')
  }
  const sourceState = inspectLocalReleaseSourceState(root)
  if (!sourceState.head || receipt?.source_commit !== sourceState.head) blockers.push('npm_pack_source_commit_mismatch')
  if (!sourceState.source_tree_sha256 || receipt?.source_tree_sha256 !== sourceState.source_tree_sha256) blockers.push('npm_pack_source_tree_sha256_mismatch')
  blockers.push(...sourceState.blockers)
  const tarball = receipt?.tarball_path ? path.resolve(root, receipt.tarball_path) : ''
  const managedRoot = path.resolve(root, '.sneakoscope', 'reports', 'release', String(receipt?.package_version || ''), 'artifacts')
  const relative = tarball ? path.relative(managedRoot, tarball) : '..'
  if (!tarball || relative.startsWith('..') || path.isAbsolute(relative) || !fs.existsSync(tarball)) blockers.push('local_tarball_artifact_missing_or_unsafe')
  else {
    const actual = inspectReleaseTarball({ tarball, kind: 'local', sourceCommit: receipt?.source_commit || null, root })
    for (const key of ['package_name', 'package_version', 'source_tree_sha256', 'source_package_sha256', 'source_package_binding_sha256', 'tarball_name', 'tarball_path', 'bytes', 'unpacked_bytes', 'sha256', 'sha512_integrity', 'file_count', 'file_list_sha256'] as const) {
      if (actual[key] !== receipt?.[key]) blockers.push(`local_tarball_artifact_mismatch:${key}`)
    }
    if (JSON.stringify(actual.secret_scan) !== JSON.stringify(receipt?.secret_scan)) blockers.push('local_tarball_artifact_mismatch:secret_scan')
    if (JSON.stringify(actual.retired_surface_scan) !== JSON.stringify(receipt?.retired_surface_scan)) blockers.push('local_tarball_artifact_mismatch:retired_surface_scan')
    if (!actual.ok) blockers.push(...actual.blockers.map((blocker) => `local_tarball_artifact:${blocker}`))
  }
  return { ok: blockers.length === 0, receipt, gate, sourceState, blockers: unique(blockers) }
}

export function inspectLocalReleaseSourceState(root: string): {
  ok: boolean
  head: string
  source_tree_sha256: string
  tracked_changes: boolean
  pack_eligible_untracked: string[]
  blockers: string[]
} {
  const blockers: string[] = []
  const head = gitHead(root)
  if (!head) blockers.push('npm_pack_source_commit_unavailable')
  const sourceTreeSha256 = head ? gitTreeSha256(root, head) : ''
  if (!sourceTreeSha256) blockers.push('npm_pack_source_tree_digest_unavailable')

  const trackedStatus = spawnSync('git', ['status', '--porcelain=v1', '--untracked-files=no'], { cwd: root, encoding: 'utf8' })
  const trackedChanges = trackedStatus.status === 0 && Boolean(String(trackedStatus.stdout || '').trim())
  if (trackedStatus.status !== 0) blockers.push('npm_pack_tracked_status_unavailable')
  else if (trackedChanges) blockers.push('npm_pack_tracked_changes_present')

  // Generated dist is intentionally ignored by Git. Every other untracked
  // worktree entry is rejected because an untracked source/config file can
  // influence the clean build even when npm does not pack that file directly.
  const fullStatus = spawnSync('git', ['status', '--porcelain=v1', '--untracked-files=all'], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024
  })
  if (fullStatus.status !== 0) blockers.push('npm_pack_untracked_status_unavailable')
  else if (String(fullStatus.stdout || '').split(/\r?\n/).some((line) => line.startsWith('?? '))) {
    blockers.push('npm_pack_untracked_files_present')
  }

  const trackedFilesResult = spawnSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 })
  const trackedFiles = trackedFilesResult.status === 0
    ? new Set(String(trackedFilesResult.stdout || '').split('\0').filter(Boolean).map(normalizePath))
    : null
  if (!trackedFiles) blockers.push('npm_pack_tracked_file_inventory_unavailable')

  const dryRun = spawnSync('npm', ['pack', '--dry-run', '--ignore-scripts', '--json'], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    env: { ...process.env, npm_config_cache: process.env.SKS_RELEASE_NPM_CACHE || path.join(os.tmpdir(), 'sneakoscope-npm-cache') }
  })
  let packedFiles: string[] | null = null
  if (dryRun.status === 0) {
    try {
      const parsed = JSON.parse(String(dryRun.stdout || '[]'))
      const info = Array.isArray(parsed) ? parsed[0] : parsed
      packedFiles = Array.isArray(info?.files)
        ? info.files.map((file: any) => normalizePath(String(file?.path || ''))).filter(Boolean)
        : null
    } catch {
      packedFiles = null
    }
  }
  if (!packedFiles) blockers.push('npm_pack_dry_run_file_inventory_unavailable')
  const packEligibleUntracked = trackedFiles && packedFiles
    ? unique(packedFiles.filter((relative) =>
      !trackedFiles.has(relative) && !isGeneratedDistPackagePath(relative)
    )).sort()
    : []
  if (packEligibleUntracked.length > 0) blockers.push('npm_pack_eligible_untracked_files_present')
  return {
    ok: blockers.length === 0,
    head,
    source_tree_sha256: sourceTreeSha256,
    tracked_changes: trackedChanges,
    pack_eligible_untracked: packEligibleUntracked,
    blockers: unique(blockers)
  }
}

export function writeReleaseJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
}

function scanTarballContents(tarball: string): ReleasePackReceipt['secret_scan'] {
  return scanTarballTextContents({
    tarball,
    temp_prefix: 'sks-release-pack-secret-scan-',
    extract_failed_blocker: 'tarball_secret_scan_extract_failed',
    file_too_large_prefix: 'secret_scan_file_too_large',
    finding_limit_blocker: 'secret_scan_finding_limit_reached',
    empty_blocker: 'secret_scan_empty',
    max_findings: 100,
    patterns: SECRET_PATTERNS,
    finding_blocker: (finding) => `secret_content_detected:${finding.kind}:${finding.file}:${finding.fingerprint}`
  })
}

function scanRetiredSurfaceContents(tarball: string): ReleasePackReceipt['retired_surface_scan'] {
  return scanTarballTextContents({
    tarball,
    temp_prefix: 'sks-release-pack-retired-surface-scan-',
    extract_failed_blocker: 'tarball_retired_surface_scan_extract_failed',
    file_too_large_prefix: 'retired_surface_scan_file_too_large',
    finding_limit_blocker: 'retired_surface_scan_finding_limit_reached',
    empty_blocker: 'retired_surface_scan_empty',
    max_findings: 200,
    patterns: RETIRED_SURFACE_PATTERNS,
    finding_blocker: (finding) => `retired_surface_content_detected:${finding.kind}:${finding.file}:${finding.fingerprint}`,
    allow_finding: retiredSurfaceFindingAllowed,
    include_allowlisted_count: true
  })
}

const SECRET_PATTERNS: ReleasePackContentPattern[] = [
  { kind: 'github_token', regex: /\bgh[pousr]_[A-Za-z0-9]{30,}\b/g },
  { kind: 'npm_token', regex: /\bnpm_[A-Za-z0-9]{30,}\b/g },
  { kind: 'slack_token', regex: /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/g },
  { kind: 'openai_token', regex: /\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{20,}\b/g },
  { kind: 'supabase_secret_key', regex: /\bsb_secret_[A-Za-z0-9_-]{20,}\b/g },
  { kind: 'google_api_key', regex: /\bAIza[0-9A-Za-z_-]{30,}\b/g },
  { kind: 'aws_access_key', regex: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g },
  { kind: 'jwt', regex: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g },
  { kind: 'private_key', regex: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g },
  { kind: 'npm_auth_token', regex: /(?:^|\n)\s*(?:\/\/[^\s:]+\/?:)?_authToken\s*=\s*[^\s${][^\r\n]{15,}/g }
]

const RETIRED_MULTIPLEXER_TOKEN = ['zel', 'lij'].join('')

const RETIRED_SURFACE_PATTERNS: ReleasePackContentPattern[] = [
  { kind: 'retired_dollar_command', regex: /\$(?:Agent|Team|MAD-DB|Swarm|ShadowClone|Kagebunshin)\b/gi },
  { kind: 'retired_cli_command', regex: /\bsks\s+team(?=$|[\s"'`])/gi },
  { kind: 'retired_cli_command', regex: /\bsks\s+(?:mad-db|tmux|xai|swarm|agent)(?=$|[\s"'`])/g },
  { kind: 'retired_ui_command', regex: /\bsks\s+ui(?=$|[\s"'`])/gi },
  { kind: 'retired_terminal_multiplexer', regex: new RegExp(RETIRED_MULTIPLEXER_TOKEN, 'gi') },
  { kind: 'retired_dashboard_surface', regex: /\b(?:Open Dashboard|SKS Dashboard|dashboard-plus-slots|agent-codex-dashboard)\b/gi },
  { kind: 'retired_team_workdir', regex: /\bteam-inbox\b/gi },
  { kind: 'retired_team_current_wording', regex: /\bTeam\s+(?:workflow|architecture)\b/gi },
  { kind: 'retired_agent_option', regex: /(^|[\s"'`])--agent(?=$|[=\s"'`])/gim },
  { kind: 'retired_naruto_option', regex: /(^|[\s"'`])--naruto(?=$|[=\s"'`])/gim },
  { kind: 'retired_clones_option', regex: /(^|[\s"'`])--clones(?=$|[=\s"'`])/gim },
  { kind: 'retired_naruto_workers_command', regex: /(^|[^A-Za-z0-9_-])naruto\s+workers(?=$|[^A-Za-z0-9_-])/gim },
  { kind: 'retired_menubar_mcp_command', regex: /\bsks\s+menubar\s+mcp(?=$|[\s"'`])/gi },
  { kind: 'retired_menubar_mcp_identity', regex: /(^|[^A-Za-z0-9])menubar[-_. ]mcp(?=$|[^A-Za-z0-9])/gim },
  { kind: 'retired_ralph_identity', regex: /\bralph(?:[_-](?:removed|supervisor|resolver))?\b/gi },
  { kind: 'retired_team_runtime_identity', regex: /\b(?:team_live|team_trigger_matrix|full_team_recommended|full_team_honest_path|strict-team|team-alias-to-naruto)\b/gi },
  { kind: 'retired_team_profile', regex: /\bsks-team(?:\.config\.toml)?\b/gi },
  { kind: 'retired_team_lane_label', regex: /\b(?:Balanced Team Lane|Full Team Honest Path|full Team\/Honest proof path)\b/gi }
]

const RETIRED_PACKAGED_FILE_PATTERNS = [
  /^package\/dist\/core\/commands\/ui-command\.js$/,
  /^package\/dist\/core\/ui\/dashboard-html\.js$/,
  new RegExp(`^package/.*${RETIRED_MULTIPLEXER_TOKEN}`, 'i')
]

const RETIRED_SURFACE_ALLOWLIST: Array<{ path: RegExp; kinds: Set<string> }> = [
  { path: /^dist\/core\/doctor\/retired-auto-review-config\.js$/, kinds: new Set(['retired_cli_command', 'retired_dollar_command', 'retired_ralph_identity', 'retired_team_profile']) },
  { path: /^dist\/core\/doctor\/(?:command-alias-cleanup|current-project-guidance)\.js$/, kinds: new Set(['retired_ralph_identity']) },
  { path: /^dist\/core\/doctor\/skill-legacy-surface\.js$/, kinds: new Set(RETIRED_SURFACE_PATTERNS.map((pattern) => pattern.kind)) },
  { path: /^dist\/core\/doctor\/retired-managed-projection-residue\.js$/, kinds: new Set(['retired_team_runtime_identity']) },
  { path: /^dist\/core\/doctor\/retired-managed-residue(?:-artifact-helpers|-artifacts|-missions|-private|-runtime|-state)?\.js$/, kinds: new Set(['retired_cli_command', 'retired_dollar_command', 'retired_ralph_identity', 'retired_team_current_wording', 'retired_team_profile', 'retired_team_runtime_identity', 'retired_team_workdir']) },
  { path: /^dist\/core\/init\/(?:skills\.js|skills\/inventory\.js)$/, kinds: new Set(['retired_ralph_identity']) },
  { path: /^dist\/core\/install\/installed-package-smoke\.js$/, kinds: new Set(['retired_agent_option', 'retired_clones_option', 'retired_dollar_command', 'retired_menubar_mcp_identity', 'retired_naruto_option', 'retired_naruto_workers_command', 'retired_ralph_identity']) },
  { path: /^dist\/core\/ops\/upgrade-migration-fixtures\.js$/, kinds: new Set(['retired_dollar_command']) },
  { path: /^dist\/core\/release\/release-pack-receipt\.js$/, kinds: new Set(RETIRED_SURFACE_PATTERNS.map((pattern) => pattern.kind)) },
  { path: /^dist\/core\/update\/update-migration-state\.js$/, kinds: new Set(['retired_cli_command', 'retired_dollar_command', 'retired_team_profile', 'retired_team_runtime_identity']) },
  { path: /^dist\/scripts\/docs-truthfulness-check\.js$/, kinds: new Set(['retired_ralph_identity']) },
  { path: /^dist\/scripts\/naruto-ssot-(?:routing|route-normalization|gate-aliases|pipeline-default)-check\.js$/, kinds: new Set(['retired_cli_command', 'retired_dollar_command', 'retired_team_runtime_identity']) },
  { path: /^dist\/scripts\/upgrade-migration-matrix-check\.js$/, kinds: new Set(['retired_team_workdir']) },
  // `release-metadata-check` inherited the retired-surface literals when the
  // 1-19 implementation was inlined into it; they are the detection patterns
  // themselves, which is why this group is exempt from every kind.
  { path: /^dist\/scripts\/(?:current-command-surface-check|current-surface-update-e2e-check|current-upgrade-matrix-check|release-metadata-check|runtime-current-terminal-check)\.js$/, kinds: new Set(RETIRED_SURFACE_PATTERNS.map((pattern) => pattern.kind)) }
]

function retiredSurfaceFindingAllowed(finding: { file: string; kind: string }): boolean {
  return RETIRED_SURFACE_ALLOWLIST.some((rule) => rule.path.test(finding.file) && rule.kinds.has(finding.kind))
}

function hash(value: crypto.BinaryLike, algorithm: 'sha256' | 'sha512', encoding: 'hex' | 'base64'): string {
  return crypto.createHash(algorithm).update(value).digest(encoding)
}

function inspectSourcePackageBinding(root: string, sourceCommit: string, tarball: string, files: string[], tarballSha256: string): {
  source_tree_sha256: string
  source_package_sha256: string
  source_package_binding_sha256: string
  blockers: string[]
} {
  const blockers: string[] = []
  const sourceTreeSha256 = gitTreeSha256(root, sourceCommit)
  if (!sourceTreeSha256) blockers.push('source_tree_digest_unavailable')
  const temp = tmpdir('release-source-package-binding-')
  const sourceRoot = path.join(temp, 'source')
  const packageRoot = path.join(temp, 'packed')
  const archive = path.join(temp, 'source.tar')
  const packageHash = crypto.createHash('sha256')
  try {
    fs.mkdirSync(sourceRoot)
    fs.mkdirSync(packageRoot)
    const archived = spawnSync('git', ['archive', '--format=tar', `--output=${archive}`, sourceCommit], {
      cwd: root,
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024
    })
    if (archived.status !== 0) blockers.push('source_commit_archive_unavailable')
    const extractedSource = archived.status === 0
      ? spawnSync('tar', ['-xf', archive, '-C', sourceRoot], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 })
      : null
    if (!extractedSource || extractedSource.status !== 0) blockers.push('source_commit_extract_unavailable')
    const extractedPackage = spawnSync('tar', ['-xzf', tarball, '-C', packageRoot], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 })
    if (extractedPackage.status !== 0) blockers.push('tarball_source_binding_extract_unavailable')

    if (extractedSource?.status === 0 && extractedPackage.status === 0) {
      for (const entry of [...files].sort()) {
        const relative = normalizePath(entry).replace(/^package\//, '')
        const packedFile = path.join(packageRoot, 'package', relative)
        const sourceFile = path.join(sourceRoot, relative)
        if (!fs.existsSync(packedFile) || !fs.statSync(packedFile).isFile()) {
          blockers.push(`packed_file_unavailable_for_source_binding:${relative}`)
          continue
        }
        const packedBytes = fs.readFileSync(packedFile)
        const packedSha256 = hash(packedBytes, 'sha256', 'hex')
        packageHash.update(relative)
        packageHash.update('\0')
        packageHash.update(String(packedBytes.length))
        packageHash.update('\0')
        packageHash.update(packedSha256)
        packageHash.update('\0')
        if (!fs.existsSync(sourceFile) || !fs.statSync(sourceFile).isFile()) {
          if (isGeneratedDistPackagePath(relative)) {
            // dist/** is intentionally ignored by Git, so bind each packed
            // generated byte to the current clean build instead of pretending
            // it exists in the source commit. The release stamp independently
            // binds that build to the same clean source snapshot.
            const builtFile = path.join(root, relative)
            let builtStat: fs.Stats | null = null
            try {
              builtStat = fs.lstatSync(builtFile)
            } catch {
              builtStat = null
            }
            if (!builtStat?.isFile() || builtStat.isSymbolicLink()) {
              blockers.push(`packed_generated_dist_missing_from_current_build:${relative}`)
            } else if (!fs.readFileSync(builtFile).equals(packedBytes)) {
              blockers.push(`packed_generated_dist_differs_from_current_build:${relative}`)
            }
          } else {
            blockers.push(`packed_file_missing_from_source_commit:${relative}`)
          }
          continue
        }
        const sourceBytes = fs.readFileSync(sourceFile)
        if (!sourceBytes.equals(packedBytes)) blockers.push(`packed_file_differs_from_source_commit:${relative}`)
      }
    }
  } finally {
    fs.rmSync(temp, { recursive: true, force: true })
  }
  const sourcePackageSha256 = packageHash.digest('hex')
  return {
    source_tree_sha256: sourceTreeSha256,
    source_package_sha256: sourcePackageSha256,
    source_package_binding_sha256: sourcePackageBindingSha256(sourceCommit, sourceTreeSha256, sourcePackageSha256, tarballSha256),
    blockers: unique(blockers)
  }
}

function sourcePackageBindingSha256(sourceCommit: string, sourceTreeSha256: string, sourcePackageSha256: string, tarballSha256: string): string {
  return hash(Buffer.from([
    RELEASE_PACK_RECEIPT_SCHEMA,
    sourceCommit,
    sourceTreeSha256,
    sourcePackageSha256,
    tarballSha256
  ].join('\n')), 'sha256', 'hex')
}

function isGeneratedDistPackagePath(relative: string): boolean {
  const normalized = normalizePath(relative)
  return normalized.startsWith('dist/') && !normalized.includes('/../')
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))]
}

function gitHead(root: string): string {
  const result = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' })
  return result.status === 0 ? String(result.stdout || '').trim() : ''
}

function gitTreeSha256(root: string, commit: string): string {
  if (!/^[a-f0-9]{40}$/i.test(commit)) return ''
  const verified = spawnSync('git', ['rev-parse', '--verify', `${commit}^{commit}`], { cwd: root, encoding: 'utf8' })
  if (verified.status !== 0 || String(verified.stdout || '').trim().toLowerCase() !== commit.toLowerCase()) return ''
  const tree = spawnSync('git', ['ls-tree', '-r', '-z', '--full-tree', commit], { cwd: root, maxBuffer: 32 * 1024 * 1024 })
  if (tree.status !== 0 || !Buffer.isBuffer(tree.stdout)) return ''
  return hash(tree.stdout, 'sha256', 'hex')
}

function normalizePath(value: string): string {
  return value.split(path.sep).join('/')
}
