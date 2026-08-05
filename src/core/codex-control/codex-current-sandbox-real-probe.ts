import path from 'node:path'
import { findCodexBinary } from '../codex-adapter.js'
import { ensureDir, runProcess } from '../fsx.js'
import { codexCurrentCoreProbeTail, skippedCodexCurrentCoreProbe, type CodexCurrentCoreSingleProbe } from './codex-current-core-real-probes.js'

export async function runCodexCurrentCoreSandboxProfileAliasProbe(input: {
  root: string
  requireReal?: boolean
  timeoutMs?: number
  codexBin?: string | null
}): Promise<CodexCurrentCoreSingleProbe> {
  const started = Date.now()
  const codexBin = input.codexBin || await findCodexBinary()
  if (!codexBin) return skippedCodexCurrentCoreProbe('codex_cli_missing')
  const help = await runProcess(codexBin, ['--help'], { timeoutMs: input.timeoutMs || 30000, maxOutputBytes: 256 * 1024 }).catch((err: any) => ({ code: 1, stdout: '', stderr: err?.message || String(err) }))
  const sandboxHelp = await runProcess(codexBin, ['sandbox', '--help'], { timeoutMs: input.timeoutMs || 30000, maxOutputBytes: 256 * 1024 }).catch((err: any) => ({ code: 1, stdout: '', stderr: err?.message || String(err) }))
  const helpText = `${(help as any).stdout || ''}\n${(help as any).stderr || ''}`
  const sandboxHelpText = `${(sandboxHelp as any).stdout || ''}\n${(sandboxHelp as any).stderr || ''}`
  const topLevelHelpMentionsAlias = /(^|\s)-P\b/.test(helpText)
  const sandboxHelpMentionsAlias = /(^|\s)-P,\s+--permissions-profile\b/.test(sandboxHelpText) || /(^|\s)-P\b/.test(sandboxHelpText)
  const dryArgs = sandboxHelpMentionsAlias ? ['sandbox', '-P', ':read-only', '--', 'true'] : ['-P', ':read-only', '--version']
  const dry = await runProcess(codexBin, dryArgs, { timeoutMs: input.timeoutMs || 30000, maxOutputBytes: 64 * 1024 }).catch((err: any) => ({ code: 1, stdout: '', stderr: err?.message || String(err) }))
  const dryAccepted = (dry as any).code === 0
  const helpMentionsAlias = topLevelHelpMentionsAlias || sandboxHelpMentionsAlias
  const ok = helpMentionsAlias && dryAccepted
  return {
    ok,
    mode: 'actual-cli',
    command_line: [codexBin, ...(sandboxHelpMentionsAlias ? ['sandbox', '--help'] : ['--help'])],
    duration_ms: Date.now() - started,
    stdout_tail: codexCurrentCoreProbeTail(`${(help as any).stdout || ''}\n${(sandboxHelp as any).stdout || ''}\n${(dry as any).stdout || ''}`),
    stderr_tail: codexCurrentCoreProbeTail(`${(help as any).stderr || ''}\n${(sandboxHelp as any).stderr || ''}\n${(dry as any).stderr || ''}`),
    artifact_paths: [],
    evidence: {
      help_mentions_P: helpMentionsAlias,
      top_level_help_mentions_P: topLevelHelpMentionsAlias,
      sandbox_help_mentions_P: sandboxHelpMentionsAlias,
      dry_command_attempted: true,
      dry_command_line: [codexBin, ...dryArgs],
      dry_command_accepted: dryAccepted,
      dry_command_warning: dryAccepted ? null : 'permissions-profile alias was advertised but the real sandbox no-op failed'
    },
    blockers: ok ? [] : [
      ...(helpMentionsAlias ? [] : ['codex_sandbox_profile_alias_help_missing']),
      ...(dryAccepted ? [] : ['codex_sandbox_profile_alias_real_command_failed'])
    ]
  }
}

export async function runCodexCurrentCoreSandboxProxyPreservationProbe(input: {
  root: string
  requireReal?: boolean
  timeoutMs?: number
  codexBin?: string | null
}): Promise<CodexCurrentCoreSingleProbe> {
  const started = Date.now()
  const codexBin = input.codexBin || await findCodexBinary()
  if (!codexBin) return skippedCodexCurrentCoreProbe('codex_cli_missing')
  const tempDir = path.join(input.root, '.sneakoscope', 'tmp', 'codex-current-core-real-probes', `sandbox-proxy-${Date.now()}`)
  await ensureDir(tempDir)
  const proxyState = {
    HTTPS_PROXY: Boolean(process.env.HTTPS_PROXY),
    HTTP_PROXY: Boolean(process.env.HTTP_PROXY),
    ALL_PROXY: Boolean(process.env.ALL_PROXY)
  }
  const probeScript = 'process.stdout.write(JSON.stringify({HTTPS_PROXY:Boolean(process.env.HTTPS_PROXY),HTTP_PROXY:Boolean(process.env.HTTP_PROXY),ALL_PROXY:Boolean(process.env.ALL_PROXY)}))'
  const args = ['sandbox', '-P', ':read-only', '-C', tempDir, '--', process.execPath, '-e', probeScript]
  const result = await runProcess(codexBin, args, {
    cwd: tempDir,
    timeoutMs: input.timeoutMs || 30000,
    maxOutputBytes: 64 * 1024
  }).catch((err: any) => ({ code: 1, stdout: '', stderr: err?.message || String(err) }))
  const safeNoopRan = (result as any).code === 0
  const observedProxyState = parseProxyState((result as any).stdout)
  const proxyEnvironmentPreserved = observedProxyState !== null
    && Object.entries(proxyState).every(([key, value]) => observedProxyState[key] === value)
  const ok = safeNoopRan && proxyEnvironmentPreserved
  return {
    ok,
    mode: 'actual-cli',
    command_line: [codexBin, ...args],
    duration_ms: Date.now() - started,
    stdout_tail: codexCurrentCoreProbeTail((result as any).stdout),
    stderr_tail: codexCurrentCoreProbeTail((result as any).stderr),
    artifact_paths: [tempDir],
    evidence: {
      safe_noop_ran: safeNoopRan,
      host_proxy_presence: proxyState,
      sandbox_proxy_presence: observedProxyState,
      proxy_marker_checked: true,
      proxy_environment_preserved: proxyEnvironmentPreserved,
      permissions_profile: ':read-only'
    },
    blockers: ok ? [] : [
      ...(safeNoopRan ? [] : ['codex_sandbox_proxy_safe_noop_failed']),
      ...(proxyEnvironmentPreserved ? [] : ['codex_sandbox_proxy_environment_not_preserved'])
    ]
  }
}

function parseProxyState(text: unknown): Record<string, boolean> | null {
  try {
    const parsed = JSON.parse(String(text || ''))
    if (!parsed || typeof parsed !== 'object') return null
    return {
      HTTPS_PROXY: parsed.HTTPS_PROXY === true,
      HTTP_PROXY: parsed.HTTP_PROXY === true,
      ALL_PROXY: parsed.ALL_PROXY === true
    }
  } catch {
    return null
  }
}
