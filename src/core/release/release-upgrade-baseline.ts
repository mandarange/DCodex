// Single source of truth for the published release the upgrade smoke starts from.
//
// This used to be written out in nine places — twice as module constants (once in
// src/scripts, once duplicated into main-push-guard because src/core cannot import
// src/scripts) and seven more times as bare literals in filenames, comparisons and
// doc-rewrite regexes. Moving the baseline meant finding all nine; missing one left a
// validator silently pinned to a release the producer had already moved past.
//
// It lives in src/core so scripts can import it too. Anything that needs the baseline
// imports from here — do not re-inline the value.

/** The published version the upgrade smoke installs first, before upgrading to the target. */
export const RELEASE_UPGRADE_BASELINE_VERSION = '7.6.0'

/** Short form used in the upgrade proof filename, e.g. `upgrade-7.6-to-8.0.0.json`. */
export const RELEASE_UPGRADE_BASELINE_LABEL = '7.6'

/** sha256 of the immutable published baseline tarball on the registry. */
export const RELEASE_UPGRADE_BASELINE_SHA256 = '40a9e89f3a234dfcd32507ab7deeb95044084cae95a9ce46b36be4113d5b2a7c'

/** Filename of the upgrade proof for a given target version. */
export function releaseUpgradeProofFilename(targetVersion: string): string {
  return `upgrade-${RELEASE_UPGRADE_BASELINE_LABEL}-to-${targetVersion}.json`
}

/**
 * The launchctl calls the isolated upgrade is allowed to make.
 *
 * This is checked twice — the smoke classifies its own stub log, and
 * `inspectMainPushGuard` independently re-checks the recorded calls before a
 * release push. Those two lived as separate copies of the same regex, so
 * widening one silently left the other rejecting the very proof the first had
 * just approved. Same reason the baseline version above lives here: `src/core`
 * is the only place both `src/core` and `src/scripts` can import from.
 *
 * `bootout` is bounded rather than forbidden: the sandbox stub only accepts one
 * naming this product's own labels (and, in the domain+plist form, only a plist
 * inside the sandbox HOME), so a call that reaches the log un-redacted has
 * already been proven to target nothing of the operator's.
 */
export function isExpectedReleaseUpgradeLaunchctlCall(call: unknown): boolean {
  return /^(?:unsetenv (?:CODEX_LB_API_KEY|OPENROUTER_API_KEY)|print|bootout (?:com\.sneakoscope\.sks-menubar|com\.sneakoscope\.telegram-hub))$/
    .test(String(call))
}

/** The version a given upgrade-smoke state is expected to observe. */
export function releaseUpgradeExpectedVersion(stateName: string, targetVersion: string): string {
  return stateName.startsWith('target_') ? targetVersion : RELEASE_UPGRADE_BASELINE_VERSION
}
