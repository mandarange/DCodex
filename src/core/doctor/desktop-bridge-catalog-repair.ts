import os from 'node:os';
import path from 'node:path';
import { desktopBridgeStatusV3, executeDesktopBridgeCommandV3 } from '../codex-lb/desktop-controller-v3.js';
import { bootstrapExistingDesktopBridgeService, desktopBridgeServiceStatus } from '../codex-lb/desktop-service.js';
import { desktopBridgeRuntimeVersion, desktopBridgeRuntimeVersionStale } from '../codex-lb/desktop-bridge/state.js';
import { PACKAGE_VERSION } from '../version.js';

/**
 * Restart a Desktop Bridge whose serving process predates the installed package.
 *
 * The bridge is a long-lived launchd service, so `npm i -g sneakoscope@X`
 * replaces the files on disk while the running process keeps executing the code
 * it started with. Every bridge-side fix therefore stayed invisible until
 * someone restarted it by hand, and nothing reported the mismatch.
 */
export async function restartStaleDesktopBridgeRuntime(input: {
  home: string;
  fix: boolean;
}): Promise<{ restarted: boolean; warnings: string[]; blockers: string[] }> {
  // Restarting the service shells out to the real `/bin/launchctl`, which the
  // sandboxed harnesses deliberately have no seam for. Never reach for it from
  // an isolated run: a real user environment is the only place it belongs, and
  // the only place the staleness can actually hurt.
  if (process.env.SKS_TEST_ISOLATION === '1' || process.env.SKS_RELEASE_UPGRADE_SMOKE === '1') {
    return { restarted: false, warnings: [], blockers: [] };
  }
  const service = await desktopBridgeServiceStatus({ home: input.home }).catch(() => null);
  if (!service?.running || !desktopBridgeRuntimeVersionStale(service.state)) {
    return { restarted: false, warnings: [], blockers: [] };
  }
  const running = desktopBridgeRuntimeVersion(service.state) || 'pre-8.6.2';
  if (!input.fix) {
    return {
      restarted: false,
      warnings: [],
      blockers: [`desktop_bridge_runtime_version_stale:${running}:${PACKAGE_VERSION}`]
    };
  }
  const restarted = await bootstrapExistingDesktopBridgeService({ home: input.home }).catch(() => null);
  const nowRunning = restarted?.running === true && !desktopBridgeRuntimeVersionStale(restarted.state);
  return nowRunning
    ? { restarted: true, warnings: [`desktop_bridge_runtime_restarted:${running}:${PACKAGE_VERSION}`], blockers: [] }
    : { restarted: false, warnings: [], blockers: [`desktop_bridge_runtime_version_stale:${running}:${PACKAGE_VERSION}`] };
}

/**
 * Attempts the catalog repair makes before reporting the catalog still stale.
 *
 * The desktop-bridge unification migration inside `catalog.sync` fails
 * intermittently — observed failing (with its own rollback also failing) and
 * then succeeding on the immediately following attempt, on two machines. Two
 * attempts is enough to clear that, and small enough that a genuinely broken
 * catalog is still reported promptly rather than retried in a loop.
 */
export const CATALOG_REPAIR_MAX_ATTEMPTS = 2;

export interface DesktopBridgeCatalogRepairDeps {
  restartStaleDesktopBridgeRuntimeImpl?: typeof restartStaleDesktopBridgeRuntime;
  desktopBridgeStatusImpl?: typeof desktopBridgeStatusV3;
  executeDesktopBridgeCommandImpl?: typeof executeDesktopBridgeCommandV3;
}

export interface DesktopBridgeCatalogRepairPhaseResult {
  id: 'desktop_bridge_catalog_repair';
  ok: boolean;
  repaired: boolean;
  required_for_ready: false;
  manual_required: false;
  warnings: string[];
  blockers: string[];
  rollback_evidence: string;
  skipped_reason?: string;
}

/**
 * The one Desktop Bridge repair, shared by every `--fix` entry point.
 *
 * Doctor's project `--fix` transaction and the global-only fix both call this:
 * the bridge is home-scoped global state (every bridge path derives from HOME),
 * so a repair that only ran for project-rooted doctors left home-rooted runs
 * printing `retry_catalog_sync` as a remedy no run of theirs ever executed.
 */
