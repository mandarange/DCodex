import path from 'node:path'
import fsp from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import { appendJsonl, ensureDir, nowIso, readText, sha256, writeTextAtomic } from '../fsx.js'
import { diffCodexAppUiSnapshots, snapshotCodexAppUiState } from '../codex-app/codex-app-ui-state-snapshot.js'
import { cleanupCodexConfigBackups, validateCodexConfigRoundTrip } from './codex-config-toml.js'
import { escapeRegExp } from '../text/regex.js'

export interface WriteCodexConfigGuardedInput {
  root?: string
  configPath: string
  before?: string
  mutate: (before: string) => string | Promise<string>
  cause?: string
  backupTag?: string
  removeTopLevelModeLocks?: boolean
  preserveFastUiKeys?: boolean
  ownershipVerified?: boolean
  verifyUnchangedBeforeWrite?: boolean
  expectedBeforeExists?: boolean
  preserveTextFormatting?: boolean
  reportPath?: string
}

export interface WriteCodexConfigGuardedResult {
  ok: boolean
  status: string
  config_path: string
  backup_path: string | null
  changed: boolean
  repaired_keys?: string[]
  forbidden_top_level?: string[]
  report_path?: string
}

// fast_mode_ui was removed from the [features] schema in the 2026-07 renewal.
// Every SKS-managed Desktop feature flag is preserved across guarded mutations
// so a provider switch or repair can never silently drop feature UI enablement.
// Legacy flags (codex_hooks, remote_control, fast_mode_ui, codex_git_commit)
// stay out of this list so normalization can still strip them.
const FAST_FEATURE_KEYS = [
  'fast_mode',
  'hooks',
  'apps',
  'computer_use',
  'browser_use',
  'browser_use_external',
  'image_generation',
  'in_app_browser',
  'guardian_approval',
  'tool_suggest',
  'plugins'
]

