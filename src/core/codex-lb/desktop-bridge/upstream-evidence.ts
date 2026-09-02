/**
 * Upstream-unreachable evidence, read from the Desktop Bridge's own stdout log.
 *
 * This module is deliberately import-free: the `sks doctor --json` fast path
 * (`src/bin/fast-inline.ts`) loads it under a ~1.2 s budget, and the doctor
 * repair in `src/core/doctor/desktop-bridge-catalog-repair.ts` shares the same
 * judgment so the two surfaces can never disagree about what counts.
 */

/**
 * How far back a `bridge_upstream_unavailable` rejection in the bridge's own
 * log still counts as evidence that the serving process is dialing a dead
 * pinned address. The pin is resolved once at bridge start, so a network
 * change (VPN flip, Wi-Fi swap, CDN rotation) strands it; recent rejections
 * are the one durable trace of that state, and they are exactly what the
 * operator is looking at when they run doctor. Older entries describe a
 * network the machine may no longer be on.
 */
export const BRIDGE_UNREACHABLE_EVIDENCE_WINDOW_MS = 10 * 60_000;
/** Enough tail to hold ten minutes of a rejection storm at the logger's burst+summary rate. */
export const BRIDGE_LOG_TAIL_BYTES = 256 * 1024;
const UNREACHABLE_REJECTION_CODE = /^bridge_(?:websocket_)?upstream_unavailable/;
/**
 * The bridge writes this when it re-resolved a dead pin and dialed the fresh
 * address; a failure after it produces a NEWER unavailable line. So the latest
 * reroute standing after the latest failure means the process already healed
 * itself, and a restart would only interrupt live requests.
 */
const REROUTED_REJECTION_CODE = /^bridge_upstream_unreachable_rerouted/;

/**
 * Scan a bridge stdout-log tail for upstream-unreachable rejections emitted by
 * the CURRENT serving process within the evidence window. Returns the most
 * recent matching rejection code, or null when the log holds no such evidence
 * — including when the bridge re-resolved its pin after the last failure.
 */
export function detectUnreachableUpstreamEvidence(
  logTail: string,
  startedAt: string | null | undefined,
  nowMs: number
): string | null {
  const startedMs = startedAt ? Date.parse(startedAt) : Number.NaN;
  const cutoffMs = Math.max(Number.isFinite(startedMs) ? startedMs : 0, nowMs - BRIDGE_UNREACHABLE_EVIDENCE_WINDOW_MS);
  let latest: { at: number; code: string } | null = null;
  let latestReroute = Number.NEGATIVE_INFINITY;
  for (const line of logTail.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{') || !trimmed.includes('"sks.desktop_bridge.rejected')) continue;
    let record: { event?: unknown; code?: unknown; at?: unknown };
    try { record = JSON.parse(trimmed) as typeof record; } catch { continue; }
    if (record.event !== 'sks.desktop_bridge.rejected' && record.event !== 'sks.desktop_bridge.rejected_summary') continue;
    const code = typeof record.code === 'string' ? record.code : '';
    const unreachable = UNREACHABLE_REJECTION_CODE.test(code);
    const rerouted = !unreachable && REROUTED_REJECTION_CODE.test(code);
    if (!unreachable && !rerouted) continue;
    const at = typeof record.at === 'string' ? Date.parse(record.at) : Number.NaN;
    if (!Number.isFinite(at) || at < cutoffMs) continue;
    if (rerouted) { latestReroute = Math.max(latestReroute, at); continue; }
    if (!latest || at > latest.at) latest = { at, code };
  }
  if (!latest || latest.at <= latestReroute) return null;
  return latest.code;
}

/** The operator-facing remedy, worded once for every surface that names the evidence. */
export const UNREACHABLE_UPSTREAM_RECOVERY_ACTION =
  'Run `sks doctor --fix` (or `sks bridge repair`) to restart the Desktop Bridge and re-resolve its upstream address.';
