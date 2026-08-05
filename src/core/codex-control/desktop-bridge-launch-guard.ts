import os from 'node:os'
import path from 'node:path'
import { parseCodexConfigToml } from '../codex/codex-config-toml.js'
import { readText, type RunProcessResult } from '../fsx.js'

export const DESKTOP_BRIDGE_LAUNCH_GUARD_SCHEMA = 'sks.desktop-bridge-launch-guard.v1' as const
export const DESKTOP_BRIDGE_DIRECT_PROVIDER_SELECTION_RETIRED =
  'desktop_bridge_direct_provider_selection_retired' as const

export type DesktopBridgeLaunchGuardStatus =
  | 'allowed'
  | 'direct_provider_selection_retired'
  | 'config_parse_blocked'
  | 'working_root_blocked'

export interface DesktopBridgeLaunchGuard {
  schema: typeof DESKTOP_BRIDGE_LAUNCH_GUARD_SCHEMA
  ok: boolean
  status: DesktopBridgeLaunchGuardStatus
  selected_provider: string | null
  blockers: string[]
  warnings: string[]
  operator_actions: string[]
}

export interface DesktopBridgeCliLaunchGuardInput {
  root: string
  env?: NodeJS.ProcessEnv
  cliArgs?: readonly unknown[]
}

export type DesktopBridgeGuardedLaunchResult<T> =
  | { launched: false; desktopBridgeLaunchGuard: DesktopBridgeLaunchGuard; value: null }
  | { launched: true; desktopBridgeLaunchGuard: DesktopBridgeLaunchGuard; value: T }

export function inspectDesktopBridgeSdkLaunchGuard(input: {
  config: Record<string, unknown>
  env?: NodeJS.ProcessEnv | Record<string, string>
}): DesktopBridgeLaunchGuard {
  return guardForSelectedProvider(stringValue(input.config.model_provider))
}

export async function inspectDesktopBridgeCliLaunchGuard(
  input: DesktopBridgeCliLaunchGuardInput
): Promise<DesktopBridgeLaunchGuard> {
  const env = input.env || process.env
  const args = (input.cliArgs || []).map((arg) => String(arg))
  if (args.includes('--oss')) return allowedGuard(null)

  const effectiveRoot = effectiveCodexWorkingRoot(input.root, args)
  if (!effectiveRoot.ok) {
    return blockedGuard('working_root_blocked', null, effectiveRoot.blockers)
  }
  const codexHome = path.resolve(String(env.CODEX_HOME || path.join(env.HOME || os.homedir(), '.codex')))
  const ignoreUserConfig = args.includes('--ignore-user-config')
  const profileName = ignoreUserConfig ? null : cliOptionValue(args, ['--profile', '-p', '-P'])
  const profileConfigPath = profileName && safeProfileName(profileName)
    ? path.join(codexHome, `${profileName}.config.toml`)
    : null
  const userConfig = ignoreUserConfig
    ? configLayer('', 'user')
    : configLayer(await readText(path.join(codexHome, 'config.toml'), '').catch(() => ''), 'user')
  const profileConfig = profileConfigPath
    ? configLayer(await readText(profileConfigPath, '').catch(() => ''), 'profile')
    : configLayer('', 'profile')
  const projectConfigPath = path.join(effectiveRoot.root, '.codex', 'config.toml')
  const projectConfig = path.resolve(projectConfigPath) === path.resolve(path.join(codexHome, 'config.toml'))
    ? configLayer('', 'project')
    : configLayer(await readText(projectConfigPath, '').catch(() => ''), 'project')
  const override = cliModelProviderOverride(args)
  const layers = [userConfig, profileConfig, projectConfig]

  const selectedProvider = projectConfig.modelProvider
    ?? profileConfig.modelProvider
    ?? userConfig.modelProvider
    ?? null
  const parseBlockers = layers
    .filter((layer) => layer.parseFailed && layer.rawSelectsRetiredProvider)
    .map((layer) => `desktop_bridge_launch_config_parse_failed:${layer.source}`)
  if (parseBlockers.length > 0) {
    return blockedGuard('config_parse_blocked', selectedProvider, parseBlockers)
  }
  const historicalSelection = layers
    .map((layer) => layer.modelProvider)
    .find((provider) => provider === 'codex-lb' || provider === 'openrouter')
  if (historicalSelection) return guardForSelectedProvider(historicalSelection)
  return guardForSelectedProvider(override ?? selectedProvider)
}

export async function withDesktopBridgeCliLaunchGuard<T>(
  input: DesktopBridgeCliLaunchGuardInput,
  launch: (sanitizedEnv: NodeJS.ProcessEnv) => Promise<T>
): Promise<DesktopBridgeGuardedLaunchResult<T>> {
  const sanitizedEnv = stripRetiredDirectProviderEnv(input.env || process.env)
  const desktopBridgeLaunchGuard = await inspectDesktopBridgeCliLaunchGuard({
    ...input,
    env: sanitizedEnv
  })
  if (!desktopBridgeLaunchGuard.ok) {
    return { launched: false, desktopBridgeLaunchGuard, value: null }
  }
  return {
    launched: true,
    desktopBridgeLaunchGuard,
    value: await launch(sanitizedEnv)
  }
}

export function stripRetiredDirectProviderEnv(
  env: NodeJS.ProcessEnv | Record<string, string | undefined>
): NodeJS.ProcessEnv {
  const sanitized: NodeJS.ProcessEnv = { ...env }
  for (const key of Object.keys(sanitized)) {
    if (/^CODEX_LB_/i.test(key)) delete sanitized[key]
  }
  return sanitized
}