export async function writeCodexConfigGuarded(input: WriteCodexConfigGuardedInput): Promise<WriteCodexConfigGuardedResult> {
  const configPath = path.resolve(input.configPath)
  const root = path.resolve(input.root || process.cwd())
  const cause = input.cause || 'codex-config'
  const before = input.before === undefined ? String(await readText(configPath, '')) : String(input.before || '')
  if (isUnmanagedProjectCodexConfig(root, configPath, before) && input.ownershipVerified !== true) {
    const result = { ok: false, status: 'blocked_unmanaged_project_config', config_path: configPath, backup_path: null, changed: false }
    await recordCodexConfigGuard(root, input.reportPath, {
      cause,
      config_path: configPath,
      ok: false,
      status: result.status,
      blocker: 'user_owned_file_without_sks_marker',
      changed: false
    })
    return result
  }
  const beforeSmoke = codexConfigParseSmoke(before)
  const beforeValidation = validateCodexConfigRoundTrip(before)
  if (before.trim() && (!beforeSmoke.ok || beforeValidation.parse_error)) {
    const backupPath = await backupCodexConfig(configPath, before, `${cause}-unparseable`)
    const result = { ok: false, status: 'unparseable_config_preserved', config_path: configPath, backup_path: backupPath, changed: false }
    await recordCodexConfigGuard(root, input.reportPath, {
      cause,
      config_path: configPath,
      ok: false,
      status: result.status,
      before_smoke: beforeSmoke,
      before_validation: beforeValidation,
      changed: false
    })
    return result
  }

  const beforeSnapshot = await snapshotForConfig(root, configPath).catch(() => null)
  const normalizeText = input.preserveTextFormatting === true
    ? (value: unknown) => String(value || '')
    : ensureTrailingNewline
  let next = normalizeText(await input.mutate(before))
  if (input.removeTopLevelModeLocks === true) next = removeLegacyTopLevelCodexModeLocks(next)
  const preserved = input.preserveFastUiKeys === false ? { text: normalizeText(next), keys: [] } : mergeLostFastUiKeys(before, next)
  next = preserved.text
  if (input.removeTopLevelModeLocks === true) next = removeLegacyTopLevelCodexModeLocks(next)

  const forbiddenTopLevel = topLevelModeLocks(next)
  const nextSmoke = codexConfigParseSmoke(next)
  const nextValidation = validateCodexConfigRoundTrip(next)
  if (!nextSmoke.ok || !nextValidation.ok) {
    const result = { ok: false, status: 'skipped_unsafe_rewrite', config_path: configPath, backup_path: null, changed: false, repaired_keys: preserved.keys, forbidden_top_level: forbiddenTopLevel }
    await recordCodexConfigGuard(root, input.reportPath, {
      cause,
      config_path: configPath,
      ok: false,
      status: result.status,
      next_smoke: nextSmoke,
      next_validation: nextValidation,
      changed: false,
      repaired_keys: preserved.keys,
      forbidden_top_level: forbiddenTopLevel
    })
    return result
  }

  const expectedBefore = normalizeText(before)
  if (next === expectedBefore) {
    if (input.verifyUnchangedBeforeWrite === true) {
      const observed = await readConfigCommitSnapshot(configPath)
      const expectedExists = input.expectedBeforeExists ?? true
      if (!configCommitSnapshotMatches(observed, expectedExists, before)) {
        return recordConcurrentConfigChange({
          root,
          reportPath: input.reportPath,
          cause,
          configPath,
          before,
          expectedExists,
          observed,
          backupPath: null,
          repairedKeys: preserved.keys,
          forbiddenTopLevel
        })
      }
    } else {
      await writeTextAtomic(configPath, next, { mode: 0o600 })
    }
    const result = { ok: true, status: 'present', config_path: configPath, backup_path: null, changed: false, repaired_keys: preserved.keys, forbidden_top_level: forbiddenTopLevel }
    if (preserved.keys.length || forbiddenTopLevel.length) {
      await recordCodexConfigGuard(root, input.reportPath, {
        cause,
        config_path: configPath,
        ok: true,
        status: result.status,
        changed: false,
        repaired_keys: preserved.keys,
        forbidden_top_level: forbiddenTopLevel
      })
    }
    return result
  }

  let backupPath: string | null = null
  if (input.verifyUnchangedBeforeWrite === true) {
    const expectedExists = input.expectedBeforeExists ?? true
    const commit = await commitCodexConfigIfUnchanged({
      configPath,
      before,
      next,
      expectedExists,
      backupTag: input.backupTag || cause
    })
    if (!commit.ok) {
      return recordConcurrentConfigChange({
        root,
        reportPath: input.reportPath,
        cause,
        configPath,
        before,
        expectedExists,
        observed: commit.observed,
        backupPath: commit.backupPath,
        repairedKeys: preserved.keys,
        forbiddenTopLevel
      })
    }
    backupPath = commit.backupPath
  } else {
    backupPath = before.trim() ? await backupCodexConfig(configPath, before, input.backupTag || cause) : null
    await ensureDir(path.dirname(configPath))
    await writeTextAtomic(configPath, next, { mode: 0o600 })
  }
  const afterSnapshot = await snapshotForConfig(root, configPath).catch(() => null)
  const diff = beforeSnapshot && afterSnapshot ? diffCodexAppUiSnapshots(beforeSnapshot, afterSnapshot) : null
  const result = {
    ok: true,
    status: 'written',
    config_path: configPath,
    backup_path: backupPath,
    changed: true,
    repaired_keys: preserved.keys,
    forbidden_top_level: forbiddenTopLevel
  }
  const reportPath = await recordCodexConfigGuard(root, input.reportPath, {
    cause,
    config_path: configPath,
    ok: true,
    status: result.status,
    changed: true,
    backup_path: backupPath,
    before_sha256: sha256(before),
    after_sha256: sha256(next),
    repaired_keys: preserved.keys,
    forbidden_top_level: forbiddenTopLevel,
    snapshot_diff: diff ? {
      ok: diff.ok,
      before_fast_selector: diff.before_fast_selector,
      after_fast_selector: diff.after_fast_selector,
      host_owned_added: diff.host_owned_added,
      host_owned_removed: diff.host_owned_removed,
      blockers: diff.blockers
    } : null
  })
  return { ...result, report_path: reportPath }
}

type ConfigCommitSnapshot = Awaited<ReturnType<typeof readConfigCommitSnapshot>>

