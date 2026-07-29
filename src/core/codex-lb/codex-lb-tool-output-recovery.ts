import { codexLbBaseUrlSecurityBlocker, normalizeCodexLbBaseUrl } from './codex-lb-env.js';
import { redactString } from '../secret-redaction.js';

export const CODEX_LB_TOOL_OUTPUT_RECOVERY_SCHEMA = 'sks.codex-lb-tool-output-recovery.v1';
export const CODEX_LB_TOOL_OUTPUT_RECOVERY_MIN_VERSION = '1.21.0-beta.3';
export const CODEX_LB_TOOL_OUTPUT_RECOVERY_OVERRIDE_ENV = 'SKS_ALLOW_UNVERIFIED_CODEX_LB_RECOVERY';
export const CODEX_LB_TOOL_OUTPUT_RECOVERY_OVERRIDE_FLAG = '--allow-unverified-codex-lb-recovery';

export type CodexLbToolOutputRecoveryStatus =
  | 'compatible'
  | 'version_too_old'
  | 'version_unverified'
  | 'probe_unavailable'
  | 'invalid_base_url'
  | 'transport_blocked'
  | 'skipped_reserved_host'
  | 'not_selected'
  | 'not_checked'
  | 'override_acknowledged';

export interface CodexLbToolOutputRecoveryProbe {
  schema: typeof CODEX_LB_TOOL_OUTPUT_RECOVERY_SCHEMA;
  ok: boolean;
  required: boolean;
  status: CodexLbToolOutputRecoveryStatus;
  base_url: string | null;
  health_url: string | null;
  observed_version: string | null;
  minimum_version: typeof CODEX_LB_TOOL_OUTPUT_RECOVERY_MIN_VERSION;
  version_header: 'x-app-version';
  supports_interrupted_tool_output_recovery: boolean | null;
  verified: boolean;
  override_acknowledged: boolean;
  test_bypass: boolean;
  http_status: number | null;
  blockers: string[];
  warnings: string[];
  operator_actions: string[];
  error?: string;
}

export interface CodexLbToolOutputRecoveryProbeOptions {
  baseUrl?: unknown;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  allowUnverified?: boolean;
  allowReservedTestHostBypass?: boolean;
}

const UPGRADE_ACTION = `Upgrade codex-lb to ${CODEX_LB_TOOL_OUTPUT_RECOVERY_MIN_VERSION} or later, then rerun \`sks codex-lb status\`.`;
const OAUTH_ACTION = 'To bypass codex-lb routing while preserving ChatGPT OAuth, run `sks codex-lb disable`; SKS will not change routing silently.';
const FRESH_THREAD_ACTION = 'After upgrading or switching providers, open a fresh Codex thread and continue the persisted mission; do not replay the corrupted turn.';

