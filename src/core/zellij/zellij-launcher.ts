import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { appendJsonl, nowIso, sha256, writeJsonAtomic } from '../fsx.js'
import {
  inspectCodexLbCliLaunchRecovery
} from '../codex-control/codex-lb-launch-recovery.js'
import {
  codexLbToolOutputRecoveryNotChecked,
  type CodexLbToolOutputRecoveryProbe
} from '../codex-lb/codex-lb-tool-output-recovery.js'
import { prepareCodexAppServerRuntimeEnv } from '../codex-control/codex-app-server-runtime-env.js'
import { checkZellijCapability, type ZellijCapabilityReport } from './zellij-capability.js'
import {
  estimateZellijSocketPathLength,
  formatZellijCommand,
  resolveZellijProcessEnvMeta,
  runZellij,
  ZELLIJ_UNIX_SOCKET_PATH_LIMIT,
  type ZellijCommandResult
} from './zellij-command.js'
import { writeZellijLayout, type ZellijLayoutInput } from './zellij-layout-builder.js'
import { writeZellijClipboardConfig } from './zellij-clipboard-config.js'
import { writeZellijPaneProof, type ZellijPaneProofOptions } from './zellij-pane-proof.js'

export const ZELLIJ_SESSION_SCHEMA = 'sks.zellij-session.v1'
export const ZELLIJ_SESSION_NAME_MAX = 64
export const ZELLIJ_SESSION_NAME_MIN = 8

export interface ZellijLaunchOptions {
  root?: string
  missionId?: string
  session?: string
  cwd?: string
  ledgerRoot?: string
  slotCount?: number
  kind?: 'mad' | 'naruto'
  dryRun?: boolean
  attach?: boolean
  requireZellij?: boolean
  codexBin?: string
  codexArgs?: readonly unknown[]
  launchEnv?: Record<string, unknown>
  recoveryFetch?: typeof fetch
  recoveryTimeoutMs?: number
  recoveryAllowUnverified?: boolean
  zellijCapability?: ZellijCapabilityReport
  verifiedCodexLbToolOutputRecovery?: CodexLbToolOutputRecoveryProbe
  prepareCodexRuntimeEnvImpl?: typeof prepareCodexAppServerRuntimeEnv
  // When true, kill any pre-existing session with this name before (re)creating
  // it so the launch starts from a clean main-only layout. Without this, a stable
  // per-cwd session name (e.g. `sks-mad-<cwd>`) is reused across runs and each new
  // mission splits ANOTHER `--direction right` SLOTS column onto the already
  // populated session, fragmenting the screen into side-by-side columns. Opt out
  // at runtime with SKS_ZELLIJ_KEEP_SESSION=1.
  freshSession?: boolean
}

