import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { desktopBridgeStatusV3, executeDesktopBridgeCommandV3 } from '../codex-lb/desktop-controller-v3.js';
import { bootstrapExistingDesktopBridgeService, desktopBridgeServicePaths, desktopBridgeServiceStatus } from '../codex-lb/desktop-service.js';
import { desktopBridgeRuntimeVersion, desktopBridgeRuntimeVersionStale, readDesktopBridgeState } from '../codex-lb/desktop-bridge/state.js';
import { BRIDGE_LOG_TAIL_BYTES, detectUnreachableUpstreamEvidence } from '../codex-lb/desktop-bridge/upstream-evidence.js';
import { PACKAGE_VERSION } from '../version.js';

export { BRIDGE_UNREACHABLE_EVIDENCE_WINDOW_MS, detectUnreachableUpstreamEvidence } from '../codex-lb/desktop-bridge/upstream-evidence.js';

/**
 * Read-only evidence for doctor's status inspection: the serving process's
 * state file gives its start time, its stdout log gives the rejections. No
 * launchctl, no probes, no network — so a plain `sks doctor` can name a
 * stranded bridge instead of reporting a green check.
 */
export async function readDesktopBridgeUnreachableUpstreamEvidence(
  home: string,
  deps: { readLogTailImpl?: typeof readBridgeLogTail; nowMs?: () => number } = {}
): Promise<{ code: string; started_at: string } | null> {
  const paths = desktopBridgeServicePaths(home);
  const state = await readDesktopBridgeState(paths.state_path).catch(() => null);
  if (!state) return null;
  const tail = await (deps.readLogTailImpl || readBridgeLogTail)(paths.stdout_log_path, BRIDGE_LOG_TAIL_BYTES).catch(() => '');
  const code = detectUnreachableUpstreamEvidence(tail, state.started_at, (deps.nowMs || Date.now)());
  return code ? { code, started_at: state.started_at } : null;
}

async function readBridgeLogTail(logPath: string, maxBytes: number): Promise<string> {
  const handle = await fsp.open(logPath, 'r');
  try {
    const { size } = await handle.stat();
    const start = Math.max(0, size - maxBytes);
    const buffer = Buffer.alloc(size - start);
    await handle.read(buffer, 0, buffer.length, start);
    return buffer.toString('utf8');
  } finally {
    await handle.close();
  }
}

export interface StaleBridgeRestartDeps {
  serviceStatusImpl?: typeof desktopBridgeServiceStatus;
  bootstrapImpl?: typeof bootstrapExistingDesktopBridgeService;
  readLogTailImpl?: typeof readBridgeLogTail;
  nowMs?: () => number;
}

/**
 * Restart a Desktop Bridge whose serving process predates the installed
 * package, OR whose own log shows it recently dialing an unreachable upstream.
 *
 * The bridge is a long-lived launchd service, so `npm i -g sneakoscope@X`
 * replaces the files on disk while the running process keeps executing the code
 * it started with. Every bridge-side fix therefore stayed invisible until
 * someone restarted it by hand, and nothing reported the mismatch.
 *
 * The unreachable-upstream case is the same shape from the other side: the
 * serving process pinned its upstream addresses at start, the network changed
 * underneath it, and every readiness surface stayed green because nothing
 * consumed the `bridge_upstream_unavailable:EHOSTUNREACH` evidence the bridge
 * itself was writing. A restart re-resolves the pins; without `fix` the
 * evidence is at least surfaced as a blocker instead of a green check.
 */
