import { exists, runProcess, which } from '../fsx.js'
import {
  inspectDesktopBridgeCliLaunchGuard,
  stripRetiredDirectProviderEnv,
  type DesktopBridgeLaunchGuard
} from '../codex-control/desktop-bridge-launch-guard.js'

export interface CodexAppRestartResult {
  schema: 'sks.codex-app-restart.v1'
  ok: boolean
  status: string
  skipped?: boolean
  reason?: string
  app_name: string
  bundle_id?: string
  quit?: { ok: boolean; code: number | null; error?: string | null }
  exit_wait?: { ok: boolean; attempts: number; error?: string | null }
  open?: { ok: boolean; code: number | null; error?: string | null }
  blockers: string[]
  desktop_bridge_launch_guard?: DesktopBridgeLaunchGuard
}

export interface CodexAppQuitResult {
  schema: 'sks.codex-app-quit.v1'
  ok: boolean
  status: string
  skipped?: boolean
  reason?: string
  app_name: string
  bundle_id?: string
  quit?: { ok: boolean; code: number | null; error?: string | null }
  exit_wait?: { ok: boolean; attempts: number; error?: string | null }
  blockers: string[]
}

export async function quitCodexApp(opts: {
  enabled?: boolean
  appName?: string
  bundleId?: string
  exitTimeoutMs?: number
  pollMs?: number
  platform?: NodeJS.Platform
  osascriptPath?: string
  env?: NodeJS.ProcessEnv
  runProcessImpl?: typeof runProcess
} = {}): Promise<CodexAppQuitResult> {
  const env = opts.env || process.env
  const appName = String(opts.appName || env.SKS_CODEX_APP_NAME || 'ChatGPT')
  const bundleId = String(opts.bundleId || env.SKS_CODEX_APP_BUNDLE_ID || 'com.openai.codex')
  if (opts.enabled === false) return quitSkipped(appName, 'disabled')
  if ((opts.platform || process.platform) !== 'darwin') return quitSkipped(appName, 'not_macos')
  const run = opts.runProcessImpl || runProcess
  const osascript = opts.osascriptPath
    || await which('osascript').catch(() => null)
    || await exists('/usr/bin/osascript').then((ok) => ok ? '/usr/bin/osascript' : null).catch(() => null)
  if (!osascript) {
    return {
      schema: 'sks.codex-app-quit.v1',
      ok: false,
      status: 'blocked',
      app_name: appName,
      bundle_id: bundleId,
      blockers: ['osascript_missing']
    }
  }
  const appTarget = bundleId ? `application id ${JSON.stringify(bundleId)}` : `application ${JSON.stringify(appName)}`
  const quit = await run(osascript, ['-e', `tell ${appTarget} to quit`], {
    timeoutMs: 5000,
    maxOutputBytes: 8192
  }).catch((err: any) => ({
    code: 1,
    stdout: '',
    stderr: err?.message || String(err)
  }))
  const quitOk = quit.code === 0
    || /not running|Can't get application|application isn't running/i.test(String(quit.stderr || quit.stdout || ''))
  const exitTimeoutMs = Math.max(250, Number(opts.exitTimeoutMs ?? env.SKS_CODEX_APP_EXIT_TIMEOUT_MS ?? 5000))
  const pollMs = Math.max(50, Number(opts.pollMs ?? 100))
  let exited = !quitOk
  let attempts = 0
  const deadline = Date.now() + exitTimeoutMs
  while (quitOk && Date.now() < deadline) {
    attempts += 1
    const probe = await run(osascript, ['-e', `${appTarget} is running`], {
      timeoutMs: 1000,
      maxOutputBytes: 1024
    }).catch(() => null)
    if (probe?.code === 0 && String(probe.stdout || '').trim().toLowerCase() === 'false') {
      exited = true
      break
    }
    await sleep(pollMs)
  }
  return {
    schema: 'sks.codex-app-quit.v1',
    ok: quitOk && exited,
    status: quitOk && exited ? 'quit' : 'blocked',
    app_name: appName,
    bundle_id: bundleId,
    quit: {
      ok: quitOk,
      code: quit.code,
      error: quitOk ? null : String(quit.stderr || quit.stdout || '').trim()
    },
    exit_wait: {
      ok: exited,
      attempts,
      error: exited ? null : 'codex_app_exit_timeout'
    },
    blockers: [
      ...(quitOk ? [] : ['codex_app_quit_failed']),
      ...(exited ? [] : ['codex_app_exit_timeout'])
    ]
  }
}