export async function launchZellijLayout(opts: ZellijLaunchOptions = {}) {
  const root = path.resolve(opts.root || process.cwd())
  const missionId = String(opts.missionId || `M-${Date.now().toString(36)}`)
  const ledgerRoot = path.resolve(opts.ledgerRoot || path.join(root, '.sneakoscope', 'missions', missionId, 'agents'))
  const sessionName = sanitizeZellijSessionName(opts.session || `sks-${missionId}`)
  const kind = opts.kind || 'naruto'
  const requestedCodexArgs = opts.codexArgs || []
  const shouldLaunchCodex = kind === 'mad' || requestedCodexArgs.length > 0
  const layoutLaunchEnv = await prepareZellijCodexLaunchEnv(opts, shouldLaunchCodex)
  const layoutInput: ZellijLayoutInput = {
    missionId,
    sessionName,
    ledgerRoot,
    cwd: opts.cwd || root,
    kind,
    slotCount: opts.slotCount ?? 1,
    title: `SKS ${opts.kind || 'naruto'} ${missionId}`,
    codexArgs: requestedCodexArgs,
    launchEnv: layoutLaunchEnv
  }
  if (opts.codexBin) layoutInput.codexBin = opts.codexBin
  const layout = await writeZellijLayout(root, layoutInput)
  const capability = reusableZellijCapability(opts.zellijCapability, opts.requireZellij === true)
    || await checkZellijCapability({ root, require: opts.requireZellij === true })
  // Configure the clipboard pipeline so selections inside the session reach the OS
  // clipboard (Zellij's default OSC-52 copy is dropped by Terminal.app etc.). The
  // copy option flags are appended AFTER `--default-layout <path>` so the launch
  // command prefix ['zellij','attach','--create-background',session,'options','--default-layout',...]
  // is preserved (required by the zellij launch-command-truth gate + E2E assertions).
  const clipboard = await writeZellijClipboardConfig(root, missionId)
  const createCommand = ['attach', '--create-background', sessionName, 'options', '--default-layout', layout.layout_path, ...clipboard.optionFlags]
  const attachCommand = ['attach', sessionName]
  const launchProcessEnv = launchRecoveryEnv(layoutLaunchEnv)
  const zellijEnv = resolveZellijProcessEnvMeta(launchProcessEnv)
  const willCreateSession = opts.dryRun !== true && capability.status === 'ok'
  const codexLaunchRecovery = layout.main_pane_kind === 'codex_interactive' && willCreateSession
    ? await inspectCodexLbCliLaunchRecovery({
        root: opts.cwd || root,
        env: launchProcessEnv,
        cliArgs: layout.codex_args,
        ...(opts.verifiedCodexLbToolOutputRecovery ? { verifiedProbe: opts.verifiedCodexLbToolOutputRecovery } : {}),
        ...(typeof opts.recoveryFetch === 'function' ? { fetchImpl: opts.recoveryFetch } : {}),
        ...(opts.recoveryTimeoutMs === undefined ? {} : { timeoutMs: opts.recoveryTimeoutMs }),
        ...(opts.recoveryAllowUnverified === true ? { allowUnverified: true } : {})
      })
    : codexLbToolOutputRecoveryNotChecked(false)
  // Reset a stale same-named session before recreating it so the launch starts
  // main-only. `kill-session` only stops live sessions and leaves EXITED
  // resurrectable zombies (`attach to resurrect`); `delete-session --force`
  // kills when live and removes EXITED entries so create-background cannot
  // resurrect a month-old layout. Skipped on dry-run, when zellij is
  // unavailable, or when the user opts out with SKS_ZELLIJ_KEEP_SESSION=1.
  const resetSession = opts.freshSession === true
    && willCreateSession
    && codexLaunchRecovery.ok
    && process.env.SKS_ZELLIJ_KEEP_SESSION !== '1'
  const sessionReset = resetSession
    ? await runZellij(['delete-session', '--force', sessionName], {
      cwd: opts.cwd || root,
      env: launchProcessEnv,
      timeoutMs: 2_000,
      optional: true
    })
    : null
  const launch: any = !willCreateSession || !codexLaunchRecovery.ok
    ? null
    : {
        create_background: await runZellij(createCommand, { cwd: opts.cwd || root, env: launchProcessEnv, timeoutMs: 5000, optional: opts.requireZellij !== true })
      }
  const paneProofOpts: ZellijPaneProofOptions = {
    missionId,
    require: opts.requireZellij === true,
    phase: opts.dryRun === true ? 'dry_run_launch' : 'post_launch',
    ledgerRoot: path.join(root, '.sneakoscope', 'missions', missionId),
    sessionName,
    expectedLaneCount: 0,
    expectedCwd: opts.cwd || root,
    zellijCapability: capability
  }
  if (layout.main_pane_kind === 'codex_interactive') paneProofOpts.expectedMainCommandIncludes = 'codex'
  const strictPaneProof = opts.requireZellij === true || opts.dryRun === true || process.env.SKS_ZELLIJ_STRICT_PANE_PROOF === '1'
  // Optional MAD launches already proved session creation via create_background.
  // Skip the extra list-panes probe unless strict/required so launch stays off the
  // Zellij CLI retry path that official-subagent Naruto must not inherit.
  const shouldWritePaneProof = codexLaunchRecovery.ok
    && (strictPaneProof || (willCreateSession && opts.requireZellij === true))
  const paneProof = shouldWritePaneProof
    ? await writeZellijPaneProof(root, paneProofOpts).catch((err: any) => ({
        ok: false,
        status: 'probe_failed',
        blockers: [`zellij_pane_proof_exception:${err?.message || String(err)}`]
      }))
    : {
        ok: true,
        status: willCreateSession ? 'skipped_optional_post_launch' : 'skipped_optional_unavailable',
        capability_status: capability.status,
        blockers: [],
        warnings: [
          willCreateSession
            ? 'zellij_pane_proof_skipped_optional_post_launch'
            : 'zellij_pane_proof_skipped_optional_unavailable'
        ]
      }
  if (launch?.create_background) {
    launch.create_background = normalizeExistingZellijSession(sessionName, launch.create_background)
  }
  const launchOk = launch?.create_background?.ok === true
  const ok = capability.ok
    && codexLaunchRecovery.ok
    && (opts.dryRun === true || capability.status !== 'ok' || launchOk)
    && (opts.requireZellij === true ? paneProof.ok === true : true)
  const blockers = [
    ...capability.blockers,
    ...(!codexLaunchRecovery.ok ? codexLaunchRecovery.blockers : []),
    ...(launch && !launch.create_background?.ok ? (launch.create_background?.blockers || ['zellij_background_session_failed']).map((blocker: string) => `zellij_launch_${blocker}`) : []),
    ...(opts.requireZellij === true && paneProof.ok !== true ? (paneProof.blockers || ['zellij_pane_proof_failed']).map((blocker: string) => `zellij_launch_${blocker}`) : [])
  ]
  const report = {
    schema: ZELLIJ_SESSION_SCHEMA,
    generated_at: nowIso(),
    ok: blockers.length === 0 && ok,
    kind: opts.kind || 'naruto',
    mission_id: missionId,
    session_name: sessionName,
    root,
    cwd: path.resolve(opts.cwd || root),
    ledger_root: ledgerRoot,
    layout_path: layout.layout_path,
    layout_artifact: path.relative(root, layout.layout_path),
    main_pane_kind: layout.main_pane_kind,
    codex_pane: {
      enabled: layout.main_pane_kind === 'codex_interactive',
      args: layout.codex_args,
      launch_env_keys: layout.launch_env_keys,
      bin: opts.codexBin || process.env.SKS_CODEX_BIN || 'codex'
    },
    command: ['zellij', ...createCommand],
    launch_command: ['zellij', ...createCommand],
    launch_command_with_env: formatZellijCommand(createCommand, zellijEnv),
    background_command: ['zellij', ...createCommand],
    background_command_with_env: formatZellijCommand(createCommand, zellijEnv),
    attach_command: `zellij attach ${sessionName}`,
    attach_command_with_env: formatZellijCommand(attachCommand, zellijEnv),
    attach_requested: opts.attach === true,
    zellij_socket_dir: zellijEnv.zellij_socket_dir,
    zellij_socket_dir_source: zellijEnv.zellij_socket_dir_source,
    clipboard_config_path: clipboard.config_path,
    clipboard_copy_command: clipboard.copy_command,
    clipboard_mouse_mode: clipboard.mouse_mode,
    pane_proof_path: path.join(root, '.sneakoscope', 'missions', missionId, 'zellij-pane-proof.json'),
    pane_proof: paneProof,
    pane_proof_background: false,
    dry_run: opts.dryRun === true,
    capability,
    codex_lb_tool_output_recovery: codexLaunchRecovery,
    launch,
    session_reset: sessionReset,
    blockers,
    warnings: [
      ...capability.warnings,
      ...codexLaunchRecovery.warnings,
      ...(opts.dryRun === true ? ['zellij_launch_dry_run'] : []),
      ...(!launch && capability.status !== 'ok' && !opts.requireZellij ? ['zellij_launch_skipped_optional_missing'] : [])
    ]
  }
  const sessionPath = path.join(root, '.sneakoscope', 'missions', missionId, 'zellij-session.json')
  await writeJsonAtomic(sessionPath, report)
  await Promise.all([
    writeJsonAtomic(path.join(root, '.sneakoscope', 'missions', missionId, 'zellij-layout.kdl.json'), { ...layout, layout_kdl: undefined }),
    appendJsonl(path.join(root, '.sneakoscope', 'missions', missionId, 'zellij-session-events.jsonl'), {
      schema: 'sks.zellij-session-event.v1',
      ts: nowIso(),
      event_type: opts.dryRun === true ? 'zellij_launch_dry_run' : 'zellij_launch_attempted',
      report: path.relative(root, sessionPath)
    })
  ])
  return report
}

