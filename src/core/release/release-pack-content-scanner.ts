import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileIdentity, inspectionKey, memoizeReleaseInspection, toolIdentity } from './release-inspection-memo.js'

export interface ReleasePackContentPattern {
  kind: string
  regex: RegExp
}

export interface ReleasePackContentFinding {
  file: string
  kind: string
  fingerprint: string
}

export interface ReleasePackContentScanResult {
  ok: boolean
  scanned_files: number
  scanned_bytes: number
  findings: ReleasePackContentFinding[]
  blockers: string[]
}

export interface ReleasePackContentScanResultWithAllowlist extends ReleasePackContentScanResult {
  allowlisted_finding_count: number
}

interface ReleasePackContentScanOptions {
  tarball: string
  temp_prefix: string
  extract_failed_blocker: string
  file_too_large_prefix: string
  finding_limit_blocker: string
  empty_blocker: string
  max_findings: number
  patterns: ReleasePackContentPattern[]
  finding_blocker: (finding: ReleasePackContentFinding) => string
  allow_finding?: (finding: ReleasePackContentFinding) => boolean
  include_allowlisted_count?: boolean
}

export function scanTarballTextContents(
  input: ReleasePackContentScanOptions & { include_allowlisted_count: true }
): ReleasePackContentScanResultWithAllowlist
export function scanTarballTextContents(
  input: ReleasePackContentScanOptions & { include_allowlisted_count?: false }
): ReleasePackContentScanResult
export function scanTarballTextContents(
  input: ReleasePackContentScanOptions
): ReleasePackContentScanResult | ReleasePackContentScanResultWithAllowlist {
  // Pure in the archive bytes and the scan definition, so the whole definition
  // goes into the key — patterns, limits, and the source text of the decision
  // callbacks. An edited pattern or allowlist rule mints a new key and forces a
  // real scan; it can never replay an older archive's or older policy's verdict.
  const key = inspectionKey(
    input.temp_prefix,
    input.tarball,
    fileIdentity(input.tarball),
    toolIdentity('tar'),
    String(input.max_findings),
    input.include_allowlisted_count === true ? 'allowlisted' : 'plain',
    input.patterns.map((pattern) => `${pattern.kind}=${pattern.regex.source}/${pattern.regex.flags}`).join('\0'),
    String(input.allow_finding || 'no_allowlist'),
    String(input.finding_blocker)
  )
  return memoizeReleaseInspection('tarball-content-scan', key, () => computeTarballTextContents(input))
}

function computeTarballTextContents(
  input: ReleasePackContentScanOptions
): ReleasePackContentScanResult | ReleasePackContentScanResultWithAllowlist {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), input.temp_prefix))
  const findings: ReleasePackContentFinding[] = []
  const blockers: string[] = []
  let scannedFiles = 0
  let scannedBytes = 0
  let allowlistedFindingCount = 0
  try {
    const result = spawnSync('tar', ['-xzf', input.tarball, '-C', temp], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 })
    if (result.status !== 0) {
      return scanResult(input, 0, 0, 0, [], [input.extract_failed_blocker])
    }
    const packageRoot = path.join(temp, 'package')
    for (const file of walkRegularFiles(packageRoot)) {
      const relative = normalizePath(path.relative(packageRoot, file))
      const stat = fs.statSync(file)
      if (stat.size > 16 * 1024 * 1024) {
        blockers.push(`${input.file_too_large_prefix}:${relative}`)
        continue
      }
      const bytes = fs.readFileSync(file)
      scannedFiles += 1
      scannedBytes += bytes.length
      if (bytes.includes(0)) continue
      const text = bytes.toString('utf8')
      for (const pattern of input.patterns) {
        pattern.regex.lastIndex = 0
        for (let match = pattern.regex.exec(text); match; match = pattern.regex.exec(text)) {
          const value = String(match[0] || '')
          const finding = {
            file: relative,
            kind: pattern.kind,
            fingerprint: fingerprint(value)
          }
          if (input.allow_finding?.(finding)) {
            allowlistedFindingCount += 1
            continue
          }
          findings.push(finding)
          if (findings.length >= input.max_findings) {
            blockers.push(input.finding_limit_blocker)
            break
          }
        }
        if (findings.length >= input.max_findings) break
      }
      if (findings.length >= input.max_findings) break
    }
    blockers.push(...findings.map(input.finding_blocker))
    if (scannedFiles === 0 || scannedBytes === 0) blockers.push(input.empty_blocker)
    return scanResult(input, scannedFiles, scannedBytes, allowlistedFindingCount, findings, blockers)
  } finally {
    fs.rmSync(temp, { recursive: true, force: true })
  }
}

function scanResult(
  input: ReleasePackContentScanOptions,
  scannedFiles: number,
  scannedBytes: number,
  allowlistedFindingCount: number,
  findings: ReleasePackContentFinding[],
  blockers: string[]
): ReleasePackContentScanResult | ReleasePackContentScanResultWithAllowlist {
  const result: ReleasePackContentScanResult = {
    ok: blockers.length === 0,
    scanned_files: scannedFiles,
    scanned_bytes: scannedBytes,
    findings,
    blockers: unique(blockers)
  }
  return input.include_allowlisted_count
    ? { ...result, allowlisted_finding_count: allowlistedFindingCount }
    : result
}

function walkRegularFiles(directory: string): string[] {
  if (!fs.existsSync(directory)) return []
  const files: string[] = []
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name)
    if (entry.isDirectory()) files.push(...walkRegularFiles(file))
    else if (entry.isFile()) files.push(file)
  }
  return files
}

function fingerprint(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex').slice(0, 16)
}

function normalizePath(value: string): string {
  return value.split(path.sep).join('/')
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))]
}
