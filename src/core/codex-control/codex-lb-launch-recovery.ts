import os from 'node:os'
import path from 'node:path'
import { parseCodexConfigToml } from '../codex/codex-config-toml.js'
import {
  readText,
  type RunProcessResult
} from '../fsx.js'
import {
  codexLbToolOutputRecoveryNotChecked,
  codexLbToolOutputRecoveryNotSelected,
  codexLbToolOutputRecoveryOverrideAcknowledged,
  probeCodexLbToolOutputRecovery,
  type CodexLbToolOutputRecoveryProbe
} from '../codex-lb/codex-lb-tool-output-recovery.js'
import { normalizeCodexLbBaseUrl } from '../codex-lb/codex-lb-env.js'

export interface CodexLbCliLaunchRecoveryInput {
  root: string
  env?: NodeJS.ProcessEnv
  cliArgs?: readonly unknown[]
  fetchImpl?: typeof fetch
  timeoutMs?: number
  allowUnverified?: boolean
  verifiedProbe?: CodexLbToolOutputRecoveryProbe
}

export type CodexLbGuardedLaunchResult<T> =
  | {
      launched: false
      toolOutputRecovery: CodexLbToolOutputRecoveryProbe
      value: null
    }
  | {
      launched: true
      toolOutputRecovery: CodexLbToolOutputRecoveryProbe
      value: T
    }

export async function inspectCodexLbSdkLaunchRecovery(input: {
  config: Record<string, unknown>
  env: NodeJS.ProcessEnv | Record<string, string>
  overrideEnv?: NodeJS.ProcessEnv
  fetchImpl?: typeof fetch
  timeoutMs?: number
}): Promise<CodexLbToolOutputRecoveryProbe> {
  if (String(input.config.model_provider || '') !== 'codex-lb') {
    return codexLbToolOutputRecoveryNotSelected()
  }
  const providers = input.config.model_providers as Record<string, any> | undefined
  const baseUrl = String(
    providers?.['codex-lb']?.base_url
    || input.env.CODEX_LB_BASE_URL
    || ''
  )
  return probeCodexLbToolOutputRecovery({
    baseUrl,
    ...(input.fetchImpl ? { fetchImpl: input.fetchImpl } : {}),
    ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
    allowUnverified: codexLbToolOutputRecoveryOverrideAcknowledged({
      env: input.overrideEnv || input.env as NodeJS.ProcessEnv
    })
  })
}

export async function inspectCodexLbCliLaunchRecovery(
  input: CodexLbCliLaunchRecoveryInput
): Promise<CodexLbToolOutputRecoveryProbe> {
  const env = input.env || process.env
  const args = (input.cliArgs || []).map((arg) => String(arg))
  const codexHome = path.resolve(String(env.CODEX_HOME || path.join(env.HOME || os.homedir(), '.codex')))
  const userConfigPath = path.join(codexHome, 'config.toml')
  const effectiveRoot = effectiveCodexWorkingRoot(input.root, args)
  if (!effectiveRoot.ok) return configParseBlocked(effectiveRoot.blockers)
  const projectConfigPath = path.join(effectiveRoot.root, '.codex', 'config.toml')
  const ignoreUserConfig = args.includes('--ignore-user-config')
  const profileName = ignoreUserConfig ? null : cliOptionValue(args, ['--profile', '-p', '-P'])
  const profileConfigPath = profileName && safeProfileName(profileName)
    ? path.join(codexHome, `${profileName}.config.toml`)
    : null
  const userConfig = ignoreUserConfig
    ? configLayer('', 'user')
    : configLayer(await readText(userConfigPath, '').catch(() => ''), 'user')
  const profileConfig = profileConfigPath
    ? configLayer(await readText(profileConfigPath, '').catch(() => ''), 'profile')
    : configLayer('', 'profile')
  const projectConfig = path.resolve(projectConfigPath) === path.resolve(userConfigPath)
    ? configLayer('', 'project')
    : configLayer(await readText(projectConfigPath, '').catch(() => ''), 'project')
  const overrides = cliConfigOverrides(args)
  const environmentSelectsCodexLb = env.SKS_PROVIDER === 'codex-lb' || env.SKS_USE_CODEX_LB === '1'

  // Local-provider CLI options are the final operator intent.
  if (cliSelectsLocalProvider(args)) {
    return codexLbToolOutputRecoveryNotSelected()
  }

  const loadedLayers = [userConfig, profileConfig, projectConfig]
  const parseBlockers = loadedLayers
    .filter((layer) => layer.parseFailed && layer.rawSelectsCodexLb)
    .map((layer) => `codex_lb_launch_config_parse_failed:${layer.source}`)
  if (parseBlockers.length > 0) return configParseBlocked(parseBlockers)

  if (projectConfig.hasMachineLocalProviderConfig) {
    return projectProviderConfigBlocked()
  }

  // Explicit model-provider overrides still win over user/profile defaults,
  // but only after repository-local provider redirects have been rejected.
  if (overrides.modelProvider && overrides.modelProvider !== 'codex-lb') {
    return codexLbToolOutputRecoveryNotSelected()
  }

  const selectedProvider = overrides.modelProvider
    ?? (environmentSelectsCodexLb ? 'codex-lb' : null)
    ?? profileConfig.modelProvider
    ?? userConfig.modelProvider
    ?? ''
  if (selectedProvider !== 'codex-lb') {
    return codexLbToolOutputRecoveryNotSelected()
  }
  const codexProcessSelectsCodexLb = overrides.modelProvider === 'codex-lb'
    || profileConfig.modelProvider === 'codex-lb'
    || userConfig.modelProvider === 'codex-lb'
  if (environmentSelectsCodexLb && !codexProcessSelectsCodexLb) {
    return environmentSelectionNotForwardedBlocked()
  }

  const baseUrl = overrides.baseUrl
    ?? profileConfig.baseUrl
    ?? userConfig.baseUrl
    ?? String(env.CODEX_LB_BASE_URL || '')
  const verifiedProbe = reusableVerifiedProbeForBase(input.verifiedProbe, baseUrl)
  if (verifiedProbe) return verifiedProbe
  return probeCodexLbToolOutputRecovery({
    baseUrl,
    ...(input.fetchImpl ? { fetchImpl: input.fetchImpl } : {}),
    ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
    allowUnverified: input.allowUnverified === true
      || codexLbToolOutputRecoveryOverrideAcknowledged({ args, env })
  })
}

