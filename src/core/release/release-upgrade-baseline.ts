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
export const RELEASE_UPGRADE_BASELINE_VERSION = '6.2.0'

/** Short form used in the upgrade proof filename, e.g. `upgrade-6.2-to-7.2.1.json`. */
export const RELEASE_UPGRADE_BASELINE_LABEL = '6.2'

/** sha256 of the immutable published baseline tarball on the registry. */
export const RELEASE_UPGRADE_BASELINE_SHA256 = 'dd0bfc022348c11dc737055845708f6272beaf2a8f9c16d068acf3c8c612f9bc'

/** Filename of the upgrade proof for a given target version. */
export function releaseUpgradeProofFilename(targetVersion: string): string {
  return `upgrade-${RELEASE_UPGRADE_BASELINE_LABEL}-to-${targetVersion}.json`
}

/** The version a given upgrade-smoke state is expected to observe. */
export function releaseUpgradeExpectedVersion(stateName: string, targetVersion: string): string {
  return stateName.startsWith('target_') ? targetVersion : RELEASE_UPGRADE_BASELINE_VERSION
}
