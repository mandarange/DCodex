import os from 'node:os';
import path from 'node:path';
import { exists, PACKAGE_VERSION, readJson, runProcess } from '../../fsx.js';

export interface DesktopBridgeRestageRun {
  ok: boolean;
  status: 'ok' | 'skipped' | 'failed';
  actions: string[];
  blockers: string[];
  warnings: string[];
}

/**
 * Restart a Desktop Bridge that is still serving code older than the package
 * this update just installed.
 *
 * The bridge is a launchd service: `npm install` replaces the files on disk and
 * never touches the running process, so every bridge fix shipped in an upgrade
 * stayed invisible until someone happened to run `doctor --fix`. Users kept
 * reporting bugs that were already fixed — each report was true of their
 * running process and false of their installed package. The bridge now also
 * self-converges on a timer; this stage is the immediate path for the update
 * the user is running right now.
 *
 * Guards, in order, and why each one exists:
 * - not under `node --test` (NODE_TEST_CONTEXT): launchctl addresses the real
 *   gui domain regardless of any HOME redirection, so a test that exercises the
 *   update flow must never reach the operator's actual service.
 * - state file must record a live pid whose version differs from this package:
 *   the state file is HOME-derived, written only by a running bridge, and
 *   carries the running version — absent, dead, or current means nothing to do.
 * - `kickstart -k` only, never bootout: it restarts the exact loaded service in
 *   place, and if the service is not loaded it fails without side effects.
 */
export async function runDesktopBridgeRestageStage(): Promise<DesktopBridgeRestageRun> {
  const skip = (reason: string): DesktopBridgeRestageRun =>
    ({ ok: true, status: 'ok', actions: [reason], blockers: [], warnings: [] });
  if (process.platform !== 'darwin') return skip('desktop_bridge_restage_not_macos');
  if (process.env.NODE_TEST_CONTEXT !== undefined) return skip('desktop_bridge_restage_skipped_under_tests');
  if (process.env.SKS_SKIP_BRIDGE_RESTAGE === '1') return skip('desktop_bridge_restage_disabled');
  const home = os.homedir();
  const plist = path.join(home, 'Library', 'LaunchAgents', 'com.sneakoscope.desktop-bridge.plist');
  if (!(await exists(plist))) return skip('desktop_bridge_restage_no_launch_agent');
  const state = await readJson(path.join(home, '.codex', 'sks', 'desktop-bridge-state.json'), null) as { sks_version?: unknown; pid?: unknown } | null;
  const runningVersion = typeof state?.sks_version === 'string' ? state.sks_version : null;
  const pid = typeof state?.pid === 'number' && Number.isInteger(state.pid) && state.pid > 1 ? state.pid : null;
  if (!pid) return skip('desktop_bridge_restage_no_running_bridge');
  try { process.kill(pid, 0); } catch { return skip('desktop_bridge_restage_no_running_bridge'); }
  if (runningVersion === PACKAGE_VERSION) return skip('desktop_bridge_restage_already_current');
  const uid = typeof process.getuid === 'function' ? process.getuid() : null;
  if (uid === null) return skip('desktop_bridge_restage_no_uid');
  const kick = await runProcess('/bin/launchctl', ['kickstart', '-k', `gui/${uid}/com.sneakoscope.desktop-bridge`], { timeoutMs: 10_000, maxOutputBytes: 16 * 1024 }).catch(() => null);
  if (!kick || kick.code !== 0) {
    return {
      ok: true, status: 'ok',
      actions: [],
      blockers: [],
      warnings: [`desktop_bridge_restage_kickstart_failed:${runningVersion || 'pre-8.6.2'}`]
    };
  }
  return {
    ok: true, status: 'ok',
    actions: [`desktop_bridge_restarted:${runningVersion || 'pre-8.6.2'}:${PACKAGE_VERSION}`],
    blockers: [], warnings: []
  };
}
