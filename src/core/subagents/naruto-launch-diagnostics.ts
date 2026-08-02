import { uniqueStrings } from '../text/strings.js'

export function attachNarutoLaunchDiagnostics(summary: any, run: any) {
  return {
    ...summary,
    operator_actions: normalizedNarutoOperatorActions(run?.operator_actions),
    oauth_callback_port_diagnostic: publicOAuthCallbackPortDiagnostic(run?.oauth_callback_port_diagnostic)
  }
}

export function normalizedNarutoOperatorActions(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return uniqueStrings(value
    .map((item) => String(item || '').trim())
    .filter((item) => item.length > 0 && item.length <= 1_000 && !/[\r\n]/.test(item)))
}

function publicOAuthCallbackPortDiagnostic(value: any) {
  if (!value || value.schema !== 'sks.codex-oauth-callback-port-diagnostic.v1') return null
  return {
    schema: 'sks.codex-oauth-callback-port-diagnostic.v1',
    port: value.port,
    status: value.status,
    available: value.available === true,
    conflict: value.conflict === true,
    listeners: Array.isArray(value.listeners)
      ? value.listeners.map((listener: any) => ({
          command: listener.command,
          pid: listener.pid,
          address: listener.address,
          scope: listener.scope
        }))
      : [],
    warnings: Array.isArray(value.warnings) ? [...value.warnings] : []
  }
}
