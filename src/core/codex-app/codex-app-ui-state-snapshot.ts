import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { exists, nowIso, readText, sha256, writeJsonAtomic } from '../fsx.js'

export const CODEX_APP_UI_STATE_SNAPSHOT_SCHEMA = 'sks.codex-app-ui-state-snapshot.v1'

export const PROJECT_LOCAL_FORBIDDEN_CODEX_KEYS = [
  'openai_base_url',
  'chatgpt_base_url',
  'apps_mcp_product_sku',
  'notify',
  'experimental_realtime_ws_base_url',
  'otel'
] as const

const HOST_OWNED_KEY_RE = /^(?:model|model_reasoning_effort|openai_base_url|chatgpt_base_url|apps_mcp_product_sku|model_provider|model_providers(?:\.|$)|notify|profile|profiles(?:\.|$)|experimental_realtime_ws_base_url|otel(?:\.|$)|features\.fast_mode|service_tier|user\.fast_mode(?:\.|$))/
const SECRET_KEY_RE = /(?:key|token|secret|password|credential|cookie|authorization|auth|bearer|refresh|access|headers?|env)/i
const SKS_GLOBAL_UI_LOCK_KEYS = new Set(['model_provider', 'model', 'model_reasoning_effort'])
const SKS_GLOBAL_UI_LOCK_CONTEXT_KEYS = new Set([
  'service_tier', 'model_provider', 'model', 'model_reasoning_effort',
  'approval_policy', 'sandbox_mode', 'web_search', 'notify', 'preferred_auth_method'
])

export interface CodexAppConfigSignal {
  key_path: string
  table: string | null
  value_kind: string
  value_preview: string
  value_hash: string
  line: number
  host_owned: boolean
  fast_ui_related: boolean
  provider_related: boolean
  sks_related: boolean
}

export interface CodexAppUiSnapshotFile {
  path: string
  exists: boolean
  sha256: string | null
  bytes: number
  signals: CodexAppConfigSignal[]
  tables: string[]
  forbidden_project_local_keys?: string[]
}

export interface CodexAppUiStateSnapshot {
  schema: typeof CODEX_APP_UI_STATE_SNAPSHOT_SCHEMA
  generated_at: string
  root: string
  codex_home: string
  files: CodexAppUiSnapshotFile[]
  auth_metadata: Record<string, unknown> | null
  auth_backup_metadata: Record<string, unknown> | null
  app_preference_files: Array<{ path: string; exists: boolean; sha256: string | null; bytes: number }>
  sks_managed_blocks: Array<{ path: string; marker: string; line: number }>
  indicators: {
    fast_selector: 'available' | 'maybe_hidden_or_locked' | 'unknown'
    fast_selector_signals: string[]
    provider_signals: string[]
    host_owned_signal_count: number
    project_local_forbidden_keys: string[]
    secret_leak_suspected: boolean
    auth_mode: 'chatgpt_oauth' | 'apikey' | 'browser_marker' | 'missing' | 'unknown'
    chatgpt_oauth_backup_available: boolean
    chat_surface: 'available' | 'chatgpt_oauth_inactive' | 'unknown'
  }
}

export function codexHome(input?: { codexHome?: string | null }) {
  return path.resolve(String(input?.codexHome || process.env.CODEX_HOME || path.join(os.homedir(), '.codex')))
}