function configCommitSnapshotMatches(observed: ConfigCommitSnapshot, expectedExists: boolean, expectedText: string): boolean {
  return observed.ok
    && observed.exists === expectedExists
    && sha256(observed.text) === sha256(expectedText)
}

async function recordConcurrentConfigChange(input: {
  root: string
  reportPath: string | undefined
  cause: string
  configPath: string
  before: string
  expectedExists: boolean
  observed: ConfigCommitSnapshot
  backupPath: string | null
  repairedKeys: string[]
  forbiddenTopLevel: string[]
}): Promise<WriteCodexConfigGuardedResult> {
  const result = {
    ok: false,
    status: 'concurrent_change_detected',
    config_path: input.configPath,
    backup_path: input.backupPath,
    changed: false,
    repaired_keys: input.repairedKeys,
    forbidden_top_level: input.forbiddenTopLevel
  }
  await recordCodexConfigGuard(input.root, input.reportPath, {
    cause: input.cause,
    config_path: input.configPath,
    ok: false,
    status: result.status,
    expected_exists: input.expectedExists,
    observed_exists: input.observed.exists,
    expected_sha256: sha256(input.before),
    observed_sha256: input.observed.ok ? sha256(input.observed.text) : null,
    observed_status: input.observed.status,
    backup_path: input.backupPath,
    changed: false
  })
  return result
}

async function commitCodexConfigIfUnchanged(input: {
  configPath: string
  before: string
  next: string
  expectedExists: boolean
  backupTag: string
}): Promise<
  | { ok: true; backupPath: string | null }
  | { ok: false; backupPath: string | null; observed: ConfigCommitSnapshot }
> {
  await ensureDir(path.dirname(input.configPath))
  const token = `${Date.now().toString(36)}-${process.pid}-${randomBytes(6).toString('hex')}`
  const candidatePath = `${input.configPath}.sks-commit-${token}.tmp`
  let backupPath: string | null = null
  try {
    await writeTextAtomic(candidatePath, input.next, { mode: 0o600 })
    const observed = await readConfigCommitSnapshot(input.configPath)
    if (!configCommitSnapshotMatches(observed, input.expectedExists, input.before)) {
      return { ok: false, backupPath, observed }
    }

    if (input.expectedExists) {
      backupPath = `${input.configPath}.sks-${safeBackupTag(input.backupTag)}-${token}.bak`
      try {
        await fsp.rename(input.configPath, backupPath)
      } catch {
        return { ok: false, backupPath: null, observed: await readConfigCommitSnapshot(input.configPath) }
      }

      const claimed = await readConfigCommitSnapshot(backupPath)
      if (!configCommitSnapshotMatches(claimed, true, input.before)) {
        await restoreClaimedConfigIfAbsent(backupPath, input.configPath, claimed)
        return { ok: false, backupPath, observed: claimed }
      }
      try {
        await fsp.chmod(backupPath, 0o600)
        const now = new Date()
        await fsp.utimes(backupPath, now, now)
      } catch {
        await restoreClaimedConfigIfAbsent(backupPath, input.configPath, claimed)
        return { ok: false, backupPath, observed: await readConfigCommitSnapshot(input.configPath) }
      }

      const afterClaim = await readConfigCommitSnapshot(input.configPath)
      if (!afterClaim.ok || afterClaim.exists) {
        if (!afterClaim.exists) await restoreClaimedConfigIfAbsent(backupPath, input.configPath, claimed)
        return { ok: false, backupPath, observed: await readConfigCommitSnapshot(input.configPath) }
      }
    }

    try {
      await fsp.link(candidatePath, input.configPath)
    } catch {
      if (backupPath) {
        const claimed = await readConfigCommitSnapshot(backupPath)
        await restoreClaimedConfigIfAbsent(backupPath, input.configPath, claimed)
      }
      return { ok: false, backupPath, observed: await readConfigCommitSnapshot(input.configPath) }
    }
    await fsp.chmod(input.configPath, 0o600).catch(() => undefined)
    await cleanupCodexConfigBackups(input.configPath, { keepPerTag: 3, maxAgeMs: 30 * 24 * 60 * 60 * 1000 }).catch(() => undefined)
    return { ok: true, backupPath }
  } finally {
    await fsp.rm(candidatePath, { force: true }).catch(() => undefined)
  }
}