export async function probeCodexLbToolOutputRecovery(
  opts: CodexLbToolOutputRecoveryProbeOptions = {}
): Promise<CodexLbToolOutputRecoveryProbe> {
  const baseUrl = normalizeCodexLbBaseUrl(opts.baseUrl);
  if (!baseUrl) {
    return blockedProbe('invalid_base_url', {
      baseUrl: null,
      healthUrl: null,
      blockers: ['codex_lb_tool_output_recovery_base_url_missing']
    });
  }
  const transportBlocker = codexLbBaseUrlSecurityBlocker(baseUrl);
  if (transportBlocker) {
    return blockedProbe('transport_blocked', {
      baseUrl,
      healthUrl: codexLbHealthUrl(baseUrl),
      blockers: [transportBlocker]
    });
  }
  const healthUrl = codexLbHealthUrl(baseUrl);
  if (!healthUrl) {
    return blockedProbe('invalid_base_url', {
      baseUrl,
      healthUrl: null,
      blockers: ['codex_lb_tool_output_recovery_base_url_invalid']
    });
  }
  if (opts.allowReservedTestHostBypass === true && isReservedTestHost(baseUrl)) {
    return {
      ...baseProbe(baseUrl, healthUrl),
      ok: true,
      status: 'skipped_reserved_host',
      required: false,
      test_bypass: true
    };
  }
  const fetchImpl = opts.fetchImpl || globalThis.fetch;
  if (typeof fetchImpl !== 'function') {
    return applyCodexLbToolOutputRecoveryOverride(blockedProbe('probe_unavailable', {
      baseUrl,
      healthUrl,
      blockers: ['codex_lb_tool_output_recovery_probe_unavailable']
    }), opts.allowUnverified === true);
  }

  const controller = new AbortController();
  const timeoutMs = Math.max(250, Number(opts.timeoutMs || 4_000));
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref?.();
  try {
    const response = await fetchImpl(healthUrl, {
      method: 'GET',
      headers: { accept: 'application/json' },
      redirect: 'error',
      signal: controller.signal
    });
    if (!response.ok) {
      return applyCodexLbToolOutputRecoveryOverride(blockedProbe('probe_unavailable', {
        baseUrl,
        healthUrl,
        httpStatus: response.status,
        blockers: [`codex_lb_tool_output_recovery_health_http_error:${response.status}`]
      }), opts.allowUnverified === true);
    }
    const observedVersion = normalizeCodexLbVersion(response.headers.get('x-app-version'));
    if (!observedVersion) {
      return applyCodexLbToolOutputRecoveryOverride(blockedProbe('version_unverified', {
        baseUrl,
        healthUrl,
        httpStatus: response.status,
        blockers: ['codex_lb_tool_output_recovery_version_unverified']
      }), opts.allowUnverified === true);
    }
    const compatible = compareCodexLbVersions(observedVersion, CODEX_LB_TOOL_OUTPUT_RECOVERY_MIN_VERSION) >= 0;
    const result: CodexLbToolOutputRecoveryProbe = {
      ...baseProbe(baseUrl, healthUrl),
      ok: compatible,
      status: compatible ? 'compatible' : 'version_too_old',
      observed_version: observedVersion,
      supports_interrupted_tool_output_recovery: compatible,
      verified: true,
      http_status: response.status,
      blockers: compatible ? [] : ['codex_lb_tool_output_recovery_version_too_old']
    };
    return applyCodexLbToolOutputRecoveryOverride(result, opts.allowUnverified === true);
  } catch (err: unknown) {
    const error = err instanceof Error
      ? err.name === 'AbortError' ? 'codex-lb health probe timed out' : redactCodexLbProbeText(err.message)
      : redactCodexLbProbeText(String(err));
    return applyCodexLbToolOutputRecoveryOverride(blockedProbe('probe_unavailable', {
      baseUrl,
      healthUrl,
      blockers: ['codex_lb_tool_output_recovery_probe_failed'],
      error
    }), opts.allowUnverified === true);
  } finally {
    clearTimeout(timer);
  }
}

export function codexLbToolOutputRecoveryNotSelected(): CodexLbToolOutputRecoveryProbe {
  return {
    ...baseProbe(null, null),
    ok: true,
    required: false,
    status: 'not_selected'
  };
}

export function codexLbToolOutputRecoveryNotChecked(required = false): CodexLbToolOutputRecoveryProbe {
  return {
    ...baseProbe(null, null),
    ok: !required,
    required,
    status: 'not_checked',
    blockers: required ? ['codex_lb_tool_output_recovery_not_checked'] : []
  };
}

export function codexLbToolOutputRecoveryOverrideAcknowledged(input: {
  args?: readonly unknown[];
  env?: NodeJS.ProcessEnv;
} = {}): boolean {
  const args = (input.args || []).map((arg) => String(arg));
  const env = input.env || process.env;
  return args.includes(CODEX_LB_TOOL_OUTPUT_RECOVERY_OVERRIDE_FLAG)
    || env[CODEX_LB_TOOL_OUTPUT_RECOVERY_OVERRIDE_ENV] === '1';
}

export function applyCodexLbToolOutputRecoveryOverride(
  probe: CodexLbToolOutputRecoveryProbe,
  acknowledged: boolean
): CodexLbToolOutputRecoveryProbe {
  if (probe.ok || !acknowledged) return probe;
  return {
    ...probe,
    ok: true,
    status: 'override_acknowledged',
    override_acknowledged: true,
    blockers: [],
    warnings: [
      ...probe.warnings,
      `Operator explicitly acknowledged unverified codex-lb tool-output recovery via ${CODEX_LB_TOOL_OUTPUT_RECOVERY_OVERRIDE_FLAG} or ${CODEX_LB_TOOL_OUTPUT_RECOVERY_OVERRIDE_ENV}=1.`,
      ...probe.blockers
    ]
  };
}

export function codexLbHealthUrl(baseUrl: unknown): string | null {
  try {
    const parsed = new URL(normalizeCodexLbBaseUrl(baseUrl));
    return new URL('/health', parsed.origin).toString();
  } catch {
    return null;
  }
}

export function normalizeCodexLbVersion(value: unknown): string | null {
  const match = String(value || '').trim().match(/v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/);
  if (!match) return null;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  const patch = Number(match[3]);
  if (![major, minor, patch].every(Number.isSafeInteger)) return null;
  return `${major}.${minor}.${patch}${match[4] ? `-${match[4]}` : ''}`;
}