function reusableVerifiedProbeForBase(
  value: CodexLbToolOutputRecoveryProbe | undefined,
  selectedBaseUrl: string
): CodexLbToolOutputRecoveryProbe | null {
  if (!value || value.schema !== 'sks.codex-lb-tool-output-recovery.v1') return null
  if (value.ok !== true || value.required !== true || value.verified !== true || value.supports_interrupted_tool_output_recovery !== true) return null
  const verifiedBaseUrl = normalizeCodexLbBaseUrl(value.base_url)
  const effectiveBaseUrl = normalizeCodexLbBaseUrl(selectedBaseUrl)
  if (!verifiedBaseUrl || !effectiveBaseUrl || verifiedBaseUrl !== effectiveBaseUrl) return null
  return value
}

export async function withCodexLbCliLaunchRecovery<T>(
  input: CodexLbCliLaunchRecoveryInput,
  launch: () => Promise<T>
): Promise<CodexLbGuardedLaunchResult<T>> {
  const toolOutputRecovery = await inspectCodexLbCliLaunchRecovery(input)
  if (!toolOutputRecovery.ok) {
    return {
      launched: false,
      toolOutputRecovery,
      value: null
    }
  }
  return {
    launched: true,
    toolOutputRecovery,
    value: await launch()
  }
}

export function codexLbRecoveryBlockedProcessResult(
  probe: CodexLbToolOutputRecoveryProbe
): RunProcessResult & { codexLbToolOutputRecovery: CodexLbToolOutputRecoveryProbe } {
  const stderr = codexLbRecoveryBlockedMessage(probe)
  return {
    code: 78,
    stdout: '',
    stderr,
    stdoutBytes: 0,
    stderrBytes: Buffer.byteLength(stderr),
    truncated: false,
    timedOut: false,
    codexLbToolOutputRecovery: probe
  }
}

export function codexLbRecoveryBlockedMessage(probe: CodexLbToolOutputRecoveryProbe): string {
  if (probe.blockers.includes('codex_lb_launch_selection_not_forwarded')) {
    return [
      'Codex launch blocked: codex-lb was requested by the SKS environment but was not selected in the Codex process.',
      ...probe.blockers.map((blocker) => `blocker: ${blocker}`),
      ...probe.operator_actions
    ].join('\n')
  }
  return [
    'Codex launch blocked: selected codex-lb interrupted tool-output recovery is not verified.',
    ...probe.blockers.map((blocker) => `blocker: ${blocker}`),
    ...probe.operator_actions
  ].join('\n')
}

interface ParsedConfigLayer {
  source: 'user' | 'profile' | 'project'
  modelProvider: string | null
  baseUrl: string | null
  parseFailed: boolean
  rawSelectsCodexLb: boolean
  hasMachineLocalProviderConfig: boolean
}

