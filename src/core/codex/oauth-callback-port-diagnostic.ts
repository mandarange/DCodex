import {
  runProcess,
  type RunProcessOptions,
  type RunProcessResult
} from '../fsx.js'

export const CODEX_OAUTH_CALLBACK_PORT = 1455
export const OAUTH_CALLBACK_RECOVERY_GUIDANCE = 'If the OAuth callback ends on a dead page, replace localhost with 127.0.0.1 in the address bar and retry immediately; the authorization code is short-lived and one-time.'

const DEFAULT_TIMEOUT_MS = 1_500
const MAX_OUTPUT_BYTES = 64 * 1024
const LSOF_ARGS = ['-nP', `-iTCP:${CODEX_OAUTH_CALLBACK_PORT}`, '-sTCP:LISTEN'] as const

export type OAuthCallbackDiagnosticRunner = (
  command: string,
  args: readonly string[],
  options: RunProcessOptions
) => Promise<RunProcessResult>

export type OAuthCallbackListenerScope = 'loopback_ipv4' | 'wildcard' | 'ipv6' | 'other'

export interface OAuthCallbackListener {
  command: string
  pid: number
  address: string
  scope: OAuthCallbackListenerScope
}

export interface OAuthCallbackPortDiagnostic {
  schema: 'sks.codex-oauth-callback-port-diagnostic.v1'
  port: typeof CODEX_OAUTH_CALLBACK_PORT
  status: 'clear' | 'conflict' | 'unavailable' | 'timeout' | 'probe_failed'
  available: boolean
  conflict: boolean
  listeners: OAuthCallbackListener[]
  warnings: string[]
}

export async function inspectOAuthCallbackPortConflict(input: {
  run?: OAuthCallbackDiagnosticRunner
  timeoutMs?: number
} = {}): Promise<OAuthCallbackPortDiagnostic> {
  const execute = input.run || runProcess
  let result: RunProcessResult
  try {
    result = await execute('lsof', LSOF_ARGS, {
      timeoutMs: Math.max(1, Math.min(input.timeoutMs ?? DEFAULT_TIMEOUT_MS, DEFAULT_TIMEOUT_MS)),
      maxOutputBytes: MAX_OUTPUT_BYTES
    })
  } catch (error: unknown) {
    return diagnostic(isUnavailableError(error) ? 'unavailable' : 'probe_failed')
  }

  if (result.timedOut) return diagnostic('timeout')
  if (result.code === -1 && isUnavailableError(result.stderr)) return diagnostic('unavailable')

  const listeners = parseLsofListeners(result.stdout)
  if (result.code !== 0 && listeners.length === 0) {
    // lsof exits 1 when its selection matches no open files.
    if (result.code === 1 && String(result.stdout || '').trim() === '' && String(result.stderr || '').trim() === '') {
      return diagnostic('clear')
    }
    return diagnostic(result.code === -1 ? 'unavailable' : 'probe_failed')
  }

  const loopbackCodex = listeners.filter((listener) => (
    listener.scope === 'loopback_ipv4'
    && isCodexProcessName(listener.command)
  ))
  const competing = listeners.filter((listener) => (
    listener.scope === 'wildcard' || listener.scope === 'ipv6'
  ))
  const conflict = loopbackCodex.some((codexListener) => (
    competing.some((listener) => listener.pid !== codexListener.pid)
  ))
  return {
    ...diagnostic(conflict ? 'conflict' : 'clear'),
    listeners,
    warnings: conflict ? ['oauth_callback_port_1455_conflict'] : []
  }
}

export function oauthCallbackRecoveryGuidance(
  failureOutput: string,
  diagnosticResult: Pick<OAuthCallbackPortDiagnostic, 'conflict'>
): string[] {
  return diagnosticResult.conflict && isCodexAuthenticationFailure(failureOutput)
    ? [OAUTH_CALLBACK_RECOVERY_GUIDANCE]
    : []
}

export function oauthCallbackDoctorGuidance(
  diagnosticResult: Pick<OAuthCallbackPortDiagnostic, 'conflict'>
): string[] {
  return diagnosticResult.conflict ? [OAUTH_CALLBACK_RECOVERY_GUIDANCE] : []
}

export function isCodexAuthenticationFailure(output: string): boolean {
  return /(?:not\s+(?:logged|signed)\s+in|not\s+authenticated|authentication\s+(?:is\s+)?required|login\s+required|please\s+(?:run\s+)?(?:codex\s+)?log\s*in|unauthenticated|unauthorized|http\s*401|\b401\s+unauthorized\b)/i
    .test(String(output || ''))
}

function parseLsofListeners(output: string): OAuthCallbackListener[] {
  const listeners = new Map<string, OAuthCallbackListener>()
  for (const line of String(output || '').split(/\r?\n/)) {
    const match = line.match(/^(\S+)\s+(\d+)\s+.*?\bTCP\s+(.+?)\s+\(LISTEN\)\s*$/)
    if (!match) continue
    const command = safeProcessName(match[1])
    const pid = Number(match[2])
    const address = safeListenerAddress(match[3])
    if (!command || !Number.isSafeInteger(pid) || pid <= 0 || !address) continue
    const listener = {
      command,
      pid,
      address,
      scope: listenerScope(address)
    }
    listeners.set(listenerKey(listener), listener)
  }
  return [...listeners.values()]
}

function listenerScope(address: string): OAuthCallbackListenerScope {
  if (address === `127.0.0.1:${CODEX_OAUTH_CALLBACK_PORT}`) return 'loopback_ipv4'
  if (
    address === `*:${CODEX_OAUTH_CALLBACK_PORT}`
    || address === `0.0.0.0:${CODEX_OAUTH_CALLBACK_PORT}`
    || address === `:::${CODEX_OAUTH_CALLBACK_PORT}`
    || address === `[::]:${CODEX_OAUTH_CALLBACK_PORT}`
  ) {
    return 'wildcard'
  }
  const colonCount = address.match(/:/g)?.length || 0
  if ((address.startsWith('[') || colonCount >= 2) && /(?:^|:|\])1455$/.test(address)) return 'ipv6'
  return 'other'
}

function safeProcessName(value: string | undefined): string {
  const name = String(value || '').trim()
  return name.length <= 64 && /^[A-Za-z0-9._+-]+$/.test(name) ? name : ''
}

function safeListenerAddress(value: string | undefined): string {
  const address = String(value || '').trim()
  return address.length <= 96 && /^[0-9A-Fa-f.*:[\]-]+$/.test(address) ? address : ''
}

function isCodexProcessName(command: string): boolean {
  const normalized = command.toLowerCase()
  if (normalized === 'codex') return true
  const appServerName = 'codex-app-server'
  return normalized.length >= 'codex-app'.length
    && normalized.length <= appServerName.length
    && appServerName.startsWith(normalized)
}

function listenerKey(listener: Pick<OAuthCallbackListener, 'command' | 'pid' | 'address'>): string {
  return `${listener.command}:${listener.pid}:${listener.address}`
}

function isUnavailableError(error: unknown): boolean {
  const text = error instanceof Error ? `${error.name} ${error.message}` : String(error || '')
  return /\bENOENT\b|not found|no such file or directory/i.test(text)
}

function diagnostic(status: OAuthCallbackPortDiagnostic['status']): OAuthCallbackPortDiagnostic {
  return {
    schema: 'sks.codex-oauth-callback-port-diagnostic.v1',
    port: CODEX_OAUTH_CALLBACK_PORT,
    status,
    available: !['unavailable', 'timeout', 'probe_failed'].includes(status),
    conflict: status === 'conflict',
    listeners: [],
    warnings: []
  }
}
