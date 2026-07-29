import path from 'node:path'
import {
  inspectReleaseTarball,
  validateLocalReleasePackBinding,
  validateReleasePackReceipt,
  type ReleasePackReceipt
} from '../core/release/release-pack-receipt.js'
import { runLifecycleCommand } from './release-upgrade-smoke-command.js'
import {
  RELEASE_UPGRADE_BASELINE_SHA256,
  RELEASE_UPGRADE_BASELINE_VERSION,
  type PreparedBaseline,
  type PreparedTarget,
  type ReleaseUpgradeCommandReceipt,
  type ReleaseUpgradeCommandRunner,
  type ReleaseUpgradeIsolation,
  type ReleaseUpgradeLifecycleInput,
  type ReleaseUpgradeSmokeOptions
} from './release-upgrade-smoke-contract.js'
import {
  hashBytes,
  isSubpath,
  normalizeSha256,
  parseJson,
  readRegularFile,
  unique
} from './release-upgrade-smoke-utils.js'

export function prepareReleaseUpgradeTarget(
  root: string,
  targetVersion: string,
  options: ReleaseUpgradeSmokeOptions
): { value: PreparedTarget | null; blockers: string[] } {
  if (!options.targetReceipt || !options.targetTarball) {
    return { value: null, blockers: ['target_binding_inputs_missing'] }
  }
  const receiptPath = path.resolve(root, options.targetReceipt)
  const tarball = path.resolve(root, options.targetTarball)
  const blockers: string[] = []
  const receiptFile = readRegularFile(receiptPath, 'target_receipt')
  blockers.push(...receiptFile.blockers)
  const parsedReceipt = receiptFile.bytes ? parseJson(receiptFile.bytes.toString('utf8')) : null
  const receipt = parsedReceipt && typeof parsedReceipt === 'object' && !Array.isArray(parsedReceipt)
    ? parsedReceipt as ReleasePackReceipt
    : null
  if (receiptFile.bytes && !receipt) blockers.push('target_receipt_json_invalid')
  const receiptSha256 = receiptFile.bytes ? hashBytes(receiptFile.bytes) : ''
  const validation = validateReleasePackReceipt(receipt, 'local', { requireNpmPackProof: true })
  blockers.push(...validation.blockers.map((blocker) => `target_receipt:${blocker}`))
  if (receipt?.package_name !== 'sneakoscope') blockers.push('target_receipt_package_name_mismatch')
  if (receipt?.package_version !== targetVersion) blockers.push('target_receipt_version_mismatch')
  if (receipt) {
    if (path.resolve(root, String(receipt.tarball_path || '')) !== tarball) blockers.push('target_receipt_tarball_path_mismatch')
    if (receipt.tarball_name !== path.basename(tarball)) blockers.push('target_receipt_tarball_name_mismatch')
  }
  const regular = readRegularFile(tarball, 'target_tarball')
  blockers.push(...regular.blockers)
  const sha256 = regular.bytes ? hashBytes(regular.bytes) : ''
  if (receipt?.sha256 !== sha256) blockers.push('target_tarball_sha256_mismatch')
  if (regular.bytes && receipt) {
    const actual = inspectReleaseTarball({ tarball, kind: 'local', sourceCommit: receipt.source_commit, root })
    if (!actual.ok) blockers.push(...actual.blockers.map((blocker) => `target_tarball:${blocker}`))
    for (const key of [
      'package_name', 'package_version', 'bytes', 'unpacked_bytes', 'sha256',
      'sha512_integrity', 'file_count', 'file_list_sha256'
    ] as const) {
      if (actual[key] !== receipt[key]) blockers.push(`target_tarball_receipt_mismatch:${key}`)
    }
  }
  if (!blockers.length && receipt) {
    const binding = validateLocalReleasePackBinding(root, receipt)
    if (!binding.ok) blockers.push(...binding.blockers.map((blocker) => `target_repository_binding:${blocker}`))
  }
  return {
    value: blockers.length || !receipt ? null : { receipt, receiptPath, receiptSha256, tarball, sha256 },
    blockers: unique(blockers)
  }
}

export function prepareProvidedReleaseUpgradeBaseline(
  root: string,
  value: string,
  expectedValue: string | undefined
): { value: PreparedBaseline | null; blockers: string[] } {
  const tarball = path.resolve(root, value)
  const blockers: string[] = []
  const expected = normalizeSha256(expectedValue)
  if (!expected) blockers.push('provided_baseline_sha256_invalid')
  if (expected && expected !== RELEASE_UPGRADE_BASELINE_SHA256) blockers.push('provided_baseline_sha256_not_pinned_baseline')
  const regular = readRegularFile(tarball, 'baseline_tarball')
  blockers.push(...regular.blockers)
  const sha256 = regular.bytes ? hashBytes(regular.bytes) : ''
  if (expected && sha256 !== expected) blockers.push('provided_baseline_sha256_mismatch')
  if (sha256 && sha256 !== RELEASE_UPGRADE_BASELINE_SHA256) blockers.push('baseline_tarball_not_pinned_baseline')
  const actual = regular.bytes ? inspectReleaseTarball({ tarball, kind: 'staged' }) : null
  const inspection = classifyPinnedReleaseUpgradeBaselineInspection(actual?.blockers || ['provided_baseline_inspection_failed'])
  blockers.push(...inspection.blockers.map((blocker) => `baseline_tarball:${blocker}`))
  if (actual?.package_name !== 'sneakoscope') blockers.push('baseline_package_name_mismatch')
  if (actual?.package_version !== RELEASE_UPGRADE_BASELINE_VERSION) blockers.push('baseline_package_version_mismatch')
  return {
    value: blockers.length || !actual ? null : {
      source: 'provided', tarball, sha256, sha512Integrity: actual.sha512_integrity,
      registryShasum: null, inspectionWarnings: inspection.warnings
    },
    blockers: unique(blockers)
  }
}

