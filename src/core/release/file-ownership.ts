import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

export const RELEASE_FILE_OWNERSHIP_REPORT_SCHEMA = 'sks.release-file-ownership-report.v1'

export interface ReleaseFileOwnershipManifest {
  schema: 'sks.release-file-ownership.v1'
  baseline: string
  /** Release line this manifest governs, e.g. '7.1.3'. Scopes the shared-file-request directory. */
  release?: string
  workstreams: Record<string, string[]>
  shared_files?: string[]
  overlap_policy: 'fail_closed'
}

/**
 * Shared-file requests live under the directory for the release line being cut, so a worker can
 * legitimately touch `.sneakoscope/release/<release>/shared-file-requests/<workstream>*.json`
 * without that counting as an out-of-scope change.
 */
export function sharedFileRequestDir(release: string): string {
  return `.sneakoscope/release/${release}/shared-file-requests`
}

export interface ReleaseFileOwnershipReport {
  schema: typeof RELEASE_FILE_OWNERSHIP_REPORT_SCHEMA
  ok: boolean
  base: string
  head: string
  release: string | null
  workstream: string | null
  changed_files: string[]
  allowed_patterns: string[]
  shared_file_changes: string[]
  out_of_scope_changes: string[]
  ambiguous_owner_changes: Array<{ file: string; owners: string[] }>
  blockers: string[]
  checked_at: string
}

export function readReleaseFileOwnershipManifest(file: string): ReleaseFileOwnershipManifest {
  const value = JSON.parse(fs.readFileSync(file, 'utf8')) as ReleaseFileOwnershipManifest
  if (value?.schema !== 'sks.release-file-ownership.v1') throw new Error('release file ownership manifest schema is invalid')
  if (!value.baseline || !value.workstreams || typeof value.workstreams !== 'object') {
    throw new Error('release file ownership manifest is incomplete')
  }
  if (value.overlap_policy !== 'fail_closed') throw new Error('release file ownership manifest must use fail_closed overlap policy')
  return value
}

export function inspectReleaseFileOwnership(input: {
  root: string
  manifest: ReleaseFileOwnershipManifest
  base: string
  head: string
  /** Release line being cut. Falls back to the manifest's own `release`; fails closed when neither is set. */
  release?: string
  workstream?: string
}): ReleaseFileOwnershipReport {
  const release = (input.release || input.manifest.release || '').trim()
  const canonicalBase = gitCommit(input.root, input.base)
  const canonicalHead = gitCommit(input.root, input.head)
  const changedFiles = canonicalBase && canonicalHead ? gitChangedFiles(input.root, canonicalBase, canonicalHead) : []
  const workstream = input.workstream || inferWorkstream(input.manifest, changedFiles, release)
  const allowedPatterns = workstream ? input.manifest.workstreams[workstream] || [] : []
  const sharedPatterns = input.manifest.shared_files || []
  const sharedFileChanges = changedFiles.filter((file) => matchesAny(file, sharedPatterns))
  const outOfScopeChanges = changedFiles.filter((file) => {
    if (release && workstream && isWorkstreamRequest(file, workstream, release)) return false
    return !matchesAny(file, allowedPatterns)
  })
  const ambiguousOwnerChanges = changedFiles.flatMap((file) => {
    const owners = Object.entries(input.manifest.workstreams)
      .filter(([, patterns]) => matchesAny(file, patterns))
      .map(([owner]) => owner)
    return owners.length > 1 ? [{ file, owners }] : []
  })
  const blockers: string[] = []
  if (!release) blockers.push('release_unresolved')
  if (!workstream) blockers.push('workstream_unresolved')
  else if (!input.manifest.workstreams[workstream]) blockers.push(`workstream_unknown:${workstream}`)
  if (!canonicalBase) blockers.push('base_commit_invalid')
  if (!canonicalHead) blockers.push('head_commit_invalid')
  if (input.manifest.overlap_policy !== 'fail_closed') blockers.push('overlap_policy_not_fail_closed')
  if (canonicalBase && input.manifest.baseline !== canonicalBase) blockers.push('base_does_not_match_manifest_baseline')
  if (canonicalBase && canonicalHead && !gitOk(input.root, ['merge-base', '--is-ancestor', canonicalBase, canonicalHead])) blockers.push('base_not_ancestor_of_head')
  if (changedFiles.length === 0) blockers.push('worker_diff_empty')
  for (const file of sharedFileChanges) blockers.push(`shared_file_changed:${file}`)
  for (const file of outOfScopeChanges) blockers.push(`out_of_scope_change:${file}`)
  for (const entry of ambiguousOwnerChanges) blockers.push(`ambiguous_file_owner:${entry.file}:${entry.owners.join(',')}`)
  return {
    schema: RELEASE_FILE_OWNERSHIP_REPORT_SCHEMA,
    ok: blockers.length === 0,
    base: canonicalBase || input.base,
    head: canonicalHead || input.head,
    release: release || null,
    workstream,
    changed_files: changedFiles,
    allowed_patterns: allowedPatterns,
    shared_file_changes: sharedFileChanges,
    out_of_scope_changes: outOfScopeChanges,
    ambiguous_owner_changes: ambiguousOwnerChanges,
    blockers,
    checked_at: new Date().toISOString()
  }
}