export async function restartCodexApp(opts: {
  enabled?: boolean
  appName?: string
  bundleId?: string
  delayMs?: number
  exitTimeoutMs?: number
  pollMs?: number
  platform?: NodeJS.Platform
  osascriptPath?: string
  openPath?: string
  env?: NodeJS.ProcessEnv
  root?: string
  runProcessImpl?: typeof runProcess
} = {}): Promise<CodexAppRestartResult> {
  const env = stripRetiredDirectProviderEnv(opts.env || process.env)
  const appName = String(opts.appName || env.SKS_CODEX_APP_NAME || 'ChatGPT')
  const bundleId = String(opts.bundleId || env.SKS_CODEX_APP_BUNDLE_ID || 'com.openai.codex')
  if (opts.enabled === false || env.SKS_SKIP_CODEX_APP_RESTART === '1') {
    return skipped(appName, 'disabled')
  }
  if ((opts.platform || process.platform) !== 'darwin') return skipped(appName, 'not_macos')
  const run = opts.runProcessImpl || runProcess
  const osascript = opts.osascriptPath || await which('osascript').catch(() => null) || await exists('/usr/bin/osascript').then((ok) => ok ? '/usr/bin/osascript' : null).catch(() => null)
  const open = opts.openPath || await which('open').catch(() => null) || await exists('/usr/bin/open').then((ok) => ok ? '/usr/bin/open' : null).catch(() => null)
  if (!osascript || !open) {
    return {
      schema: 'sks.codex-app-restart.v1',
      ok: false,
      status: 'blocked',
      app_name: appName,
      blockers: [
        ...(osascript ? [] : ['osascript_missing']),
        ...(open ? [] : ['open_missing'])
      ]
    }
  }
  const launchGuard = await inspectDesktopBridgeCliLaunchGuard({
    root: opts.root || process.cwd(),
    env,
    cliArgs: ['/app']
  })
  if (!launchGuard.ok) {
    return {
      schema: 'sks.codex-app-restart.v1',
      ok: false,
      status: 'desktop_bridge_launch_guard_blocked',
      app_name: appName,
      bundle_id: bundleId,
      blockers: launchGuard.blockers,
      desktop_bridge_launch_guard: launchGuard
    }
  }
  const appTarget = bundleId ? `application id ${JSON.stringify(bundleId)}` : `application ${JSON.stringify(appName)}`
  const quit = await run(osascript, ['-e', `tell ${appTarget} to quit`], { timeoutMs: 5000, maxOutputBytes: 8192 }).catch((err: any) => ({
    code: 1,
    stdout: '',
    stderr: err?.message || String(err)
  }))
  const quitOk = quit.code === 0 || /not running|Can't get application|application isn't running/i.test(String(quit.stderr || quit.stdout || ''))
  const exitTimeoutMs = Math.max(250, Number(opts.exitTimeoutMs ?? env.SKS_CODEX_APP_EXIT_TIMEOUT_MS ?? 5000))
  const pollMs = Math.max(50, Number(opts.pollMs ?? 100))
  let exited = !quitOk
  let attempts = 0
  const deadline = Date.now() + exitTimeoutMs
  while (quitOk && Date.now() < deadline) {
    attempts += 1
    const probe = await run(osascript, ['-e', `${appTarget} is running`], { timeoutMs: 1000, maxOutputBytes: 1024 }).catch(() => null)
    if (probe?.code === 0 && String(probe.stdout || '').trim().toLowerCase() === 'false') {
      exited = true
      break
    }
    await sleep(pollMs)
  }
  if (quitOk && !exited) {
    return {
      schema: 'sks.codex-app-restart.v1',
      ok: false,
      status: 'blocked',
      app_name: appName,
      bundle_id: bundleId,
      quit: { ok: true, code: quit.code, error: null },
      exit_wait: { ok: false, attempts, error: 'codex_app_exit_timeout' },
      blockers: ['codex_app_exit_timeout'],
      desktop_bridge_launch_guard: launchGuard
    }
  }
  await sleep(Number(opts.delayMs ?? env.SKS_CODEX_APP_RESTART_DELAY_MS ?? 150))
  const launched = await run(open, bundleId ? ['-b', bundleId] : ['-a', appName], { timeoutMs: 10000, maxOutputBytes: 8192 }).catch((err: any) => ({
    code: 1,
    stdout: '',
    stderr: err?.message || String(err)
  }))
  const openOk = launched.code === 0
  return {
    schema: 'sks.codex-app-restart.v1',
    ok: quitOk && openOk,
    status: quitOk && openOk ? 'restarted' : 'blocked',
    app_name: appName,
    bundle_id: bundleId,
    quit: { ok: quitOk, code: quit.code, error: quitOk ? null : String(quit.stderr || quit.stdout || '').trim() },
    exit_wait: { ok: exited, attempts, error: exited ? null : 'codex_app_exit_timeout' },
    open: { ok: openOk, code: launched.code, error: openOk ? null : String(launched.stderr || launched.stdout || '').trim() },
    blockers: [
      ...(quitOk ? [] : ['codex_app_quit_failed']),
      ...(openOk ? [] : ['codex_app_open_failed'])
    ],
    desktop_bridge_launch_guard: launchGuard
  }
}

function skipped(appName: string, reason: string): CodexAppRestartResult {
  return {
    schema: 'sks.codex-app-restart.v1',
    ok: true,
    status: 'skipped',
    skipped: true,
    reason,
    app_name: appName,
    blockers: []
  }
}

function quitSkipped(appName: string, reason: string): CodexAppQuitResult {
  return {
    schema: 'sks.codex-app-quit.v1',
    ok: true,
    status: 'skipped',
    skipped: true,
    reason,
    app_name: appName,
    blockers: []
  }
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)))
}
