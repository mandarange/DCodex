# Release Proof Truth — 8.3.0

## Current assertion

8.3.0 is **SOURCE TAG CONDITIONAL / NPM PUBLICATION OPERATOR-OWNED**. The
candidate removes Sneakoscope's active first-party Telegram surface and adds a
repository-owned Paseo configuration and recommendation, but this document does
not authorize publication, deployment, a credential change, a Git tag, or a
push. Exact-commit proof can exist only after the candidate is committed and
all source-bound gates are regenerated from that clean commit.

All release artifacts bound to 8.2.2 or an earlier commit are historical. They
must not be renamed, copied, or treated as 8.3.0 evidence.

## Claim ledger

| Claim | Current support | Boundary |
| --- | --- | --- |
| The active first-party Telegram surface is absent | passed-hermetic in the integrated working tree; not exact-commit proof | the removed-surface regression, command-help contract, Doctor/feature/package inspection, native Swift compile, and current release gates passed; the dry-run package contained no Telegram path |
| `paseo.json` is safe and usable by Paseo worktrees | passed-hermetic in the integrated working tree; not exact-commit proof | JSON parsing, the exact ordered setup array, and every named command's package-script target passed |
| Current docs recommend Paseo without claiming ownership | passed-hermetic in the integrated working tree; not exact-commit proof | manual inspection covered desktop, headless, Codex, local and worktree flows plus the independent-project boundary; the docs-truthfulness gate separately pinned the Paseo URL and Codex provider invocation |
| All checked version authorities report 8.3.0 | passed-hermetic in the integrated working tree; not exact-commit proof | `release:version-truth` checked 15 package/lock/plugin, TypeScript version and re-export, Rust manifest/lock/metadata, dist manifest, README, changelog, and release-metadata-script surfaces with zero warnings |
| The reported 8.3.0 package is ready to publish | not proved | requires a clean exact-commit build, release gates, package receipt, provenance, and the operator's final registry checks |

## Evidence classes

- **passed-hermetic** means a local build, fixture, test, or gate passed for the
  inspected source. It is never proof of a user environment or registry state.
- **not-run-real** means no redacted, target-bound receipt exists for a macOS,
  provider, or registry action that still requires one.
- **blocked-external** means the remaining action requires a clean promoted
  commit, a private credential, a target machine, or explicit operator
  authority.

These classes are not interchangeable. A configuration file, process listing,
fixture, or package dry run cannot promote a real-environment row to passed.

## Paseo boundary and removed Telegram surface

Paseo is an independent external product. Sneakoscope does not bundle its
daemon, wrap its CLI, probe its health, own its authentication or relay
lifecycle, or require a live Paseo session as 8.3.0 release proof. The owned
contract is limited to the committed `paseo.json` and accurate usage guidance.

The active Telegram command, transport, Doctor projection, native poller and
settings, feature/package entries, tests, and release requirements must be
absent. Historical changelog entries and narrowly scoped retired-state
migration code remain historical or upgrade-safety records; their presence is
not evidence of an active integration. No live Telegram, BotFather, pairing,
poller, or cellular round trip is required for this release.

## Exact-commit release evidence

Before any release claim, regenerate and verify current 8.3.0-bound artifacts
from the clean handoff commit, including the build manifest, version metadata,
package proof, pack receipt, release provenance, and release-check stamp. Each
must bind the exact source digest, Git commit, tarball bytes, and package
version required by its schema.

Existing 8.2.2 and earlier canonical-test proofs, pack receipts, provenance, and
stamps are stale for this candidate. Local focused tests and a dry-run tarball
remain preparation evidence only until the repository's clean-commit release
flow produces current receipts.

The integrated working-tree preparation passed `release:check:affected` 35/35
and `release:check:confidence` 110/110. These results remain hermetic
pre-commit evidence; they do not promote the dirty tree to exact-commit or
publication proof.

## Remaining real and operator evidence

The following remain **not-run-real** or **blocked-external**:

- clean-commit full release gates and exact-tarball installed smoke;
- any target-bound macOS, provider, protocol, or deep-artifact evidence still
  required by the protected release gates;
- current npm identity, maintainer, registry-version, and dist-tag read-back;
- npm publication or dist-tag mutation.

The operator owns those credentials and registry mutations. Git promotion is
allowed only under an explicit user request after exact candidate checks and
must be verified against the remote commit and tag.
