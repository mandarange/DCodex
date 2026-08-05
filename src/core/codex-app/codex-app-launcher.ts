import { findCodexBinary } from '../codex-adapter.js'
import { runProcess } from '../fsx.js'
import {
  inspectDesktopBridgeCliLaunchGuard,
  stripRetiredDirectProviderEnv,
  type DesktopBridgeLaunchGuard
} from '../codex-control/desktop-bridge-launch-guard.js'

export interface CodexAppLaunchAttempt {
  schema: 'sks.codex-app-launch-attempt.v1'
  attempted: boolean
  launched: boolean
  platform: NodeJS.Platform
  mode: 'artifact-only' | 'attempt-launch'
  command_line: string[]
  exit_code: number | null
  stdout_tail: string
  stderr_tail: string
  fallback_reason: string | null
  blockers: string[]
  desktop_bridge_launch_guard?: DesktopBridgeLaunchGuard
}

export async function attemptCodexAppLaunch(input: {
  cwd: string
  promptArtifactPath: string
  codexBin?: string | null
  mode: 'artifact-only' | 'attempt-launch'
  timeoutMs?: number
  env?: NodeJS.ProcessEnv
  runProcessImpl?: typeof runProcess
  findCodexBinaryImpl?: typeof findCodexBinary
  platform?: NodeJS.Platform
}): Promise<CodexAppLaunchAttempt> {
  const platform = input.platform || process.platform
  const timeoutMs = Math.max(1, Math.min(Number(input.timeoutMs || 3000), 3000))
  let codexBin = input.codexBin || null
  let commandLine = [codexBin || 'codex', '/app']
  if (input.mode === 'artifact-only') {
    return launchAttempt({
      attempted: false,
      launched: false,
      platform,
      mode: input.mode,
      command_line: commandLine,
      exit_code: null,
      fallback_reason: 'artifact_only_mode',
      blockers: []
    })
  }
  const platformSupported = platform === 'darwin' || platform === 'win32'
  if (!platformSupported) {
    return launchAttempt({
      attempted: false,
      launched: false,
      platform,
      mode: input.mode,
      command_line: commandLine,
      exit_code: null,
      fallback_reason: 'unsupported_platform_artifact_only_fallback',
      blockers: ['codex_app_handoff_platform_unsupported']
    })
  }
  if (process.env.SKS_CODEX_APP_LAUNCH_FAKE === '1') {
    const launched = process.env.SKS_CODEX_APP_LAUNCH_FAKE_LAUNCHED !== '0'
    return launchAttempt({
      attempted: true,
      launched,
      platform,
      mode: input.mode,
      command_line: commandLine,
      exit_code: launched ? 0 : 1,
      stdout_tail: launched ? 'fake codex /app launched' : '',
      stderr_tail: launched ? '' : 'fake launch failed',
      fallback_reason: launched ? null : 'fake_launch_failed',
      blockers: launched ? [] : ['codex_app_launch_failed']
    })
  }
  const env = stripRetiredDirectProviderEnv(input.env || process.env)
  const execute = input.runProcessImpl || runProcess
  const launchGuard = await inspectDesktopBridgeCliLaunchGuard({
    root: input.cwd,
    env,
    cliArgs: ['/app']
  })
  if (!launchGuard.ok) {
    return launchAttempt({
      attempted: false,
      launched: false,
      platform,
      mode: input.mode,
      command_line: commandLine,
      exit_code: null,
      fallback_reason: 'desktop_bridge_launch_guard_blocked',
      blockers: launchGuard.blockers,
      desktop_bridge_launch_guard: launchGuard
    })
  }
  codexBin ||= await (input.findCodexBinaryImpl || findCodexBinary)()
  commandLine = [codexBin || 'codex', '/app']
  if (!codexBin) {
    return launchAttempt({
      attempted: false,
      launched: false,
      platform,
      mode: input.mode,
      command_line: commandLine,
      exit_code: null,
      fallback_reason: 'codex_cli_missing_artifact_only_fallback',
      blockers: ['codex_cli_missing'],
      desktop_bridge_launch_guard: launchGuard
    })
  }
  const result = await execute(codexBin, ['/app'], {
    cwd: input.cwd,
    env,
    timeoutMs,
    maxOutputBytes: 32 * 1024,
    input: `Continue the SKS mission using this prompt artifact:\n${input.promptArtifactPath}\n`
  }).catch((err: unknown) => ({
    code: -1,
    stdout: '',
    stderr: err instanceof Error ? err.message : String(err),
    stdoutBytes: 0,
    stderrBytes: 0,
    truncated: false,
    timedOut: false
  }))
  const code = typeof result.code === 'number' ? result.code : null
  const stdout = String(result.stdout || '')
  const stderr = String(result.stderr || '')
  const markerLaunched = /(?:handoff|desktop|app).*?(?:launched|opened|ready)|(?:launched|opened).*?(?:handoff|desktop|app)/i.test(`${stdout}\n${stderr}`)
  const launched = code === 0 || markerLaunched
  const timedOut = result.timedOut === true || code === 124
  const fallbackReason = launched
    ? null
    : timedOut
      ? 'codex_app_handoff_interactive_or_timed_out_artifact_only_fallback'
      : 'codex_app_launch_failed_artifact_only_fallback'
  return launchAttempt({
    attempted: true,
    launched,
    platform,
    mode: input.mode,
    command_line: commandLine,
    exit_code: code,
    stdout_tail: stdout.slice(-4000),
    stderr_tail: stderr.slice(-4000),
    fallback_reason: fallbackReason,
    blockers: launched ? [] : [timedOut ? 'codex_app_launch_interactive_or_timeout' : 'codex_app_launch_failed'],
    desktop_bridge_launch_guard: launchGuard
  })
}

function launchAttempt(input: Omit<CodexAppLaunchAttempt, 'schema' | 'stdout_tail' | 'stderr_tail'> & {
  stdout_tail?: string
  stderr_tail?: string
}): CodexAppLaunchAttempt {
  return {
    schema: 'sks.codex-app-launch-attempt.v1',
    stdout_tail: input.stdout_tail || '',
    stderr_tail: input.stderr_tail || '',
    ...input
  }
}
