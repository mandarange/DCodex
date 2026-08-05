import { CURRENT_CODEX_RELEASE_MANIFEST } from './codex-release-manifest.js';

export const CODEX_COMPAT_SCHEMA = 'sks.codex-compat.v2';
/** Preferred / recommended latest channel (package-tracked), not an exclusive lock. */
export const CODEX_REQUIRED_BASELINE_TAG = CURRENT_CODEX_RELEASE_MANIFEST.targetTag;
export const CODEX_REQUIRED_VERSION = CURRENT_CODEX_RELEASE_MANIFEST.preferredCliVersion
  || CURRENT_CODEX_RELEASE_MANIFEST.requiredCliVersion;
export const CODEX_PREFERRED_VERSION = CODEX_REQUIRED_VERSION;
export const CODEX_MINIMUM_SUPPORTED_VERSION = CURRENT_CODEX_RELEASE_MANIFEST.minimumSupportedVersion;
export const CODEX_HOOK_SCHEMA_BASELINE_TAG = CURRENT_CODEX_RELEASE_MANIFEST.targetTag;
export const CODEX_HOOK_SCHEMA_VERSION = CURRENT_CODEX_RELEASE_MANIFEST.targetTag;

const UPDATE_CTA = 'prefer latest Codex CLI via `sks codex update` or Menu Bar / SKS Center → Update Codex CLI Now';

export function compareSemverLike(a: unknown, b: unknown): number {
  const pa = parseVersionParts(a);
  const pb = parseVersionParts(b);
  for (let i = 0; i < Math.max(pa.length, pb.length, 3); i += 1) {
    const left = pa[i] ?? 0;
    const right = pb[i] ?? 0;
    if (left > right) return 1;
    if (left < right) return -1;
  }
  return 0;
}

export function parseCodexVersionText(text: unknown): string | null {
  const match = String(text || '').match(/\b(?:rust-v)?(\d+\.\d+\.\d+)(?:[-+][0-9A-Za-z.-]+)?\b/);
  return match?.[1] ?? null;
}

export function requiredCodexVersionFromBaseline(value: unknown): string {
  return parseCodexVersionText(value) || CODEX_PREFERRED_VERSION;
}

export type CodexVersionPolicyStatus =
  | 'ok'
  | 'integration_optional'
  | 'blocked_below_minimum_supported'
  | 'blocked_below_required_baseline'
  | 'blocked_missing_required_codex';

/**
 * Current-release policy: SKS supports the package-tracked Codex release only.
 * Missing Codex remains optional for routes that do not invoke it, but an
 * installed older runtime is rejected instead of entering a compatibility path.
 */
export function codexVersionPolicy(
  detected: { available?: boolean; version?: string | null; source?: string | null } = {},
  opts: {
    requiredBaseline?: string | null;
    explicitRequire?: boolean;
    minimumSupported?: string | null;
  } = {}
) {
  const preferredBaseline = opts.requiredBaseline || CODEX_REQUIRED_BASELINE_TAG;
  const preferredVersion = requiredCodexVersionFromBaseline(preferredBaseline);
  const minimumSupported = parseCodexVersionText(opts.minimumSupported)
    || CODEX_MINIMUM_SUPPORTED_VERSION;

  if (!detected.available || !detected.version) {
    return {
      ok: opts.explicitRequire === true ? false : true,
      status: (opts.explicitRequire === true
        ? 'blocked_missing_required_codex'
        : 'integration_optional') as CodexVersionPolicyStatus,
      preferred_baseline: preferredBaseline,
      preferred_version: preferredVersion,
      required_baseline: preferredBaseline,
      required_version: preferredVersion,
      minimum_supported_version: minimumSupported,
      update_available_hint: true,
      warnings: [
        `codex binary not detected; release checks use preferred ${preferredBaseline} channel and vendored ${CODEX_HOOK_SCHEMA_BASELINE_TAG} hook snapshots`,
        UPDATE_CTA
      ]
    };
  }

  if (compareSemverLike(detected.version, preferredVersion) >= 0) {
    return {
      ok: true,
      status: 'ok' as CodexVersionPolicyStatus,
      preferred_baseline: preferredBaseline,
      preferred_version: preferredVersion,
      required_baseline: preferredBaseline,
      required_version: preferredVersion,
      minimum_supported_version: minimumSupported,
      update_available_hint: false,
      warnings: [] as string[]
    };
  }

  if (opts.explicitRequire === true) {
    return {
      ok: false,
      status: 'blocked_below_required_baseline' as CodexVersionPolicyStatus,
      preferred_baseline: preferredBaseline,
      preferred_version: preferredVersion,
      required_baseline: preferredBaseline,
      required_version: preferredVersion,
      minimum_supported_version: minimumSupported,
      update_available_hint: true,
      warnings: [
        `detected Codex ${detected.version} from ${detected.source || 'unknown'}; explicit require needs ${preferredBaseline} or newer`,
        UPDATE_CTA
      ]
    };
  }

  if (compareSemverLike(detected.version, minimumSupported) < 0) {
    return {
      ok: false,
      status: 'blocked_below_minimum_supported' as CodexVersionPolicyStatus,
      preferred_baseline: preferredBaseline,
      preferred_version: preferredVersion,
      required_baseline: preferredBaseline,
      required_version: preferredVersion,
      minimum_supported_version: minimumSupported,
      update_available_hint: true,
      warnings: [
        `detected Codex ${detected.version} from ${detected.source || 'unknown'}; below soft minimum ${minimumSupported}`,
        UPDATE_CTA
      ]
    };
  }

  return {
    ok: false,
    status: 'blocked_below_minimum_supported' as CodexVersionPolicyStatus,
    preferred_baseline: preferredBaseline,
    preferred_version: preferredVersion,
    required_baseline: preferredBaseline,
    required_version: preferredVersion,
    minimum_supported_version: minimumSupported,
    update_available_hint: true,
    warnings: [
      `detected Codex ${detected.version} from ${detected.source || 'unknown'}; current supported release is ${preferredBaseline} (${preferredVersion})`,
      UPDATE_CTA
    ]
  };
}

function parseVersionParts(value: unknown): number[] {
  const parsed = parseCodexVersionText(value) || String(value || '0.0.0');
  return parsed.split(/[.-]/).map((part) => Number.parseInt(part, 10) || 0);
}
