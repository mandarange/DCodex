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

/** The version a given upgrade-smoke state is expected to observe. */
export function releaseUpgradeExpectedVersion(stateName: string, targetVersion: string): string {
  return stateName.startsWith('target_') ? targetVersion : RELEASE_UPGRADE_BASELINE_VERSION
}