function reusableZellijCapability(value: ZellijCapabilityReport | undefined, requireZellij: boolean): ZellijCapabilityReport | null {
  if (!value || value.schema !== 'sks.zellij-capability.v1') return null
  if (requireZellij && value.status !== 'ok') return null
  return value
}

function launchRecoveryEnv(launchEnv: Record<string, unknown> | undefined): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env }
  for (const [key, value] of Object.entries(launchEnv || {})) {
    if (value !== undefined && value !== null) env[key] = String(value)
  }
  return env
}

async function prepareZellijCodexLaunchEnv(
  opts: ZellijLaunchOptions,
  shouldLaunchCodex: boolean
): Promise<Record<string, unknown>> {
  if (!shouldLaunchCodex) return { ...(opts.launchEnv || {}) }
  const launchEnv: Record<string, unknown> = { ...(opts.launchEnv || {}) }
  delete launchEnv.CODEX_LB_API_KEY
  delete launchEnv.CODEX_LB_BASE_URL
  const prepare = opts.prepareCodexRuntimeEnvImpl || prepareCodexAppServerRuntimeEnv
  const runtimeEnv = await prepare({ env: launchRecoveryEnv(opts.launchEnv) })
  if (runtimeEnv.CODEX_LB_API_KEY) launchEnv.CODEX_LB_API_KEY = runtimeEnv.CODEX_LB_API_KEY
  if (runtimeEnv.CODEX_LB_BASE_URL) launchEnv.CODEX_LB_BASE_URL = runtimeEnv.CODEX_LB_BASE_URL
  return launchEnv
}