async function restoreClaimedConfigIfAbsent(backupPath: string, configPath: string, claimed: ConfigCommitSnapshot) {
  if (!claimed.ok || !claimed.exists || claimed.status !== 'regular') return
  await fsp.link(backupPath, configPath).catch(() => undefined)
}

function safeBackupTag(value: string) {
  return String(value || 'codex-config').replace(/[^A-Za-z0-9_.-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 96) || 'codex-config'
}

async function readConfigCommitSnapshot(configPath: string): Promise<
  | { ok: true; exists: boolean; text: string; status: 'missing' | 'regular' }
  | { ok: false; exists: boolean; text: ''; status: 'symlink' | 'non_regular' | 'read_failed' }
> {
  let stat
  try {
    stat = await fsp.lstat(configPath)
  } catch (error: any) {
    if (error?.code === 'ENOENT') return { ok: true, exists: false, text: '', status: 'missing' }
    return { ok: false, exists: false, text: '', status: 'read_failed' }
  }
  if (stat.isSymbolicLink()) return { ok: false, exists: true, text: '', status: 'symlink' }
  if (!stat.isFile()) return { ok: false, exists: true, text: '', status: 'non_regular' }
  try {
    return { ok: true, exists: true, text: await fsp.readFile(configPath, 'utf8'), status: 'regular' }
  } catch {
    return { ok: false, exists: true, text: '', status: 'read_failed' }
  }
}

export function extractTomlTable(text: string, tableName: string): string | null {
  const source = String(text || '')
  const header = `[${tableName}]`
  const lines = source.trimEnd().split(/\r?\n/)
  const start = lines.findIndex((line) => line.trim() === header)
  if (start === -1) return null
  let end = lines.length
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^\s*\[.+\]\s*$/.test(lines[i] || '')) {
      end = i
      break
    }
  }
  return lines.slice(start, end).join('\n')
}

