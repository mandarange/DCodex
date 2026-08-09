import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileIdentity, inspectionKey, memoizeReleaseInspection, toolIdentity } from './release-inspection-memo.js'

// Every fact below is a pure function of the tarball bytes, so it is memoized
// on the archive's file identity: one release inspection extracts the same
// package four times today, and the guard/receipt path repeats all of it.
export function tarInventory(tarball: string): { files: string[]; blockers: string[] } {
  return memoizeReleaseInspection('tar-inventory', inspectionKey(tarball, fileIdentity(tarball), toolIdentity('tar')), () => computeTarInventory(tarball))
}

function computeTarInventory(tarball: string): { files: string[]; blockers: string[] } {
  const result = spawnSync('tar', ['-tzf', tarball], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 })
  if (result.status !== 0) return { files: [], blockers: ['tarball_inventory_command_failed'] }
  const blockers: string[] = []
  const files = String(result.stdout || '').split(/\r?\n/).filter(Boolean).filter((entry) => !entry.endsWith('/'))
  for (const entry of files) {
    const normalized = path.posix.normalize(entry)
    if (!entry.startsWith('package/') || normalized.startsWith('../') || normalized.includes('/../') || path.posix.isAbsolute(entry)) {
      blockers.push(`unsafe_tarball_path:${entry}`)
    }
    if (/(^|\/)\.env(?:\.|$)/i.test(entry)) blockers.push(`secret_file_in_tarball:${entry}`)
  }
  const verbose = spawnSync('tar', ['-tvzf', tarball], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 })
  if (verbose.status !== 0) blockers.push('tarball_type_inventory_command_failed')
  else for (const line of String(verbose.stdout || '').split(/\r?\n/).filter(Boolean)) {
    const type = line.trimStart()[0] || ''
    if (type && type !== '-' && type !== 'd') blockers.push(`unsafe_tarball_entry_type:${type}`)
  }
  return { files, blockers }
}

export function tarPackageJson(tarball: string): Record<string, any> | null {
  return memoizeReleaseInspection('tar-package-json', inspectionKey(tarball, fileIdentity(tarball), toolIdentity('tar')), () => computeTarPackageJson(tarball))
}

function computeTarPackageJson(tarball: string): Record<string, any> | null {
  const result = spawnSync('tar', ['-xOzf', tarball, 'package/package.json'], { encoding: 'utf8', maxBuffer: 1024 * 1024 })
  if (result.status !== 0) return null
  try {
    const parsed = JSON.parse(String(result.stdout || ''))
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null
  } catch {
    return null
  }
}

export function tarUnpackedBytes(tarball: string): number {
  return memoizeReleaseInspection('tar-unpacked-bytes', inspectionKey(tarball, fileIdentity(tarball), toolIdentity('tar')), () => computeTarUnpackedBytes(tarball))
}

function computeTarUnpackedBytes(tarball: string): number {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'sks-release-pack-unpacked-'))
  try {
    const result = spawnSync('tar', ['-xzf', tarball, '-C', temp], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 })
    if (result.status !== 0) return 0
    return directoryBytes(temp)
  } finally {
    fs.rmSync(temp, { recursive: true, force: true })
  }
}

function directoryBytes(directory: string): number {
  let total = 0
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name)
    if (entry.isDirectory()) total += directoryBytes(file)
    else if (entry.isFile()) total += fs.statSync(file).size
  }
  return total
}