export async function launchMadZellijUi(args: readonly unknown[] = [], opts: ZellijLaunchOptions = {}) {
  const session = readOption(args, '--session', opts.session || readOption(args, '--workspace', null))
  const launchOpts: ZellijLaunchOptions = {
    ...opts,
    kind: 'mad',
    slotCount: opts.slotCount ?? 1
  }
  const resolvedSession = session || opts.session
  if (resolvedSession) launchOpts.session = resolvedSession
  return launchZellijLayout(launchOpts)
}

export interface ZellijAttachResult {
  ok: boolean
  status: number | null
  signal: NodeJS.Signals | null
  error?: string
}

/**
 * Attach the current terminal to an existing Zellij session in the foreground.
 *
 * `launchZellijLayout` only ever *creates* a detached background session, which
 * is correct for proof/automation but means an interactive launch (e.g.
 * `sks --mad`) never actually opens anything. This helper performs the
 * follow-up foreground attach, inheriting stdio so the session takes over the
 * user's terminal until they detach. It is a no-op-style failure (never throws)
 * when Zellij is missing or attach fails, so callers can fall back to printing a
 * manual attach hint.
 */
export function attachZellijSessionInteractive(
  sessionName: string,
  opts: { cwd?: string; configPath?: string } = {}
): ZellijAttachResult {
  if (!sessionName) return { ok: false, status: null, signal: null, error: 'missing_session_name' }
  const meta = resolveZellijProcessEnvMeta()
  const env: NodeJS.ProcessEnv = { ...process.env }
  if (meta.zellij_socket_dir && !env.ZELLIJ_SOCKET_DIR) env.ZELLIJ_SOCKET_DIR = meta.zellij_socket_dir
  // Steer the foreground attach at our generated clipboard config so the interactive
  // session honors copy_command=pbcopy + copy_on_select. The `options` subcommand only
  // configures the *created* background session, so the attach needs its own config
  // delivery; ZELLIJ_CONFIG_FILE avoids reordering CLI args. Defer to a user-exported
  // ZELLIJ_CONFIG_FILE if they already set one.
  if (opts.configPath && !env.ZELLIJ_CONFIG_FILE) env.ZELLIJ_CONFIG_FILE = opts.configPath
  try {
    const result = spawnSync('zellij', ['attach', sessionName], {
      cwd: opts.cwd || process.cwd(),
      env,
      stdio: 'inherit'
    })
    if (result.error) return { ok: false, status: null, signal: null, error: result.error.message }
    return { ok: result.status === 0, status: result.status ?? null, signal: result.signal ?? null }
  } catch (err: any) {
    return { ok: false, status: null, signal: null, error: err?.message || String(err) }
  }
}

export function sanitizeZellijSessionName(value: unknown, opts: { socketDir?: string | null } = {}): string {
  const cleaned = String(value || 'sks-session').replace(/[^A-Za-z0-9_.:-]+/g, '-').replace(/^-+|-+$/g, '')
  if (!cleaned) return 'sks-session'
  const socketDir = opts.socketDir === undefined
    ? resolveZellijProcessEnvMeta().zellij_socket_dir
    : opts.socketDir
  let maxChars = ZELLIJ_SESSION_NAME_MAX
  if (socketDir) {
    const used = estimateZellijSocketPathLength(socketDir, '')
    const budget = ZELLIJ_UNIX_SOCKET_PATH_LIMIT - used
    maxChars = Math.max(ZELLIJ_SESSION_NAME_MIN, Math.min(ZELLIJ_SESSION_NAME_MAX, budget))
  }
  if (cleaned.length <= maxChars) return cleaned
  const suffix = sha256(cleaned).slice(0, 8)
  const prefix = cleaned.slice(0, Math.max(1, maxChars - suffix.length - 1)).replace(/[-_.:]+$/g, '')
  return `${prefix}-${suffix}`.slice(0, maxChars)
}

/** Stable per-cwd MAD session name that stays inside the Unix socket path budget. */
export function madZellijSessionNameForCwd(cwd: string = process.cwd()): string {
  const resolved = path.resolve(cwd)
  const base = path.basename(resolved) || 'project'
  const digest = sha256(resolved).slice(0, 10)
  return sanitizeZellijSessionName(`sks-mad-${base}-${digest}`)
}

function readOption(args: readonly unknown[], name: string, fallback: string | null): string | null {
  const list = args.map((arg) => String(arg))
  const index = list.indexOf(name)
  return index >= 0 && list[index + 1] ? String(list[index + 1]) : fallback
}

function normalizeExistingZellijSession(sessionName: string, result: ZellijCommandResult): ZellijCommandResult {
  if (result.ok) return result
  if (/Session already exists/i.test(result.stderr_tail || '')) {
    return {
      ...result,
      ok: true,
      blockers: [],
      warnings: [...result.warnings, `zellij_session_already_exists:${sessionName}`]
    }
  }
  return result
}
