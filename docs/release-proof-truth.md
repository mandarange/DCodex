# Release Proof Truth — 8.3.3

## Current assertion

8.3.3 is **SOURCE TAG CONDITIONAL / NPM PUBLICATION OPERATOR-OWNED**. The
candidate fixes two strict-decoder/contract drift regressions — the SKS Center
Combined Model Catalog refresh rejecting the status object nested inside a
command result, and the Codex Desktop model picker burying codex-lb gateway
models under the OpenRouter catalog — and pins both with regression tests.
This document does not authorize publication, deployment, a credential change,
a Git tag, or a push. Exact-commit proof can exist only after the candidate is
committed and all source-bound gates are regenerated from that clean commit.

All release artifacts bound to 8.3.1 or an earlier commit are historical. They
must not be renamed, copied, or treated as 8.3.3 evidence.

## Claim ledger

| Claim | Current support | Boundary |
| --- | --- | --- |
| SKS Center decodes the status nested inside a command result | passed-hermetic in the integrated working tree; not exact-commit proof | the envelope trio (`ok`/`execution_ok`/`command_summary`) is allowed and type-checked, never required; the compiled Swift truth harness proves nested decode succeeds, mistyped envelope values fail, and unknown top-level keys stay rejected; a live Refresh recorded "succeeded · Catalog report generated" |
| codex-lb models precede openrouter rows with picker priority 100 | passed-hermetic in the integrated working tree; not exact-commit proof | `compareModels` orders every codex-lb row before every openrouter row and remains a total order for unknown providers; codex-lb rows default to ModelInfo `priority` 100 with upstream priority winning; the combined-catalog test pins ordering and priorities; user confirmation of the live Desktop picker remains outstanding |
| Combined catalog rows remain full Codex ModelInfo supersets | passed-hermetic in the integrated working tree; not exact-commit proof | the 8.3.1 superset contract is unchanged; `codex features list` parsed the resynced catalog |
| All checked version authorities report 8.3.3 | passed-hermetic in the integrated working tree; not exact-commit proof | the version bump synced package/lock/plugin, TypeScript version, Rust manifest/lock, README, changelog, and release-doc surfaces; `release:version-truth` must be re-run from the clean candidate commit |
| The reported 8.3.3 package is ready to publish | not proved | requires a clean exact-commit build, release gates including the native `codex-sdk:real-smoke` gate (blocked on native ChatGPT quota until credits, an account switch, or 2026-08-14), package receipt, provenance, and the operator's final registry checks |

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

## Standing boundaries (unchanged from 8.3.1)

Paseo is an independent external product. Sneakoscope does not bundle its
daemon, wrap its CLI, probe its health, own its authentication or relay
lifecycle, or require a live Paseo session as 8.3.3 release proof. The owned
contract is limited to the committed `paseo.json` and accurate usage guidance.

The active Telegram command, transport, Doctor projection, native poller and
settings, feature/package entries, tests, and release requirements must be
absent. Historical changelog entries and narrowly scoped retired-state
migration code remain historical or upgrade-safety records; their presence is
not evidence of an active integration.

## Exact-commit release evidence

Before any release claim, regenerate and verify current 8.3.3-bound artifacts
from the clean handoff commit, including the build manifest, version metadata,
package proof, pack receipt, release provenance, and release-check stamp. Each
must bind the exact source digest, Git commit, tarball bytes, and package
version required by its schema.

Existing 8.3.1 and earlier canonical-test proofs, pack receipts, provenance,
and stamps are stale for this candidate. Local focused tests and a dry-run
tarball remain preparation evidence only until the repository's clean-commit
release flow produces current receipts.

## Remaining real and operator evidence

The following remain **not-run-real** or **blocked-external**:

- clean-commit full release gates and exact-tarball installed smoke, including
  the release-blocking native `codex-sdk:real-smoke` gate whose isolated
  native ChatGPT account reports its usage limit resets 2026-08-14;
- user confirmation that the live Codex Desktop model picker now lists the
  codex-lb gateway models (the host boundary policy forbids driving
  `com.openai.codex` directly);
- current npm identity, maintainer, registry-version, and dist-tag read-back;
- npm publication or dist-tag mutation.

The operator owns those credentials and registry mutations. Git promotion is
allowed only under an explicit user request after exact candidate checks and
must be verified against the remote commit and tag.
