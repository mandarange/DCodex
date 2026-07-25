import fs from 'node:fs/promises'
import path from 'node:path'
import { parse } from 'smol-toml'
import { messageOf } from '../errors/message.js'

export interface CodexConfigRoundTripValidation {
  ok: boolean
  parsed?: Record<string, any> | null
  blockers: string[]
  parse_error?: string
  // Top-level keys that actually drive Codex behavior after the 2026-07 ChatGPT
  // desktop merge. service_tier === 'fast' IS the fast-mode-on signal now.
  service_tier?: string | null
  model?: string | null
  model_reasoning_effort?: string | null
  // Keys the 2026-07 config schema removed (default_profile, [user.fast_mode],
  // [profiles.<name>] tables, notice.fast_default_opt_out). Codex ignores them;
  // SKS strips them on the next normalize pass. Their presence is reported here
  // for migration/diagnostics but is NOT a validation blocker.
  legacy_keys: string[]
}

export function parseCodexConfigToml(text: string = ''): Record<string, any> {
  return parse(String(text || '')) as Record<string, any>
}

export function validateCodexConfigRoundTrip(text: string = ''): CodexConfigRoundTripValidation {
  let parsed: Record<string, any>
  try {
    parsed = parseCodexConfigToml(text)
  } catch (err) {
    return {
      ok: false,
      parsed: null,
      blockers: ['toml_parse_failed'],
      parse_error: messageOf(err),
      legacy_keys: []
    }
  }

  const legacyKeys: string[] = []
  if (parsed.default_profile !== undefined) legacyKeys.push('default_profile')
  if (parsed.user?.fast_mode !== undefined) legacyKeys.push('user.fast_mode')
  if (parsed.profiles !== undefined) legacyKeys.push('profiles')
  if (parsed.notice?.fast_default_opt_out !== undefined) legacyKeys.push('notice.fast_default_opt_out')

  const blockers = modelProviderAuthConflicts(parsed)

  return {
    ok: blockers.length === 0,
    parsed,
    blockers,
    service_tier: typeof parsed.service_tier === 'string' ? parsed.service_tier : null,
    model: typeof parsed.model === 'string' ? parsed.model : null,
    model_reasoning_effort: typeof parsed.model_reasoning_effort === 'string' ? parsed.model_reasoning_effort : null,
    legacy_keys: legacyKeys
  }
}

function modelProviderAuthConflicts(parsed: Record<string, any>): string[] {
  const providers = parsed.model_providers
  if (!providers || typeof providers !== 'object' || Array.isArray(providers)) return []
  return Object.entries(providers).flatMap(([id, value]) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return []
    const provider = value as Record<string, unknown>
    return provider.env_key !== undefined && provider.auth !== undefined
      ? [`model_provider_auth_env_key_conflict:${id}`]
      : []
  })
}

export async function cleanupCodexConfigBackups(configPath: string, opts: { keepPerTag?: number; maxAgeMs?: number } = {}) {
  const keepPerTag = Math.max(0, opts.keepPerTag ?? 3)
  const maxAgeMs = opts.maxAgeMs ?? 30 * 24 * 60 * 60 * 1000
  const dir = path.dirname(configPath)
  const base = path.basename(configPath)
  let entries: string[] = []
  try {
    entries = await fs.readdir(dir)
  } catch {
    return { cleaned: 0, files: [] as string[] }
  }
  const now = Date.now()
  const groups = new Map<string, Array<{ file: string; abs: string; mtimeMs: number }>>()
  for (const file of entries) {
    const tag = ownedBackupTag(base, file)
    if (!tag) continue
    const abs = path.join(dir, file)
    let stat
    try {
      stat = await fs.stat(abs)
    } catch {
      continue
    }
    if (!stat.isFile()) continue
    const group = groups.get(tag) || []
    group.push({ file, abs, mtimeMs: stat.mtimeMs })
    groups.set(tag, group)
  }
  const removed: string[] = []
  for (const group of groups.values()) {
    group.sort((a, b) => b.mtimeMs - a.mtimeMs)
    for (let index = 0; index < group.length; index += 1) {
      const entry = group[index]
      if (!entry) continue
      const tooMany = keepPerTag >= 0 && index >= keepPerTag
      const tooOld = maxAgeMs >= 0 && now - entry.mtimeMs > maxAgeMs
      if (!tooMany && !tooOld) continue
      await fs.rm(entry.abs, { force: true }).then(() => removed.push(entry.abs)).catch(() => undefined)
    }
  }
  return { cleaned: removed.length, files: removed }
}

function ownedBackupTag(base: string, file: string): string | null {
  if (!file.startsWith(`${base}.`)) return null
  const suffix = file.slice(`${base}.`.length)
  if (/^sks-[A-Za-z0-9_.-]+\.bak$/.test(suffix)) {
    const group = suffix.match(/^sks-([^-]+)-/)?.[1] || suffix.slice('sks-'.length, -'.bak'.length)
    return `sks-${group}`
  }
  if (/^struct-bak-[A-Za-z0-9_.-]+$/.test(suffix)) return 'struct-bak'
  if (/^bak-[A-Za-z0-9_.-]+$/.test(suffix)) return 'bak'
  if (/^codex-app-ui-repair-[A-Za-z0-9_.-]+\.bak$/.test(suffix)) return 'codex-app-ui-repair'
  return null
}