export async function repairDoctorDesktopBridgeCatalog(
  input: { fix: boolean },
  deps: DesktopBridgeCatalogRepairDeps = {}
): Promise<DesktopBridgeCatalogRepairPhaseResult> {
  const base = {
    id: 'desktop_bridge_catalog_repair' as const,
    required_for_ready: false as const,
    manual_required: false as const,
    warnings: [] as string[],
    rollback_evidence: 'combined_catalog_previous_generation_preserved'
  };
  // The real repair reaches `/bin/launchctl` (which addresses the operator's
  // actual gui domain regardless of any HOME redirection) and rewrites the real
  // combined catalog. Harnessed runs must only ever exercise injected impls; a
  // test that injects nothing gets a truthful no-op instead of a live mutation.
  const usingRealImpls = !deps.restartStaleDesktopBridgeRuntimeImpl
    && !deps.desktopBridgeStatusImpl
    && !deps.executeDesktopBridgeCommandImpl;
  if (
    usingRealImpls
    && (
      process.env.NODE_TEST_CONTEXT !== undefined
      || process.env.SKS_TEST_ISOLATION === '1'
      || process.env.SKS_RELEASE_UPGRADE_SMOKE === '1'
    )
  ) {
    return {
      ...base,
      ok: true,
      repaired: false,
      blockers: [],
      skipped_reason: 'desktop_bridge_catalog_repair_skipped_under_tests'
    };
  }
  const restartImpl = deps.restartStaleDesktopBridgeRuntimeImpl || restartStaleDesktopBridgeRuntime;
  const statusImpl = deps.desktopBridgeStatusImpl || desktopBridgeStatusV3;
  const executeImpl = deps.executeDesktopBridgeCommandImpl || executeDesktopBridgeCommandV3;
  try {
    // A bridge process older than the installed package keeps serving the OLD
    // code: upgrading replaces the files on disk and never restarts this
    // long-lived launchd service, so a shipped bridge fix looks like it never
    // landed. Restart it before anything else.
    // The bridge lives under the real HOME, never under the project root.
    // Every bridge path is derived from HOME (`<home>/.codex/...`); a project
    // root is not a home. Reading the status under a project root found no
    // managed bridge whenever doctor ran from inside a project — the common
    // case — so the repair concluded there was nothing to do, returned a green
    // check, and left the stale catalog untouched on every single `--fix`.
    const bridgeHome = path.resolve(process.env.HOME || os.homedir());
    const restarted = await restartImpl({
      home: bridgeHome,
      fix: input.fix
    });
    const status: any = await statusImpl({ home: bridgeHome, env: process.env });
    const blockers = (status?.readiness?.blockers || []).map(String);
    const stale = blockers.filter((blocker: string) => blocker.endsWith('_catalog_stale'));
    if (!status?.management?.managed || stale.length === 0) {
      return {
        ...base,
        ok: restarted.blockers.length === 0,
        repaired: restarted.restarted,
        warnings: restarted.warnings,
        blockers: restarted.blockers
      };
    }
    // Sync, then READ THE CATALOG BACK. Trusting the command's own ok flag
    // reported a repaired catalog that was still stale, and the unification
    // migration inside it fails intermittently — observed failing once (its
    // rollback failing too) and then succeeding on the very next attempt, on
    // two separate machines. One attempt therefore left users with a stale
    // catalog and a green check; a bounded retry clears it.
    const attempts: string[] = [];
    let syncedAndVerified = false;
    for (let attempt = 1; attempt <= CATALOG_REPAIR_MAX_ATTEMPTS; attempt += 1) {
      const sync: any = await executeImpl({ operation: 'catalog.sync' }, { home: bridgeHome, env: process.env });
      const commandOk = sync?.ok === true && sync?.execution?.ok === true;
      const after: any = await statusImpl({ home: bridgeHome, env: process.env });
      const stillStale = ((after?.readiness?.blockers || []) as unknown[])
        .map(String).filter((blocker) => blocker.endsWith('_catalog_stale'));
      if (commandOk && stillStale.length === 0) { syncedAndVerified = true; break; }
      attempts.push(`catalog_sync_attempt_${attempt}:${
        commandOk ? `still_stale:${stillStale.join(',')}` : (sync?.execution?.blockers || ['failed']).map(String).join(',')
      }`);
    }
    return {
      ...base,
      ok: syncedAndVerified && restarted.blockers.length === 0,
      repaired: syncedAndVerified || restarted.restarted,
      warnings: [...restarted.warnings, ...(syncedAndVerified ? attempts : [])],
      blockers: [
        ...(syncedAndVerified ? [] : ['desktop_bridge_catalog_still_stale_after_repair', ...attempts]),
        ...restarted.blockers
      ]
    };
  } catch (error: any) {
    return { ...base, ok: false, repaired: false, blockers: [String(error?.message || 'desktop_bridge_catalog_sync_failed')] };
  }
}