function inferWorkstream(manifest: ReleaseFileOwnershipManifest, changedFiles: string[], release: string): string | null {
  if (release) {
    const requestPattern = new RegExp(`^${escapeRegExp(sharedFileRequestDir(release))}/(W\\d+)(?:-[^/]+)?\\.json$`)
    const requestOwners = [...new Set(changedFiles.flatMap((file) => {
      const match = file.match(requestPattern)
      return match?.[1] ? [match[1]] : []
    }))]
    const requestOwner = requestOwners[0]
    if (requestOwners.length === 1 && requestOwner && manifest.workstreams[requestOwner]) return requestOwner
  }
  const candidates = Object.entries(manifest.workstreams)
    .filter(([owner, patterns]) => changedFiles.every((file) => (release && isWorkstreamRequest(file, owner, release)) || matchesAny(file, patterns)))
    .map(([owner]) => owner)
  return candidates.length === 1 ? candidates[0] || null : null
}

function gitChangedFiles(root: string, base: string, head: string): string[] {
  const result = spawnSync('git', ['diff', '--name-status', '-z', '--find-renames', '--diff-filter=ACDMRTUXB', `${base}..${head}`, '--'], {
    cwd: root,
    encoding: 'buffer',
    maxBuffer: 16 * 1024 * 1024
  })
  if (result.status !== 0) throw new Error(String(result.stderr?.toString('utf8') || result.stdout?.toString('utf8') || 'git diff failed').trim())
  const tokens = result.stdout.toString('utf8').split('\0')
  const files: string[] = []
  for (let index = 0; index < tokens.length;) {
    const status = tokens[index++] || ''
    if (!status) break
    const first = normalize(tokens[index++] || '')
    if (first) files.push(first)
    if (/^[RC]/.test(status)) {
      const second = normalize(tokens[index++] || '')
      if (second) files.push(second)
    }
  }
  return [...new Set(files)].sort()
}

function gitCommit(root: string, value: string): string {
  const result = spawnSync('git', ['rev-parse', '--verify', `${value}^{commit}`], { cwd: root, encoding: 'utf8' })
  const commit = result.status === 0 ? String(result.stdout || '').trim() : ''
  return /^[a-f0-9]{40}$/i.test(commit) ? commit : ''
}

function gitOk(root: string, args: string[]): boolean {
  return spawnSync('git', args, { cwd: root, stdio: 'ignore' }).status === 0
}

function matchesAny(file: string, patterns: string[]): boolean {
  return patterns.some((pattern) => globToRegExp(normalize(pattern)).test(normalize(file)))
}

function isWorkstreamRequest(file: string, owner: string, release: string): boolean {
  if (!release) return false
  return new RegExp(`^${escapeRegExp(sharedFileRequestDir(release))}/${escapeRegExp(owner)}(?:-[^/]+)?\\.json$`).test(file)
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function globToRegExp(pattern: string): RegExp {
  let source = '^'
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index] || ''
    if (char === '*') {
      if (pattern[index + 1] === '*') {
        index += 1
        source += '.*'
      } else {
        source += '[^/]*'
      }
    } else if (char === '?') {
      source += '[^/]'
    } else {
      source += char.replace(/[|\\{}()[\]^$+?.]/g, '\\$&')
    }
  }
  return new RegExp(`${source}$`)
}

function normalize(value: string): string {
  return value.trim().split(path.sep).join('/').replace(/^\.\//, '')
}