export function desktopBridgeLaunchBlockedProcessResult(
  guard: DesktopBridgeLaunchGuard
): RunProcessResult & { desktop_bridge_launch_guard: DesktopBridgeLaunchGuard } {
  const stderr = desktopBridgeLaunchBlockedMessage(guard)
  return {
    code: 78,
    stdout: '',
    stderr,
    stdoutBytes: 0,
    stderrBytes: Buffer.byteLength(stderr),
    truncated: false,
    timedOut: false,
    desktop_bridge_launch_guard: guard
  }
}

export function desktopBridgeLaunchBlockedMessage(guard: DesktopBridgeLaunchGuard): string {
  return [
    'Codex launch blocked: direct provider selection is retired; managed routing must use Desktop Bridge.',
    ...guard.blockers.map((blocker) => `blocker: ${blocker}`),
    ...guard.operator_actions
  ].join('\n')
}

export function effectiveCodexWorkingRoot(
  fallbackRoot: string,
  args: string[]
): { ok: true; root: string; blockers: string[] } | { ok: false; root: string; blockers: string[] } {
  const base = path.resolve(fallbackRoot)
  let selected: string | null = null
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] || ''
    if (arg === '--') break
    if (arg === '-C' || arg === '--cd') {
      const next = String(args[index + 1] || '').trim()
      if (!next || next.startsWith('-')) {
        return { ok: false, root: base, blockers: ['desktop_bridge_launch_working_root_value_missing'] }
      }
      selected = next
      index += 1
      continue
    }
    if (arg.startsWith('--cd=') || arg.startsWith('-C=')) {
      const value = arg.slice(arg.indexOf('=') + 1).trim()
      if (!value) {
        return { ok: false, root: base, blockers: ['desktop_bridge_launch_working_root_value_missing'] }
      }
      selected = value
    }
  }
  return { ok: true, root: selected ? path.resolve(base, selected) : base, blockers: [] }
}

interface ParsedConfigLayer {
  source: 'user' | 'profile' | 'project'
  modelProvider: string | null
  parseFailed: boolean
  rawSelectsRetiredProvider: boolean
}

function configLayer(text: string, source: ParsedConfigLayer['source']): ParsedConfigLayer {
  const raw = String(text || '')
  if (!raw.trim()) {
    return { source, modelProvider: null, parseFailed: false, rawSelectsRetiredProvider: false }
  }
  try {
    const parsed = parseCodexConfigToml(raw)
    return {
      source,
      modelProvider: stringValue(parsed.model_provider),
      parseFailed: false,
      rawSelectsRetiredProvider: false
    }
  } catch {
    return {
      source,
      modelProvider: null,
      parseFailed: true,
      rawSelectsRetiredProvider: /^\s*model_provider\s*=\s*(?:"(?:codex-lb|openrouter)"|'(?:codex-lb|openrouter)'|(?:codex-lb|openrouter))\s*(?:#.*)?$/mi.test(raw)
    }
  }
}

function cliModelProviderOverride(args: string[]): string | null {
  let modelProvider: string | null = null
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] || ''
    let override: string | null = null
    if (arg === '-c' || arg === '--config') {
      override = args[index + 1] || ''
      index += 1
    } else if (arg.startsWith('--config=')) override = arg.slice('--config='.length)
    else if (arg.startsWith('-c=')) override = arg.slice(3)
    if (!override) continue
    const equals = override.indexOf('=')
    if (equals < 1 || normalizeDottedKey(override.slice(0, equals)) !== 'model_provider') continue
    modelProvider = stringValue(parseCliTomlValue(override.slice(equals + 1)))
  }
  return modelProvider
}

function parseCliTomlValue(raw: string): unknown {
  try {
    return parseCodexConfigToml(`value = ${raw}\n`).value
  } catch {
    return String(raw || '').trim()
  }
}

function guardForSelectedProvider(selectedProvider: string | null): DesktopBridgeLaunchGuard {
  if (selectedProvider !== 'codex-lb' && selectedProvider !== 'openrouter') {
    return allowedGuard(selectedProvider)
  }
  return blockedGuard(
    'direct_provider_selection_retired',
    selectedProvider,
    [DESKTOP_BRIDGE_DIRECT_PROVIDER_SELECTION_RETIRED]
  )
}

function allowedGuard(selectedProvider: string | null): DesktopBridgeLaunchGuard {
  return {
    schema: DESKTOP_BRIDGE_LAUNCH_GUARD_SCHEMA,
    ok: true,
    status: 'allowed',
    selected_provider: selectedProvider,
    blockers: [],
    warnings: [],
    operator_actions: []
  }
}

function blockedGuard(
  status: Exclude<DesktopBridgeLaunchGuardStatus, 'allowed'>,
  selectedProvider: string | null,
  blockers: string[]
): DesktopBridgeLaunchGuard {
  return {
    schema: DESKTOP_BRIDGE_LAUNCH_GUARD_SCHEMA,
    ok: false,
    status,
    selected_provider: selectedProvider,
    blockers,
    warnings: ['historical_direct_provider_selection_requires_bridge_migration'],
    operator_actions: [
      'Run `sks bridge ensure --json` to migrate SKS-owned routing to the managed Desktop Bridge.',
      'If the direct provider selection is user-owned, review and remove it manually before retrying.'
    ]
  }
}

function cliOptionValue(args: string[], names: string[]): string | null {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] || ''
    if (names.includes(arg)) return String(args[index + 1] || '').trim() || null
    for (const name of names) {
      if (arg.startsWith(`${name}=`)) return arg.slice(name.length + 1).trim() || null
    }
  }
  return null
}

function safeProfileName(value: string): boolean {
  return /^[A-Za-z0-9_.-]{1,128}$/.test(value)
}

function normalizeDottedKey(value: string): string {
  return String(value || '').trim().replace(/["']/g, '').replace(/\s+/g, '')
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}
