import { PACKAGE_VERSION } from '../../version.js';

/**
 * Structured logging for rejected bridge requests.
 *
 * The bridge emitted exactly one line in its whole lifetime — `started` — and
 * nothing when it refused a request. A refusal was visible only to the client
 * that received it, so a bridge rejecting every request looked identical in the
 * logs to one serving them perfectly. Diagnosing
 * `bridge_codex_session_identity_mismatch` required reading the source and
 * reproducing it by hand because no record of the rejections existed.
 *
 * Two properties are non-negotiable here:
 *
 * - **No secrets.** Only the error code, transport, method and pathname are
 *   recorded. Never headers, bodies, query strings, credentials or origins —
 *   a bridge log sits in `~/.codex/sks/logs` and is routinely pasted into bug
 *   reports.
 * - **Bounded.** A client in a reconnect loop can rejrequest thousands of times
 *   a minute. Each error code gets a small burst allowance and then one periodic
 *   summary line, so a storm costs a bounded number of lines instead of filling
 *   the disk.
 */
export const DESKTOP_BRIDGE_LOG_SCHEMA = 'sks.desktop-bridge-log.v2' as const;

/** Lines emitted per error code before summarising. */
export const REJECTION_LOG_BURST = 5;
/** How often a suppressed code re-emits a summary line. */
export const REJECTION_LOG_SUMMARY_INTERVAL_MS = 60_000;

export interface DesktopBridgeRejectionEvent {
  readonly code: string;
  readonly transport: 'http' | 'websocket';
  readonly method?: string | undefined;
  readonly url?: string | undefined;
  readonly status?: number | undefined;
  /** Which provider answered. A catalog-published id, never a secret. */
  readonly provider_id?: string | undefined;
  /** The public model the request was routed for — the one fact a user report
   * with only a cf-ray id cannot supply. Catalog-published, never a secret. */
  readonly public_model?: string | undefined;
}

/** Catalog-published identifiers: bounded, control-characters stripped, nothing else. */
function safeCatalogId(value: unknown): string | null {
  const text = String(value ?? '').replace(/[\r\n\0]/g, '').trim().slice(0, 128);
  return text.length > 0 ? text : null;
}

interface CodeWindow {
  emitted: number;
  suppressed: number;
  windowStartedMs: number;
}

/**
 * A query string can carry a capability token — the bridge's own client base
 * path is a secret — so only the path is ever recorded, and only when it is
 * a plain absolute path.
 */
function safePathname(url: string | undefined): string | null {
  const raw = String(url || '').trim();
  if (!raw.startsWith('/')) return null;
  const pathname = raw.split(/[?#]/)[0] || '';
  if (!pathname || pathname.length > 512 || /[\r\n\0]/.test(pathname)) return null;
  // The per-client capability segment is high-entropy and secret; redact any
  // path segment that looks like one rather than logging it.
  return pathname
    .split('/')
    .map((segment) => (segment.length >= 24 && /^[A-Za-z0-9_-]+$/.test(segment) ? '<redacted>' : segment))
    .join('/');
}

function safeMethod(method: string | undefined): string | null {
  const value = String(method || '').trim().toUpperCase();
  return /^[A-Z]{3,10}$/.test(value) ? value : null;
}

export function createDesktopBridgeRejectionLogger(options: {
  write?: (line: string) => void;
  now?: () => number;
  burst?: number;
  summaryIntervalMs?: number;
} = {}) {
  const write = options.write || ((line: string) => process.stdout.write(line));
  const now = options.now || (() => Date.now());
  const burst = Math.max(1, options.burst ?? REJECTION_LOG_BURST);
  const summaryIntervalMs = Math.max(1_000, options.summaryIntervalMs ?? REJECTION_LOG_SUMMARY_INTERVAL_MS);
  const windows = new Map<string, CodeWindow>();

  function emit(payload: Record<string, unknown>): void {
    try {
      write(`${JSON.stringify({
        schema: DESKTOP_BRIDGE_LOG_SCHEMA,
        sks_version: PACKAGE_VERSION,
        // The 2026-08 restart-storm forensics had to reconstruct 14 hours of
        // timeline from serve-state blobs because no rejection record carried a
        // wall clock. Every record now stamps one.
        at: new Date(now()).toISOString(),
        secret_fields_redacted: true,
        ...payload,
      })}\n`);
    } catch {
      // Logging must never take the bridge down; a failed write is dropped.
    }
  }

  return function logRejection(event: DesktopBridgeRejectionEvent): void {
    const code = String(event.code || 'bridge_rejected').slice(0, 128).replace(/[\r\n\0]/g, '');
    const at = now();
    const window = windows.get(code) || { emitted: 0, suppressed: 0, windowStartedMs: at };
    if (at - window.windowStartedMs >= summaryIntervalMs) {
      if (window.suppressed > 0) {
        emit({
          event: 'sks.desktop_bridge.rejected_summary',
          code,
          suppressed: window.suppressed,
          window_ms: at - window.windowStartedMs,
        });
      }
      window.emitted = 0;
      window.suppressed = 0;
      window.windowStartedMs = at;
    }
    if (window.emitted >= burst) {
      window.suppressed += 1;
      windows.set(code, window);
      return;
    }
    window.emitted += 1;
    windows.set(code, window);
    const pathname = safePathname(event.url);
    const method = safeMethod(event.method);
    const providerId = safeCatalogId(event.provider_id);
    const publicModel = safeCatalogId(event.public_model);
    emit({
      event: 'sks.desktop_bridge.rejected',
      code,
      transport: event.transport,
      ...(method ? { method } : {}),
      ...(pathname ? { pathname } : {}),
      ...(Number.isInteger(event.status) ? { status: event.status } : {}),
      ...(providerId ? { provider_id: providerId } : {}),
      ...(publicModel ? { public_model: publicModel } : {}),
    });
  };
}
