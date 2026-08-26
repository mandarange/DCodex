import os from 'node:os';
import path from 'node:path';
import { exists, PACKAGE_VERSION, readJson, runProcess } from '../../fsx.js';
import {
  bootstrapExistingDesktopBridgeService,
  desktopBridgeServicePaths
} from '../../codex-lb/desktop-service.js';

export interface DesktopBridgeRestageRun {
  ok: boolean;
  status: 'ok' | 'skipped' | 'failed';
  actions: string[];
  blockers: string[];
  warnings: string[];
}

export interface DesktopBridgeRestageOptions {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  home?: string;
  packageVersion?: string;
  uid?: number | null;
  /** launchctl runner; injecting it also declares the real gui domain unreachable. */
  run?: typeof runProcess;
  /** Recovery path for an installed-but-unloaded service; injecting it does the same. */
  bootstrapService?: typeof bootstrapExistingDesktopBridgeService;
  processAlive?: (pid: number) => boolean;
}

/**
 * Bring the Desktop Bridge back onto the code this update just installed.
 *
 * The bridge is a launchd service: `npm install` replaces the files on disk and
 * never touches the service, so every bridge fix shipped in an upgrade stayed
 * invisible until someone happened to run `doctor --fix`. Users kept reporting
 * bugs that were already fixed — each report was true of their running process
 * and false of their installed package.
 *
 * Two different states need two different remedies, and 9.2.3 only had one:
 * - a bridge that is RUNNING old code is restarted in place (`kickstart -k`);
 * - a bridge that is INSTALLED BUT DOWN is bootstrapped back into launchd.
 *
 * The second case used to be a silent skip, and 9.2.3 made it the common one:
 * launchd passed `--supervised`, the CLI parser rejected the flag, serve exited
 * immediately, and the failed install booted the service out. `sks update` then
 * replaced the package, found no live pid, skipped — and the operator watched
 * Codex reconnect forever against a port nothing was listening on, having done
 * the one thing that was supposed to fix it.
 *
 * A failed recovery NEVER fails the update: bridge readiness is deliberately
 * not a migration-profile gate, so the stage warns and names the follow-up
 * command instead of voiding an otherwise good update. That matches the
 * catalog-repair stage that runs right after this one.
 *
 * Guards, in order, and why each one exists:
 * - macOS only: launchd is the only supervisor this stage knows.
 * - not under a test runner (NODE_TEST_CONTEXT / SKS_TEST_ISOLATION) unless
 *   BOTH launchd seams are injected: `launchctl` addresses the real gui domain
 *   regardless of any HOME redirection, so a harnessed run must never reach the
 *   operator's actual service. Injecting `run` and `bootstrapService` leaves
 *   nothing real to protect, which is what makes this stage testable at all.
 * - launch agent plist must exist: no plist means no managed service to revive.
 * - settings must exist before a bootstrap: the plist alone describes a service
 *   whose `bridge serve` would exit on a missing settings document.
 */
export async function desktopBridgeRestage(
  options: DesktopBridgeRestageOptions = {}
): Promise<DesktopBridgeRestageRun> {
  const skip = (reason: string): DesktopBridgeRestageRun =>
    ({ ok: true, status: 'ok', actions: [reason], blockers: [], warnings: [] });
  const warn = (warnings: string[]): DesktopBridgeRestageRun =>
    ({ ok: true, status: 'ok', actions: [], blockers: [], warnings });
  const env = options.env || process.env;
  const version = options.packageVersion || PACKAGE_VERSION;
  const reachesRealLaunchd = !(options.run && options.bootstrapService);
  if ((options.platform || process.platform) !== 'darwin') return skip('desktop_bridge_restage_not_macos');
  if (reachesRealLaunchd && (env.NODE_TEST_CONTEXT !== undefined || env.SKS_TEST_ISOLATION === '1')) {
    return skip('desktop_bridge_restage_skipped_under_tests');
  }
  if (env.SKS_SKIP_BRIDGE_RESTAGE === '1') return skip('desktop_bridge_restage_disabled');
  const home = options.home || path.resolve(env.HOME || os.homedir());
  const paths = desktopBridgeServicePaths(home);
  if (!(await exists(paths.launch_agent_path))) return skip('desktop_bridge_restage_no_launch_agent');
  const state = await readJson(paths.state_path, null) as { sks_version?: unknown; pid?: unknown } | null;
  const runningVersion = typeof state?.sks_version === 'string' ? state.sks_version : null;
  const pid = typeof state?.pid === 'number' && Number.isInteger(state.pid) && state.pid > 1 ? state.pid : null;

  if (pid === null || !(options.processAlive || processAlive)(pid)) {
    if (!(await exists(paths.settings_path))) return skip('desktop_bridge_restage_no_managed_bridge');
    const bootstrap = await (options.bootstrapService || bootstrapExistingDesktopBridgeService)({ home })
      .catch(() => null);
    if (bootstrap?.running) {
      return {
        ok: true,
        status: 'ok',
        actions: [`desktop_bridge_bootstrapped:${version}`],
        blockers: [],
        warnings: bootstrap.blockers.map((blocker) => `desktop_bridge_restage_bootstrap_incomplete:${blocker}`)
      };
    }
    return warn([
      ...(bootstrap?.blockers || ['desktop_bridge_restage_bootstrap_failed'])
        .map((blocker) => `desktop_bridge_restage_bootstrap_incomplete:${blocker}`),
      'Desktop Bridge is installed but not running: run `sks bridge repair` from your home directory'
    ]);
  }

  if (runningVersion === version) return skip('desktop_bridge_restage_already_current');
  const uid = options.uid === undefined
    ? (typeof process.getuid === 'function' ? process.getuid() : null)
    : options.uid;
  if (uid === null) return skip('desktop_bridge_restage_no_uid');
  const kick = await (options.run || runProcess)('/bin/launchctl', ['kickstart', '-k', `gui/${uid}/com.sneakoscope.desktop-bridge`], { timeoutMs: 10_000, maxOutputBytes: 16 * 1024 }).catch(() => null);
  if (!kick || kick.code !== 0) {
    return warn([`desktop_bridge_restage_kickstart_failed:${runningVersion || 'pre-8.6.2'}`]);
  }
  return {
    ok: true, status: 'ok',
    actions: [`desktop_bridge_restarted:${runningVersion || 'pre-8.6.2'}:${version}`],
    blockers: [], warnings: []
  };
}

/**
 * The stage entry point. It takes no arguments on purpose: the migration runner
 * calls every stage as `run(root, fromVersion)`, and a stage that accepted an
 * options object in first position would silently receive the root path as its
 * configuration. Tests drive `desktopBridgeRestage` directly instead.
 */
export function runDesktopBridgeRestageStage(): Promise<DesktopBridgeRestageRun> {
  return desktopBridgeRestage();
}

function processAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}