export async function restartStaleDesktopBridgeRuntime(input: {
  home: string;
  fix: boolean;
}, deps: StaleBridgeRestartDeps = {}): Promise<{ restarted: boolean; warnings: string[]; blockers: string[] }> {
  // Restarting the service shells out to the real `/bin/launchctl`, which the
  // sandboxed harnesses deliberately have no seam for. Never reach for it from
  // an isolated run: a real user environment is the only place it belongs, and
  // the only place the staleness can actually hurt. Injected impls are the
  // harness's own seams and stay exercisable.
  const usingRealImpls = !deps.serviceStatusImpl && !deps.bootstrapImpl && !deps.readLogTailImpl;
  if (usingRealImpls && (process.env.SKS_TEST_ISOLATION === '1' || process.env.SKS_RELEASE_UPGRADE_SMOKE === '1')) {
    return { restarted: false, warnings: [], blockers: [] };
  }
  const service = await (deps.serviceStatusImpl || desktopBridgeServiceStatus)({ home: input.home }).catch(() => null);
  if (!service?.running) return { restarted: false, warnings: [], blockers: [] };
  const versionStale = desktopBridgeRuntimeVersionStale(service.state);
  let unreachable: string | null = null;
  if (!versionStale) {
    const logPath = service.paths?.stdout_log_path;
    const tail = logPath
      ? await (deps.readLogTailImpl || readBridgeLogTail)(logPath, BRIDGE_LOG_TAIL_BYTES).catch(() => '')
      : '';
    unreachable = detectUnreachableUpstreamEvidence(tail, service.state?.started_at, (deps.nowMs || Date.now)());
    if (!unreachable) return { restarted: false, warnings: [], blockers: [] };
  }
  const running = desktopBridgeRuntimeVersion(service.state) || 'pre-8.6.2';
  const blocker = versionStale
    ? `desktop_bridge_runtime_version_stale:${running}:${PACKAGE_VERSION}`
    : `desktop_bridge_upstream_unreachable:${unreachable}`;
  if (!input.fix) {
    return { restarted: false, warnings: [], blockers: [blocker] };
  }
  const restarted = await (deps.bootstrapImpl || bootstrapExistingDesktopBridgeService)({ home: input.home }).catch(() => null);
  const nowRunning = restarted?.running === true && !desktopBridgeRuntimeVersionStale(restarted.state);
  if (!nowRunning) return { restarted: false, warnings: [], blockers: [blocker] };
  return {
    restarted: true,
    warnings: [versionStale
      ? `desktop_bridge_runtime_restarted:${running}:${PACKAGE_VERSION}`
      : `desktop_bridge_upstream_unreachable_restarted:${unreachable}`],
    blockers: []
  };
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
    const reverify = { fix: input.fix, bridgeHome, restarted: restarted.restarted };
    if (!status?.management?.managed || stale.length === 0) {
      return reverifyTransportIfDegraded({
        ...base,
        ok: restarted.blockers.length === 0,
        repaired: restarted.restarted,
        warnings: restarted.warnings,
        blockers: restarted.blockers
      }, reverify, statusImpl, executeImpl);
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
    return reverifyTransportIfDegraded({
      ...base,
      ok: syncedAndVerified && restarted.blockers.length === 0,
      repaired: syncedAndVerified || restarted.restarted,
      warnings: [...restarted.warnings, ...(syncedAndVerified ? attempts : [])],
      blockers: [
        ...(syncedAndVerified ? [] : ['desktop_bridge_catalog_still_stale_after_repair', ...attempts]),
        ...restarted.blockers
      ]
    }, reverify, statusImpl, executeImpl);
  } catch (error: any) {
    return { ...base, ok: false, repaired: false, blockers: [String(error?.message || 'desktop_bridge_catalog_sync_failed')] };
  }
}

/**
 * Bring readiness back to `ready` after the repair, not just to "running".
 *
 * Readiness needs a transport-level diagnostic bound to the CURRENT serving
 * process. A restart — by version skew, by the unreachable-upstream evidence
 * above, or by `sks update` — produces a new process generation with no such
 * diagnostic, and nothing in `--fix` or the update ever ran one, so every
 * repaired machine finished on a truthful-but-alarming `degraded` until
 * someone happened to run `sks bridge verify --level transport`. Run it here,
 * under `fix` only: the read-only doctor must not fire live probes. Never a
 * blocker — the probes' own verdict lands in readiness, which the caller reads.
 */
async function reverifyTransportIfDegraded(
  result: DesktopBridgeCatalogRepairPhaseResult,
  input: { fix: boolean; bridgeHome: string; restarted: boolean },
  statusImpl: typeof desktopBridgeStatusV3,
  executeImpl: typeof executeDesktopBridgeCommandV3
): Promise<DesktopBridgeCatalogRepairPhaseResult> {
  if (!input.fix) return result;
  const before: any = await statusImpl({ home: input.bridgeHome, env: process.env }).catch(() => null);
  const serving = before?.service?.state === 'ready' || before?.service?.running === true;
  const degraded = before?.readiness?.state === 'degraded';
  if (before?.management?.managed !== true || !serving || (!degraded && !input.restarted)) return result;
  await executeImpl({ operation: 'verify', level: 'transport' }, { home: input.bridgeHome, env: process.env }).catch(() => null);
  const after: any = await statusImpl({ home: input.bridgeHome, env: process.env }).catch(() => null);
  const afterState = String(after?.readiness?.state || 'unknown');
  return {
    ...result,
    repaired: result.repaired || (degraded && afterState === 'ready'),
    warnings: [
      ...result.warnings,
      afterState === 'ready' ? 'desktop_bridge_transport_reverified' : `desktop_bridge_transport_reverify_incomplete:${afterState}`
    ]
  };
}