function configLayer(text: string, source: ParsedConfigLayer['source']): ParsedConfigLayer {
  const raw = String(text || '')
  if (!raw.trim()) {
    return {
      source,
      modelProvider: null,
      baseUrl: null,
      parseFailed: false,
      rawSelectsCodexLb: false,
      hasMachineLocalProviderConfig: false
    }
  }
  try {
    const parsed = parseCodexConfigToml(raw)
    return {
      source,
      modelProvider: stringValue(parsed.model_provider),
      baseUrl: stringValue(parsed.model_providers?.['codex-lb']?.base_url),
      parseFailed: false,
      rawSelectsCodexLb: false,
      hasMachineLocalProviderConfig: source === 'project' && Boolean(
        stringValue(parsed.model_provider)
        || (parsed.model_providers && typeof parsed.model_providers === 'object' && Object.keys(parsed.model_providers).length)
        || stringValue(parsed.openai_base_url)
        || stringValue(parsed.chatgpt_base_url)
      )
    }
  } catch {
    return {
      source,
      modelProvider: null,
      baseUrl: null,
      parseFailed: true,
      rawSelectsCodexLb: /^\s*model_provider\s*=\s*(?:"codex-lb"|'codex-lb'|codex-lb)\s*(?:#.*)?$/mi.test(raw),
      hasMachineLocalProviderConfig: source === 'project' && /^\s*(?:model_provider|openai_base_url|chatgpt_base_url)\s*=|^\s*\[model_providers(?:\.|\])/mi.test(raw)
    }
  }
}

function cliConfigOverrides(args: string[]): { modelProvider: string | null; baseUrl: string | null } {
  let modelProvider: string | null = null
  let baseUrl: string | null = null
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] || ''
    let override: string | null = null
    if (arg === '-c' || arg === '--config') {
      override = args[index + 1] || ''
      index += 1
    } else if (arg.startsWith('--config=')) {
      override = arg.slice('--config='.length)
    } else if (arg.startsWith('-c=')) {
      override = arg.slice(3)
    }
    if (!override) continue
    const equals = override.indexOf('=')
    if (equals < 1) continue
    const key = normalizeDottedKey(override.slice(0, equals))
    const value = parseCliTomlValue(override.slice(equals + 1))
    if (key === 'model_provider') modelProvider = stringValue(value)
    if (key === 'model_providers.codex-lb.base_url') baseUrl = stringValue(value)
    if (key === 'model_providers.codex-lb' && value && typeof value === 'object') {
      baseUrl = stringValue((value as Record<string, unknown>).base_url) ?? baseUrl
    }
    if (key === 'model_providers' && value && typeof value === 'object') {
      baseUrl = stringValue((value as any)?.['codex-lb']?.base_url) ?? baseUrl
    }
  }
  return { modelProvider, baseUrl }
}

function parseCliTomlValue(raw: string): unknown {
  try {
    return parseCodexConfigToml(`value = ${raw}\n`).value
  } catch {
    return String(raw || '').trim()
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

function cliSelectsLocalProvider(args: string[]) {
  return args.includes('--oss')
}

export function effectiveCodexWorkingRoot(fallbackRoot: string, args: string[]): { ok: true; root: string; blockers: string[] } | { ok: false; root: string; blockers: string[] } {
  const base = path.resolve(fallbackRoot)
  let selected: string | null = null
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] || ''
    if (arg === '--') break
    if (arg === '-C' || arg === '--cd') {
      const next = String(args[index + 1] || '').trim()
      if (!next || next.startsWith('-')) {
        return { ok: false, root: base, blockers: ['codex_lb_launch_working_root_value_missing'] }
      }
      selected = next
      index += 1
      continue
    }
    if (arg.startsWith('--cd=') || arg.startsWith('-C=')) {
      const value = arg.slice(arg.indexOf('=') + 1).trim()
      if (!value) return { ok: false, root: base, blockers: ['codex_lb_launch_working_root_value_missing'] }
      selected = value
    }
  }
  return {
    ok: true,
    root: selected ? path.resolve(base, selected) : base,
    blockers: []
  }
}

function safeProfileName(value: string) {
  return /^[A-Za-z0-9_.-]{1,128}$/.test(value)
}

function normalizeDottedKey(value: string) {
  return String(value || '').trim().replace(/["']/g, '').replace(/\s+/g, '')
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function configParseBlocked(blockers: string[]): CodexLbToolOutputRecoveryProbe {
  const base = codexLbToolOutputRecoveryNotChecked(true)
  return {
    ...base,
    status: 'version_unverified',
    blockers,
    warnings: ['selected_codex_lb_config_could_not_be_parsed_safely'],
    operator_actions: [
      'Repair the selected Codex config TOML, then rerun `sks codex-lb status`.',
      ...base.operator_actions
    ]
  }
}

function projectProviderConfigBlocked(): CodexLbToolOutputRecoveryProbe {
  const base = codexLbToolOutputRecoveryNotChecked(true)
  return {
    ...base,
    status: 'version_unverified',
    blockers: ['codex_lb_launch_project_provider_config_forbidden'],
    warnings: ['machine_local_provider_config_must_live_in_codex_home'],
    operator_actions: [
      'Run `sks doctor --fix` to move or remove machine-local provider settings from the project `.codex/config.toml`.',
      'Rerun `sks codex-lb status` before launching Codex.',
      ...base.operator_actions
    ]
  }
}

function environmentSelectionNotForwardedBlocked(): CodexLbToolOutputRecoveryProbe {
  const base = codexLbToolOutputRecoveryNotChecked(true)
  return {
    ...base,
    status: 'version_unverified',
    blockers: ['codex_lb_launch_selection_not_forwarded'],
    warnings: ['sks_provider_environment_does_not_select_the_codex_process_provider'],
    operator_actions: [
      `Launch Codex with \`--config model_provider='"codex-lb"'\`, or select codex-lb in the active Codex profile.`,
      'Rerun `sks codex-lb status` before launching Codex.'
    ]
  }
}