export async function snapshotCodexAppUiState(root: string = process.cwd(), input: { codexHome?: string | null } = {}): Promise<CodexAppUiStateSnapshot> {
  const resolvedRoot = path.resolve(root)
  const home = codexHome(input)
  const files = await snapshotConfigFiles(resolvedRoot, home)
  const authMetadata = await readAuthMetadata(path.join(home, 'auth.json'))
  const authBackupMetadata = await readAuthMetadata(path.join(home, 'auth.chatgpt-backup.json'))
  const appPreferenceFiles = await discoverAppPreferenceFiles(home)
  const sksManagedBlocks = files.flatMap((file) => findSksManagedBlocks(file))
  const projectLocalForbiddenKeys = files.flatMap((file) => file.forbidden_project_local_keys || [])
  const hostOwnedSignals = files.flatMap((file) => file.signals.filter((signal) => signal.host_owned))
  const fastSignals = hostOwnedSignals
    .filter((signal) => signal.fast_ui_related)
    .map((signal) => `${signal.key_path}=${signal.value_preview}`)
  const providerSignals = hostOwnedSignals
    .filter((signal) => signal.provider_related)
    .map((signal) => `${signal.key_path}=${signal.value_preview}`)
  const baseConfigHostOwnedSignals = files
    .filter((file) => !isProfileConfigSnapshotPath(file.path))
    .flatMap((file) => file.signals.filter((signal) => signal.host_owned))
  const activeCodexLbSelection = hasActiveCodexLbProviderSelectionSignals(baseConfigHostOwnedSignals)
  const fastSelectorLocked = baseConfigHostOwnedSignals.some((signal) => {
    if (signal.key_path === 'features.fast_mode' && signal.value_preview === 'false') return true
    if (signal.key_path.startsWith('user.fast_mode') && /hidden|fixed|disabled|false/i.test(signal.value_preview)) return true
    // Active contract-valid codex-lb selection is a provider choice, not a Fast UI lock.
    if (signal.key_path === 'model_provider' && activeCodexLbSelection) return false
    if (SKS_GLOBAL_UI_LOCK_KEYS.has(signal.key_path) && signal.sks_related) return true
    return false
  })
  const authMode = authMetadataMode(authMetadata)
  const chatgptOauthBackupAvailable = authMetadataMode(authBackupMetadata) === 'chatgpt_oauth'
  const chatSurface = authMode === 'chatgpt_oauth' || authMode === 'browser_marker'
    ? 'available'
    : authMode === 'apikey' && chatgptOauthBackupAvailable
      ? 'chatgpt_oauth_inactive'
      : 'unknown'
  return {
    schema: CODEX_APP_UI_STATE_SNAPSHOT_SCHEMA,
    generated_at: nowIso(),
    root: resolvedRoot,
    codex_home: redactHome(home),
    files,
    auth_metadata: authMetadata,
    auth_backup_metadata: authBackupMetadata,
    app_preference_files: appPreferenceFiles,
    sks_managed_blocks: sksManagedBlocks,
    indicators: {
      fast_selector: fastSelectorLocked ? 'maybe_hidden_or_locked' : fastSignals.length ? 'available' : 'unknown',
      fast_selector_signals: fastSignals,
      provider_signals: providerSignals,
      host_owned_signal_count: hostOwnedSignals.length,
      project_local_forbidden_keys: [...new Set(projectLocalForbiddenKeys)],
      secret_leak_suspected: JSON.stringify({ files, authMetadata, authBackupMetadata }).match(/sk-[A-Za-z0-9_-]{16,}|CODEX_LB_API_KEY\s*=\s*["'][^"']+/) != null,
      auth_mode: authMode,
      chatgpt_oauth_backup_available: chatgptOauthBackupAvailable,
      chat_surface: chatSurface
    }
  }
}

export async function writeCodexAppUiSnapshot(root: string, label: string, input: { codexHome?: string | null; reportPath?: string | null } = {}) {
  const snapshot = await snapshotCodexAppUiState(root, input)
  const safeLabel = label.replace(/[^a-z0-9_.-]+/gi, '-').replace(/^-|-$/g, '') || 'snapshot'
  const reportPath = input.reportPath || path.join(path.resolve(root), '.sneakoscope', 'reports', `codex-app-ui-${safeLabel}.json`)
  await writeJsonAtomic(reportPath, snapshot)
  return { ...snapshot, report_path: reportPath }
}

export function diffCodexAppUiSnapshots(before: CodexAppUiStateSnapshot, after: CodexAppUiStateSnapshot) {
  const beforeFingerprint = hostOwnedFingerprint(before)
  const afterFingerprint = hostOwnedFingerprint(after)
  const beforeSet = new Set(beforeFingerprint)
  const afterSet = new Set(afterFingerprint)
  const added = afterFingerprint.filter((entry) => !beforeSet.has(entry))
  const removed = beforeFingerprint.filter((entry) => !afterSet.has(entry))
  const blockers = [
    ...(added.length || removed.length ? ['codex_app_host_owned_state_diff'] : []),
    ...(after.indicators.secret_leak_suspected ? ['codex_app_ui_snapshot_secret_leak_suspected'] : [])
  ]
  return {
    schema: 'sks.codex-app-ui-state-diff.v1',
    generated_at: nowIso(),
    ok: blockers.length === 0,
    host_owned_added: added,
    host_owned_removed: removed,
    before_fast_selector: before.indicators.fast_selector,
    after_fast_selector: after.indicators.fast_selector,
    blockers
  }
}

export function scanTomlSignals(text: string): { signals: CodexAppConfigSignal[]; tables: string[] } {
  const signals: CodexAppConfigSignal[] = []
  const tables: string[] = []
  let table: string | null = null
  const lines = text.split(/\r?\n/)
  lines.forEach((lineText, index) => {
    const tableMatch = lineText.match(/^\s*\[([^\]]+)\]\s*(?:#.*)?$/)
    if (tableMatch?.[1]) {
      table = tableMatch[1].trim()
      tables.push(table)
      return
    }
    const match = lineText.match(/^\s*([A-Za-z0-9_.-]+)\s*=\s*(.+?)\s*(?:#.*)?$/)
    if (!match?.[1] || match[2] == null) return
    const key = match[1].trim()
    const keyPath = table ? `${table}.${key}` : key
    const value = match[2].trim()
    const valuePreview = redactValuePreview(keyPath, value)
    const lowerPath = keyPath.toLowerCase()
    signals.push({
      key_path: keyPath,
      table,
      value_kind: inferValueKind(value),
      value_preview: valuePreview,
      value_hash: sha256(value),
      line: index + 1,
      host_owned: HOST_OWNED_KEY_RE.test(keyPath),
      fast_ui_related: /(?:fast_mode|service_tier|model_reasoning_effort|^model$)/i.test(keyPath) || /(?:fast|priority|default)/i.test(value),
      provider_related: /(?:provider|base_url|auth|profile|openai|chatgpt|codex-lb)/i.test(lowerPath),
      sks_related: /(?:SKS|Sneakoscope|sks-mad|sks fast)/i.test(lineText)
        || (table == null && isSksOwnedGlobalUiLock(lines, index))
    })
  })
  return { signals, tables: [...new Set(tables)] }
}

export function isSksOwnedGlobalUiLock(lines: string[], index: number) {
  const current = String(lines[index] || '')
  const key = current.match(/^\s*([A-Za-z0-9_-]+)\s*=/)?.[1] || ''
  if (!SKS_GLOBAL_UI_LOCK_KEYS.has(key)) return false
  const inlineComment = current.includes('#') ? current.slice(current.indexOf('#')) : ''
  if (isSksGlobalUiLockMarker(inlineComment)) return true
  const lowerBound = Math.max(0, index - 16)
  for (let cursor = index - 1; cursor >= lowerBound; cursor -= 1) {
    const candidate = String(lines[cursor] || '').trim()
    if (!candidate) continue
    if (candidate.startsWith('#')) {
      if (isSksGlobalUiLockMarker(candidate)) return true
      continue
    }
    if (/^\s*\[/.test(candidate)) return false
    const previousKey = candidate.match(/^([A-Za-z0-9_-]+)\s*=/)?.[1] || ''
    if (!SKS_GLOBAL_UI_LOCK_CONTEXT_KEYS.has(previousKey)) return false
  }
  return false
}

function isSksGlobalUiLockMarker(value: string) {
  return /^#\s*(?:SKS|Sneakoscope)\b.*(?:moved machine-local Codex config|forced fast UI|legacy (?:provider|model|reasoning) lock|managed (?:Codex )?(?:provider|model|reasoning)|codex-lb (?:provider|model|reasoning))/i.test(String(value || '').trim())
}

export function scanProjectLocalForbiddenKeys(text: string) {
  const { signals } = scanTomlSignals(text)
  return [...new Set(signals
    .filter((signal) => PROJECT_LOCAL_FORBIDDEN_CODEX_KEYS.some((key) => signal.key_path === key || signal.key_path.startsWith(`${key}.`)))
    .map((signal) => signal.key_path))]
}

async function snapshotConfigFiles(root: string, home: string): Promise<CodexAppUiSnapshotFile[]> {
  const candidates = [
    { file: path.join(home, 'config.toml'), projectLocal: false },
    { file: path.join(root, '.codex', 'config.toml'), projectLocal: true },
    ...(await profileConfigFiles(home)).map((file) => ({ file, projectLocal: false }))
  ]
  const seen = new Set<string>()
  const out: CodexAppUiSnapshotFile[] = []
  for (const candidate of candidates) {
    const file = path.resolve(candidate.file)
    if (seen.has(file)) continue
    seen.add(file)
    const text = await readText(file, null)
    if (text == null) {
      out.push({ path: redactHome(file), exists: false, sha256: null, bytes: 0, signals: [], tables: [] })
      continue
    }
    const parsed = scanTomlSignals(text)
    out.push({
      path: redactHome(file),
      exists: true,
      sha256: sha256(text),
      bytes: Buffer.byteLength(text),
      signals: parsed.signals,
      tables: parsed.tables,
      ...(candidate.projectLocal ? { forbidden_project_local_keys: scanProjectLocalForbiddenKeys(text) } : {})
    })
  }
  return out
}

async function profileConfigFiles(home: string) {
  try {
    const entries = await fs.readdir(home)
    return entries
      .filter((entry) => /^profile-.+\.config\.toml$/.test(entry) || /^[A-Za-z0-9_-]+\.config\.toml$/.test(entry))
      .map((entry) => path.join(home, entry))
      .slice(0, 100)
  } catch {
    return []
  }
}

function isProfileConfigSnapshotPath(file: string) {
  const base = path.basename(file)
  return /^profile-.+\.config\.toml$/.test(base) || /^[A-Za-z0-9_-]+\.config\.toml$/.test(base)
}

async function readAuthMetadata(file: string) {
  const text = await readText(file, null)
  if (text == null) return null
  try {
    const parsed = JSON.parse(text)
    return sanitizeAuthMetadata(parsed)
  } catch {
    return { path: redactHome(file), exists: true, parse_error: true, sha256: sha256(text), bytes: Buffer.byteLength(text) }
  }
}

function sanitizeAuthMetadata(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object') return { type: typeof value }
  const record = value as Record<string, unknown>
  const keys = Object.keys(record).sort()
  const authMode = normalizeAuthMode(record)
  return {
    keys,
    auth_mode: authMode,
    has_chatgpt_auth: authMode === 'chatgpt_oauth' || authMode === 'browser_marker',
    has_api_key_material: authMode === 'apikey',
    redacted: Object.fromEntries(keys.map((key) => [key, SECRET_KEY_RE.test(key) ? '<redacted>' : summarizeMetadataValue(record[key])]))
  }
}

function authMetadataMode(value: Record<string, unknown> | null): 'chatgpt_oauth' | 'apikey' | 'browser_marker' | 'missing' | 'unknown' {
  if (value == null) return 'missing'
  const mode = String(value.auth_mode || '')
  return ['chatgpt_oauth', 'apikey', 'browser_marker'].includes(mode)
    ? mode as 'chatgpt_oauth' | 'apikey' | 'browser_marker'
    : 'unknown'
}

function normalizeAuthMode(record: Record<string, unknown>): 'chatgpt_oauth' | 'apikey' | 'browser_marker' | 'unknown' {
  const rawMode = String(record.auth_mode || record.authMode || record.mode || '').trim().toLowerCase()
  const tokens = record.tokens && typeof record.tokens === 'object' ? record.tokens as Record<string, unknown> : null
  const hasOauthTokens = Boolean(tokens && Object.keys(tokens).some((key) => /access|refresh|id[_-]?token/i.test(key)))
    || Object.keys(record).some((key) => /^(?:access|refresh|id)[_-]?token$/i.test(key))
  const hasApiKey = Object.keys(record).some((key) => /^(?:openai_)?api[_-]?key$|^key$/i.test(key))
  if (/chatgpt|oauth/.test(rawMode) || hasOauthTokens) return 'chatgpt_oauth'
  if (rawMode === 'browser') return 'browser_marker'
  if (/api[-_]?key|apikey/.test(rawMode) || hasApiKey) return 'apikey'
  return 'unknown'
}

function summarizeMetadataValue(value: unknown): unknown {
  if (value == null) return null
  if (Array.isArray(value)) return { type: 'array', length: value.length }
  if (typeof value === 'object') return { type: 'object', keys: Object.keys(value as Record<string, unknown>).sort() }
  if (typeof value === 'string') return value.length > 80 || SECRET_KEY_RE.test(value) ? `<string:${value.length}>` : value
  return value
}

async function discoverAppPreferenceFiles(home: string) {
  const supportDir = path.join(os.homedir(), 'Library', 'Application Support', 'com.openai.codex')
  const candidates = [
    path.join(home, 'settings.json'),
    path.join(home, 'preferences.json'),
    path.join(home, 'features.json'),
    path.join(supportDir, 'settings.json'),
    path.join(supportDir, 'Preferences'),
    path.join(supportDir, 'Local State')
  ]
  const out = []
  for (const file of candidates) {
    const text = await readText(file, null)
    out.push({
      path: redactHome(file),
      exists: text != null || await exists(file),
      sha256: text == null ? null : sha256(text),
      bytes: text == null ? 0 : Buffer.byteLength(text)
    })
  }
  return out
}

function findSksManagedBlocks(file: CodexAppUiSnapshotFile) {
  return file.signals
    .filter((signal) => signal.sks_related)
    .map((signal) => ({ path: file.path, marker: signal.key_path, line: signal.line }))
}

function hostOwnedFingerprint(snapshot: CodexAppUiStateSnapshot) {
  return snapshot.files.flatMap((file) => file.signals
    .filter((signal) => signal.host_owned)
    .map((signal) => `${file.path}:${signal.key_path}:${signal.value_hash}`))
    .sort()
}

function hasActiveCodexLbProviderSelectionSignals(signals: CodexAppConfigSignal[]) {
  const selected = signals.some((signal) => signal.key_path === 'model_provider' && signal.value_preview === 'codex-lb')
  if (!selected) return false
  const has = (key: string, value: string) => signals.some((signal) => (
    signal.key_path === key && signal.value_preview.toLowerCase() === value
  ))
  const present = (key: string) => signals.some((signal) => signal.key_path === key)
  // env_key, env_http_headers, and requires_openai_auth previews are redacted
  // by SECRET_KEY_RE, so the snapshot can validate their shape only by key
  // presence. The repair path performs the stricter value-level validation.
  const cliProviderAuth = present('model_providers.codex-lb.env_key')
    && present('model_providers.codex-lb.requires_openai_auth')
  const desktopCompatAuth = present('model_providers.codex-lb.env_http_headers')
    && present('model_providers.codex-lb.requires_openai_auth')
  return (has('model_providers.codex-lb.name', 'openai') || has('model_providers.codex-lb.name', 'codex-lb'))
    && present('model_providers.codex-lb.base_url')
    && has('model_providers.codex-lb.wire_api', 'responses')
    && (cliProviderAuth || desktopCompatAuth)
}

function redactValuePreview(keyPath: string, value: string) {
  if (SECRET_KEY_RE.test(keyPath)) return '<redacted>'
  if (/^\s*\{/.test(value)) return '<redacted-object>'
  if (/^\s*\[/.test(value)) return '<redacted-array>'
  const normalized = value.replace(/^['"]|['"]$/g, '')
  if (/^[a-z][a-z0-9+.-]*:\/\/[^/@\s]+@/i.test(normalized)) return '<redacted-url-credentials>'
  if (SECRET_KEY_RE.test(normalized)) return '<redacted>'
  return normalized.length > 80 ? `${normalized.slice(0, 77)}...` : normalized
}

function inferValueKind(value: string) {
  if (/^(true|false)$/i.test(value)) return 'boolean'
  if (/^-?\d+(?:\.\d+)?$/.test(value)) return 'number'
  if (/^\[/.test(value)) return 'array'
  if (/^\{/.test(value)) return 'object'
  return 'string'
}

function redactHome(file: string) {
  const home = os.homedir()
  return path.resolve(file).replace(home, '~')
}
