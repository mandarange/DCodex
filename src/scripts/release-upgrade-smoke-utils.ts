import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
// The producer and `inspectMainPushGuard` have to agree on when two recorded
// paths name one directory, so the rule lives in `src/core` where both can
// reach it rather than as a copy on each side.
import {
  canonicalFilesystemPathSync as canonicalFilesystemPath,
  sameFilesystemPathSync as samePath
} from '../core/fsx.js'

export function readRegularFile(file: string, label: string): { bytes: Buffer | null; blockers: string[] } {
  try {
    const stat = fs.lstatSync(file)
    const blockers: string[] = []
    if (stat.isSymbolicLink()) blockers.push(`${label}_symlink_refused`)
    if (!stat.isFile()) blockers.push(`${label}_not_regular_file`)
    return { bytes: blockers.length ? null : fs.readFileSync(file), blockers }
  } catch {
    return { bytes: null, blockers: [`${label}_missing_or_unreadable`] }
  }
}

export function readJsonObject(file: string): Record<string, any> | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null
  } catch {
    return null
  }
}

export function parseJson(value: string): any {
  try {
    return JSON.parse(stripAnsi(value).trim())
  } catch {
    return null
  }
}

export function normalizeSha256(value: unknown): string | null {
  const normalized = String(value || '').trim().toLowerCase()
  return /^[a-f0-9]{64}$/.test(normalized) ? normalized : null
}

export function canonicalSemver(value: string): string | null {
  const match = value.match(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?$/)
  if (!match) return null
  const prerelease = match[4]
  if (prerelease) {
    const identifiers = prerelease.split('.')
    if (identifiers.some((item) => !item || (/^\d+$/.test(item) && item.length > 1 && item.startsWith('0')))) return null
  }
  return value
}

export function isSubpath(candidate: string, root: string): boolean {
  const relative = path.relative(canonicalFilesystemPath(root), canonicalFilesystemPath(candidate))
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
}

export { canonicalFilesystemPath, samePath }

export function hashBytes(value: Buffer): string {
  return crypto.createHash('sha256').update(value).digest('hex')
}

export function hashText(value: string): string {
  return hashBytes(Buffer.from(value))
}

export function canonicalJson(value: unknown): string {
  const normalize = (input: unknown): unknown => {
    if (Array.isArray(input)) return input.map(normalize)
    if (input && typeof input === 'object') {
      return Object.fromEntries(
        Object.entries(input as Record<string, unknown>)
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([key, row]) => [key, normalize(row)])
      )
    }
    return input
  }
  return JSON.stringify(normalize(value)) || 'null'
}

export function unique(values: string[]): string[] {
  return [...new Set(values.map(String).filter(Boolean))]
}

export function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value ? value : null
}

export function boundedTail(current: string, next: string, max: number): string {
  const combined = `${current}${next}`
  return combined.length <= max ? combined : combined.slice(-max)
}

export function stripAnsi(value: string): string {
  return value.replace(/\u001B\[[0-?]*[ -/]*[@-~]/g, '')
}

export function redact(value: string): string {
  return value
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi, '$1[REDACTED]')
    .replace(/((?:npm|github|openai|telegram|supabase)[_A-Za-z0-9-]*(?:token|key)\s*[=:]\s*)[^\s"']+/gi, '$1[REDACTED]')
    .replace(/npm_[A-Za-z0-9]{20,}/g, '[REDACTED_NPM_TOKEN]')
}

export function npmInstallArgs(prefix: string, tarball: string): string[] {
  return ['install', '--global', '--prefix', prefix, '--no-audit', '--no-fund', '--loglevel=error', tarball]
}

export function sksBinary(prefix: string, platform: NodeJS.Platform): string {
  return platform === 'win32' ? path.join(prefix, 'sks.cmd') : path.join(prefix, 'bin', 'sks')
}

export function installedPackageRoot(prefix: string, platform: NodeJS.Platform): string {
  return platform === 'win32'
    ? path.join(prefix, 'node_modules', 'sneakoscope')
    : path.join(prefix, 'lib', 'node_modules', 'sneakoscope')
}

export function npmExecutable(): string {
  return process.platform === 'win32' ? 'npm.cmd' : 'npm'
}
