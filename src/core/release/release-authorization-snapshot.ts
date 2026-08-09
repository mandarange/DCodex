import { spawnSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { cachedByFingerprint, statFingerprint } from './content-digest-cache.js'
import { packageDistSnapshot, packageFilesSnapshot } from './package-dist-snapshot.js'

export const RELEASE_AUTHORIZATION_SNAPSHOT_KEYS = Object.freeze([
  'git_commit',
  'source_digest',
  'source_file_count',
  'package_files_sha256',
  'package_file_count',
  'release_gate_sha256',
  'dist_build_sha256',
  'dist_file_count'
] as const)

export type ReleaseAuthorizationSnapshotKey = typeof RELEASE_AUTHORIZATION_SNAPSHOT_KEYS[number]

export interface ReleaseAuthorizationSnapshot {
  git_commit: string | null
  source_digest: string
  source_file_count: number
  package_files_sha256: string
  package_file_count: number
  release_gate_sha256: string
  dist_build_sha256: string | null
  dist_file_count: number
}

export function releaseAuthorizationSnapshot(root: string, pkg: Record<string, any>): ReleaseAuthorizationSnapshot {
  const source = releaseSourceSnapshot(root)
  const packageFiles = packageFilesSnapshot(root, pkg)
  const dist = packageDistSnapshot(root, pkg)
  return {
    git_commit: gitCommit(root),
    package_files_sha256: packageFiles.digest,
    package_file_count: packageFiles.file_count,
    dist_build_sha256: dist.digest,
    dist_file_count: dist.file_count,
    release_gate_sha256: releaseGateHash(root, pkg),
    source_digest: source.digest,
    source_file_count: source.file_count
  }
}

export function sameReleaseAuthorizationSnapshot(
  left: Partial<ReleaseAuthorizationSnapshot> | null | undefined,
  right: Partial<ReleaseAuthorizationSnapshot> | null | undefined,
): boolean {
  return RELEASE_AUTHORIZATION_SNAPSHOT_KEYS.every((key) => left?.[key] === right?.[key])
}

function gitCommit(root: string) {
  const result = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' })
  return result.status === 0 ? result.stdout.trim() : null
}

function releaseGateHash(root: string, pkg: Record<string, any>) {
  const manifests = ['release-gates.v2.json', 'infra-harness-gates.json'].map((rel) => {
    const file = path.join(root, rel)
    return fs.existsSync(file) ? `${rel}\0${fs.readFileSync(file, 'utf8')}` : `${rel}\0missing`
  }).join('\0')
  return sha256(`${pkg.scripts?.['release:check'] || ''}\0${pkg.scripts?.['prepublishOnly'] || ''}\0${manifests}`)
}

function releaseSourceSnapshot(root: string) {
  const files = gitFiles(root).filter(releaseRelevant).sort()
  return cachedByFingerprint(root, 'release-source-snapshot', statFingerprint(root, files), () => computeReleaseSourceSnapshot(root, files))
}

function computeReleaseSourceSnapshot(root: string, files: readonly string[]) {
  const hash = crypto.createHash('sha256')
  for (const file of files) {
    const full = path.join(root, file)
    let stat: fs.Stats
    try {
      stat = fs.statSync(full)
    } catch {
      continue
    }
    if (!stat.isFile()) continue
    const bytes = fs.readFileSync(full)
    hash.update(file)
    hash.update('\0')
    hash.update(String(bytes.length))
    hash.update('\0')
    hash.update(sha256(bytes))
    hash.update('\0')
  }
  return { digest: hash.digest('hex'), file_count: files.length }
}

function gitFiles(root: string) {
  const result = spawnSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024
  })
  if (result.status !== 0) throw new Error(`unable_to_list_release_files:${result.stderr || result.stdout}`)
  return result.stdout.split('\0').filter(Boolean)
}

function releaseRelevant(file: string) {
  if (!file || file.startsWith('.sneakoscope/') || file.startsWith('.codex/') || file.startsWith('.agents/')) return false
  if (file.startsWith('node_modules/') || file.startsWith('dist/') || file.startsWith('coverage/')) return false
  if (file.startsWith('crates/sks-core/target/')) return false
  if (/\.tgz$|\.log$/i.test(file)) return false
  if (/^(package|package-lock)\.json$/.test(file)) return true
  if (file === 'release-gates.v2.json' || file === 'infra-harness-gates.json' || file === 'runtime-required-scripts.json') return true
  if (file === '.npmignore' || file === '.npmrc' || file === 'LICENSE') return true
  if (file.startsWith('config/')) return true
  if (/^tsconfig.*\.json$/.test(file)) return true
  if (/^(README|CHANGELOG|LICENSE)(\.md)?$/i.test(file)) return true
  return [
    '.github/workflows/',
    'bin/',
    'src/',
    'scripts/',
    'test/',
    'docs/',
    'schemas/',
    'crates/sks-core/Cargo.',
    'crates/sks-core/src/'
  ].some((prefix) => file.startsWith(prefix))
}

function sha256(value: crypto.BinaryLike) {
  return crypto.createHash('sha256').update(value).digest('hex')
}