export function compareCodexLbVersions(left: unknown, right: unknown): number {
  const a = parseVersion(left);
  const b = parseVersion(right);
  if (!a || !b) return -1;
  for (let index = 0; index < 3; index += 1) {
    const delta = (a.core[index] || 0) - (b.core[index] || 0);
    if (delta !== 0) return delta > 0 ? 1 : -1;
  }
  if (!a.pre.length && !b.pre.length) return 0;
  if (!a.pre.length) return 1;
  if (!b.pre.length) return -1;
  const length = Math.max(a.pre.length, b.pre.length);
  for (let index = 0; index < length; index += 1) {
    const aPart = a.pre[index];
    const bPart = b.pre[index];
    if (aPart === undefined) return -1;
    if (bPart === undefined) return 1;
    if (aPart === bPart) continue;
    const aNumber = /^\d+$/.test(aPart) ? Number(aPart) : null;
    const bNumber = /^\d+$/.test(bPart) ? Number(bPart) : null;
    if (aNumber !== null && bNumber !== null) return aNumber > bNumber ? 1 : -1;
    if (aNumber !== null) return -1;
    if (bNumber !== null) return 1;
    return aPart > bPart ? 1 : -1;
  }
  return 0;
}

function baseProbe(baseUrl: string | null, healthUrl: string | null): CodexLbToolOutputRecoveryProbe {
  return {
    schema: CODEX_LB_TOOL_OUTPUT_RECOVERY_SCHEMA,
    ok: false,
    required: true,
    status: 'version_unverified',
    base_url: redactCodexLbProbeUrl(baseUrl),
    health_url: redactCodexLbProbeUrl(healthUrl),
    observed_version: null,
    minimum_version: CODEX_LB_TOOL_OUTPUT_RECOVERY_MIN_VERSION,
    version_header: 'x-app-version',
    supports_interrupted_tool_output_recovery: null,
    verified: false,
    override_acknowledged: false,
    test_bypass: false,
    http_status: null,
    blockers: [],
    warnings: [],
    operator_actions: [UPGRADE_ACTION, OAUTH_ACTION, FRESH_THREAD_ACTION]
  };
}

function blockedProbe(
  status: CodexLbToolOutputRecoveryStatus,
  input: {
    baseUrl: string | null;
    healthUrl: string | null;
    blockers: string[];
    httpStatus?: number;
    error?: string;
  }
): CodexLbToolOutputRecoveryProbe {
  return {
    ...baseProbe(input.baseUrl, input.healthUrl),
    status,
    blockers: input.blockers,
    ...(input.httpStatus === undefined ? {} : { http_status: input.httpStatus }),
    ...(input.error === undefined ? {} : { error: redactCodexLbProbeText(input.error) })
  };
}

function redactCodexLbProbeUrl(value: string | null): string | null {
  if (!value) return null;
  try {
    const parsed = new URL(value);
    parsed.username = '';
    parsed.password = '';
    parsed.hash = '';
    for (const key of [...parsed.searchParams.keys()]) {
      if (/(?:access[_-]?token|api[_-]?key|secret|password|token|credential)/i.test(key)) {
        parsed.searchParams.set(key, 'redacted');
      }
    }
    return redactCodexLbProbeText(parsed.toString());
  } catch {
    return redactCodexLbProbeText(value);
  }
}

function redactCodexLbProbeText(value: unknown): string {
  return redactString(String(value || ''))
    .replace(/([a-z][a-z0-9+.-]*:\/\/)[^/@\s]+@/gi, '$1[redacted]@')
    .replace(/([?&](?:access[_-]?token|api[_-]?key|secret|password|token|credential)=)[^&#\s]*/gi, '$1[redacted]')
    .replace(/(\b(?:access[_-]?token|api[_-]?key|secret|password|token|credential)\s*[:=]\s*)(?:\[redacted\]|"[^"]*"|'[^']*'|[^\s,;}\]]+)/gi, '$1[redacted]');
}

function parseVersion(value: unknown): { core: [number, number, number]; pre: string[] } | null {
  const normalized = normalizeCodexLbVersion(value);
  if (!normalized) return null;
  const [coreText = '', preText = ''] = normalized.split('-', 2);
  const coreParts = coreText.split('.').map(Number);
  const major = coreParts[0];
  const minor = coreParts[1];
  const patch = coreParts[2];
  if (major === undefined || minor === undefined || patch === undefined) return null;
  return { core: [major, minor, patch], pre: preText ? preText.split('.') : [] };
}

function isReservedTestHost(baseUrl: string): boolean {
  try {
    const hostname = new URL(baseUrl).hostname.toLowerCase();
    return hostname === 'example.test'
      || hostname.endsWith('.example.test')
      || hostname === 'example.invalid'
      || hostname.endsWith('.example.invalid')
      || hostname === 'example.com'
      || hostname.endsWith('.example.com')
      || hostname === 'example.org'
      || hostname.endsWith('.example.org')
      || hostname === 'example.net'
      || hostname.endsWith('.example.net');
  } catch {
    return false;
  }
}