export async function fetchReleaseUpgradeBaseline(
  isolation: ReleaseUpgradeIsolation,
  npmCommand: string,
  runner: ReleaseUpgradeCommandRunner,
  commands: ReleaseUpgradeCommandReceipt[]
): Promise<{ value: PreparedBaseline | null; blockers: string[] }> {
  const input: ReleaseUpgradeLifecycleInput = {
    targetVersion: '', targetTarball: '', targetSha256: '', baselineTarball: '', baselineSha256: '', isolation,
    platform: process.platform, npmCommand
  }
  const result = await runLifecycleCommand(input, runner, commands, 'baseline_fetch', npmCommand, [
    'pack', `sneakoscope@${RELEASE_UPGRADE_BASELINE_VERSION}`, '--ignore-scripts', '--json',
    '--pack-destination', isolation.baselinePackDir
  ])
  if (result.code !== 0) return { value: null, blockers: ['baseline_fetch_failed'] }
  const parsed = parseJson(result.stdout)
  const info = (Array.isArray(parsed) ? parsed[0] : parsed) as Record<string, unknown> | null
  const filename = typeof info?.filename === 'string' ? info.filename : ''
  const tarball = path.resolve(isolation.baselinePackDir, filename)
  const blockers: string[] = []
  if (!filename || !isSubpath(tarball, isolation.baselinePackDir)) blockers.push('baseline_fetch_filename_unsafe')
  const regular = readRegularFile(tarball, 'baseline_tarball')
  blockers.push(...regular.blockers)
  const sha256 = regular.bytes ? hashBytes(regular.bytes) : ''
  if (sha256 && sha256 !== RELEASE_UPGRADE_BASELINE_SHA256) blockers.push('baseline_tarball_not_pinned_baseline')
  const actual = regular.bytes ? inspectReleaseTarball({ tarball, kind: 'staged' }) : null
  const inspection = classifyPinnedReleaseUpgradeBaselineInspection(actual?.blockers || ['baseline_fetch_inspection_failed'])
  blockers.push(...inspection.blockers.map((blocker) => `baseline_tarball:${blocker}`))
  if (actual?.package_name !== 'sneakoscope' || info?.name !== 'sneakoscope') blockers.push('baseline_fetch_package_name_mismatch')
  if (actual?.package_version !== RELEASE_UPGRADE_BASELINE_VERSION || info?.version !== RELEASE_UPGRADE_BASELINE_VERSION) blockers.push('baseline_fetch_version_mismatch')
  if (typeof info?.integrity !== 'string' || info.integrity !== actual?.sha512_integrity) blockers.push('baseline_fetch_integrity_mismatch')
  if (!/^[a-f0-9]{40}$/i.test(String(info?.shasum || ''))) blockers.push('baseline_fetch_shasum_invalid')
  return {
    value: blockers.length || !actual ? null : {
      source: 'registry', tarball, sha256, sha512Integrity: actual.sha512_integrity,
      registryShasum: String(info?.shasum || ''), inspectionWarnings: inspection.warnings
    },
    blockers: unique(blockers)
  }
}

/**
 * The published 7.6.0 tarball is immutable and verified against
 * RELEASE_UPGRADE_BASELINE_SHA256 before this classifier is used. Legacy
 * surface strings, retired packaged files, and scanner-only token fixtures are
 * expected in that exact baseline, but malformed archives and structural
 * inspection failures still block the upgrade proof.
 */
export function classifyPinnedReleaseUpgradeBaselineInspection(values: string[]): { blockers: string[]; warnings: string[] } {
  const warnings: string[] = []
  const blockers: string[] = []
  for (const value of values) {
    if (
      /^secret_content_detected:[a-z0-9_]+:.+:[a-f0-9]{16}$/.test(value)
      || /^retired_surface_content_detected:[a-z0-9_]+:.+:[a-f0-9]{16}$/.test(value)
      || /^retired_package_file_present:package\/.+/.test(value)
      || value === 'retired_surface_scan_finding_limit_reached'
    ) {
      warnings.push(`published_baseline_expected_content:${value}`)
    } else {
      blockers.push(value)
    }
  }
  return { blockers, warnings }
}