export function codexConfigParseSmoke(text: string = '') {
  const str = String(text || '')
  const tripleTokens = (str.match(/"""|'''/g) || []).length
  const unterminatedTriple = tripleTokens % 2 !== 0
  const invalidHeader = str.split('\n').find((line) => /^\s*\[/.test(line) && !/^\s*\[\[?[^\]]+\]\]?\s*(?:#.*)?$/.test(line)) || null
  return { ok: !unterminatedTriple && !invalidHeader, unterminated_multiline_string: unterminatedTriple, invalid_table_header: invalidHeader }
}

export function ensureTrailingNewline(text: unknown = '') {
  const value = String(text || '').trimEnd()
  return value ? `${value}\n` : ''
}

export function isProjectCodexConfig(root: string, configPath: string): boolean {
  return path.resolve(configPath) === path.resolve(root, '.codex', 'config.toml')
}

export function hasSksManagedCodexConfigMarker(text: string): boolean {
  const source = String(text || '')
  return /^\s*#\s*SKS-MANAGED-CODEX-CONFIG\b/im.test(source)
    || /(?:SKS managed|Sneakoscope|sneakoscope|sks_|agents\.native_agent|agents\.implementation_worker|multi_agent)/i.test(source)
    || /^\s*model_provider\s*=\s*["']codex-lb["']\s*(?:#.*)?$/mi.test(source)
    || /^\s*default_profile\s*=\s*["']sks-fast-high["']\s*(?:#.*)?$/mi.test(source)
    || /^\s*\[(?:user\.fast_mode|model_providers\.(?:"codex-lb"|codex-lb)|profiles\.(?:"sks-fast-high"|sks-fast-high))\]\s*(?:#.*)?$/mi.test(source)
}

export function isUnmanagedProjectCodexConfig(root: string, configPath: string, text: string): boolean {
  return isProjectCodexConfig(root, configPath)
    && String(text || '').trim().length > 0
    && !hasSksManagedCodexConfigMarker(text)
}

export function removeLegacyTopLevelCodexModeLocks(text: string = '') {
  const lines = String(ensureTrailingNewline(text) || '').split('\n')
  const firstTable = lines.findIndex((x) => /^\s*\[.+\]\s*$/.test(x))
  const end = firstTable === -1 ? lines.length : firstTable
  return ensureTrailingNewline(lines.filter((line, index) => {
    if (index >= end) return true
    if (!/^\s*(?:model|model_reasoning_effort)\s*=/.test(line)) return true
    return !hasSksModeLockProvenance(lines, index)
  }).join('\n').replace(/^\n+/, '').replace(/\n{3,}/g, '\n\n'))
}

function hasSksModeLockProvenance(lines: string[], index: number) {
  const current = String(lines[index] || '')
  const inlineComment = current.includes('#') ? current.slice(current.indexOf('#')) : ''
  if (isSksModeLockMarker(inlineComment)) return true
  const allowedManagedKeys = new Set([
    'service_tier', 'model', 'model_reasoning_effort', 'model_provider',
    'approval_policy', 'sandbox_mode', 'web_search', 'notify', 'preferred_auth_method'
  ])
  const lowerBound = Math.max(0, index - 16)
  for (let cursor = index - 1; cursor >= lowerBound; cursor -= 1) {
    const candidate = String(lines[cursor] || '').trim()
    if (!candidate) continue
    if (candidate.startsWith('#')) {
      if (isSksModeLockMarker(candidate)) return true
      continue
    }
    const key = candidate.match(/^([A-Za-z0-9_-]+)\s*=/)?.[1] || ''
    if (!allowedManagedKeys.has(key)) return false
  }
  return false
}

function isSksModeLockMarker(value: string = '') {
  return /^#\s*(?:SKS|Sneakoscope)\b.*(?:moved machine-local Codex config|forced fast UI|managed (?:Codex )?(?:model|reasoning)|codex-lb (?:model|reasoning))/i.test(String(value || '').trim())
}

function mergeLostFastUiKeys(before: string, nextInput: string) {
  let next = String(nextInput || '')
  const keys: string[] = []
  // [user.fast_mode] left the config schema in the 2026-07 renewal — it is no
  // longer restored when lost; SKS strips it everywhere else.
  for (const key of FAST_FEATURE_KEYS) {
    const line = tomlTableKeyLine(before, 'features', key)
    if (line && !hasTomlTableKey(next, 'features', key)) {
      next = upsertTomlTableKey(next, 'features', line)
      keys.push(`features.${key}`)
    }
  }
  const tier = topLevelTomlKeyLine(before, 'service_tier')
  if (tier && !hasTopLevelTomlKey(next, 'service_tier')) {
    next = upsertTopLevelTomlLine(next, tier)
    keys.push('service_tier')
  }
  return { text: ensureTrailingNewline(next), keys }
}

function topLevelModeLocks(text: string) {
  return ['model_reasoning_effort'].filter((key) => hasTopLevelTomlKey(text, key))
}

function topLevelTomlKeyLine(text: string, key: string) {
  const lines = String(text || '').split('\n')
  const firstTable = lines.findIndex((x) => /^\s*\[.+\]\s*$/.test(x))
  const end = firstTable === -1 ? lines.length : firstTable
  const pattern = new RegExp(`^\\s*${escapeRegExp(key)}\\s*=`)
  for (let i = 0; i < end; i += 1) {
    const line = lines[i] || ''
    if (pattern.test(line)) return line
  }
  return null
}

function topLevelTomlString(text: string, key: string) {
  const line = topLevelTomlKeyLine(text, key)
  const match = line?.match(/^\s*[^=]+\s*=\s*"([^"]*)"\s*(?:#.*)?$/)
  return match?.[1] || null
}

function upsertTopLevelTomlLine(text: string, line: string) {
  const key = String(line).split('=')[0]?.trim() || ''
  const lines = String(text || '').trimEnd().split('\n')
  if (lines.length === 1 && lines[0] === '') lines.length = 0
  const firstTable = lines.findIndex((x) => /^\s*\[.+\]\s*$/.test(x))
  const end = firstTable === -1 ? lines.length : firstTable
  const pattern = new RegExp(`^\\s*${escapeRegExp(key)}\\s*=`)
  for (let i = 0; i < end; i += 1) {
    if (pattern.test(lines[i] || '')) {
      lines[i] = line
      return lines.join('\n').replace(/^\n+/, '').replace(/\n{3,}/g, '\n\n')
    }
  }
  lines.splice(end, 0, line)
  return lines.join('\n').replace(/^\n+/, '').replace(/\n{3,}/g, '\n\n')
}

function tomlTableKeyLine(text: string, table: string, key: string) {
  const lines = String(text || '').split('\n')
  const header = `[${table}]`
  const start = lines.findIndex((line) => line.trim() === header)
  if (start === -1) return null
  const pattern = new RegExp(`^\\s*${escapeRegExp(key)}\\s*=`)
  for (let i = start + 1; i < lines.length; i += 1) {
    const line = lines[i] || ''
    if (/^\s*\[.+\]\s*$/.test(line)) break
    if (pattern.test(line)) return line
  }
  return null
}

function hasTopLevelTomlKey(text: string, key: string) {
  return Boolean(topLevelTomlKeyLine(text, key))
}

function hasTomlTableKey(text: string, table: string, key: string) {
  return Boolean(tomlTableKeyLine(text, table, key))
}

function upsertTomlTableKey(text: string, table: string, line: string) {
  const key = String(line).split('=')[0]?.trim() || ''
  const lines = String(text || '').trimEnd().split('\n')
  if (lines.length === 1 && lines[0] === '') lines.length = 0
  const header = `[${table}]`
  const start = lines.findIndex((x) => x.trim() === header)
  if (start === -1) return [...lines, ...(lines.length ? [''] : []), header, line].join('\n').replace(/\n{3,}/g, '\n\n')
  let end = lines.length
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^\s*\[.+\]\s*$/.test(lines[i] || '')) {
      end = i
      break
    }
  }
  const keyRe = new RegExp(`^\\s*${escapeRegExp(key)}\\s*=`)
  for (let i = start + 1; i < end; i += 1) {
    if (keyRe.test(lines[i] || '')) {
      lines[i] = line
      return lines.join('\n').replace(/\n{3,}/g, '\n\n')
    }
  }
  lines.splice(end, 0, line)
  return lines.join('\n').replace(/\n{3,}/g, '\n\n')
}

function upsertTomlTable(text: string, table: string, block: string) {
  let lines = String(text || '').trimEnd().split('\n')
  if (lines.length === 1 && lines[0] === '') lines = []
  const header = `[${table}]`
  const start = lines.findIndex((x) => x.trim() === header)
  const blockLines = String(block || '').trim().split('\n')
  if (start === -1) return [...lines, ...(lines.length ? [''] : []), ...blockLines].join('\n').replace(/\n{3,}/g, '\n\n')
  let end = lines.length
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^\s*\[.+\]\s*$/.test(lines[i] || '')) {
      end = i
      break
    }
  }
  lines.splice(start, end - start, ...blockLines)
  return lines.join('\n').replace(/\n{3,}/g, '\n\n')
}

async function snapshotForConfig(root: string, configPath: string) {
  const codexHome = path.basename(configPath) === 'config.toml' ? path.dirname(configPath) : null
  return snapshotCodexAppUiState(root, codexHome ? { codexHome } : {})
}

async function backupCodexConfig(configPath: string, text: string, tag: string) {
  try {
    const backupPath = `${configPath}.sks-${tag}-${Date.now().toString(36)}.bak`
    await writeTextAtomic(backupPath, text, { mode: 0o600 })
    await cleanupCodexConfigBackups(configPath, { keepPerTag: 3, maxAgeMs: 30 * 24 * 60 * 60 * 1000 }).catch(() => undefined)
    return backupPath
  } catch {
    return null
  }
}

async function recordCodexConfigGuard(root: string, reportPath: string | undefined, record: Record<string, unknown>) {
  const file = reportPath || path.join(root, '.sneakoscope', 'reports', 'codex-config-guard.jsonl')
  await appendJsonl(file, {
    schema: 'sks.codex-config-guard.v1',
    ts: nowIso(),
    ...record
  }).catch(() => undefined)
  return file
}
