# Release Proof Truth — 8.2.0

## Current assertion

8.2.0 is **SOURCE PREPARED / RELEASE BLOCKED**. The Telegram arbitrary-bot
fix and 8.2.0 metadata are present in the working tree, but this document does
not authorize publication, deployment, a credential change, a Git tag, or a
push. Exact-commit proof can exist only after the candidate is committed and
all source-bound gates are regenerated from that clean commit.

All release artifacts bound to 8.1.3 or an earlier commit are historical. They
must not be renamed, copied, or treated as 8.2.0 evidence.

## Claim ledger

| Claim | Current support | Boundary |
| --- | --- | --- |
| A user may select any BotFather bot they own | supported in source and hermetic tests | setup verifies `getMe`, requires `is_bot` and a positive ID, and binds that exact identity; no fixed username is assumed |
| Invalid credentials and identity-verification transport failures are distinguishable | supported in source and hermetic tests | stable secret-free errors cover rejection, timeout, network failure, and invalid identity |
| Native and CLI liveness receipts interoperate | supported in cross-language tests | new Swift receipts encode nullable fields as `null`; TypeScript still accepts 8.1.x receipts that omitted those optional fields |
| Bot tokens remain secret | supported by source boundaries and tests | tokens enter through secure input/stdin, are not included in receipts, and are not exposed as bot metadata |
| The reported 8.2.0 package is ready to publish | not proved | requires a clean exact-commit build, release gates, package receipt, provenance, and the operator's final registry checks |
| The original user's real bot now connects | not-run-real | no real token or private Telegram state was inspected or mutated during this preparation |

## Evidence classes

- **passed-hermetic** means a local build, fixture, test, or gate passed for the
  inspected source. It is never proof of a user environment or registry state.
- **not-run-real** means no redacted, target-bound receipt exists for the real
  bot, macOS companion, or registry action.
- **blocked-external** means the remaining action requires a clean promoted
  commit, a private credential, a target machine, or explicit operator
  authority.

These classes are not interchangeable. A configured token, process listing,
fixture, or package dry run cannot promote a real-environment row to passed.

## Telegram acceptance boundary

The setup contract stores a token only after Telegram `getMe` verifies the
selected bot identity and webhook handling is resolved. A successful identity
check does not prove later storage, webhook mutation, or poller restart; those
stages retain their own failures and neutral UI wording. A successful save
does not prove readiness until the resident Menu Bar poller runs and one
private chat/user pair is enrolled.

No source path is allowed to infer token invalidity from an unrelated setup
failure. Public bot metadata is limited to a positive numeric ID and a bounded
sanitized username. Secret values remain excluded from JSON, native UI
receipts, liveness files, and logs.

## Exact-commit release evidence

Before any release claim, regenerate and verify current 8.2.0-bound artifacts
from the clean handoff commit, including the build manifest, version metadata,
package proof, pack receipt, release provenance, and release-check stamp. Each
must bind the exact source digest, Git commit, tarball bytes, and package
version required by its schema.

The existing 8.1.3 canonical-test proof, pack receipt, provenance, and stamp
are stale for this candidate. Local focused tests and a dry-run tarball remain
preparation evidence only until the repository's clean-commit release flow
produces current receipts.

## Remaining real and operator evidence

The following remain **not-run-real** or **blocked-external**:

- saving a private real BotFather token through the installed 8.2.0 Center;
- a live `getMe`, webhook inspection, resident poller restart, pairing, and
  private-chat command round trip on the user's target machine;
- clean-commit full release gates and exact-tarball installed smoke;
- current npm identity, maintainer, registry-version, and dist-tag read-back;
- any Git push, tag, stage approval, or npm publication.

The operator owns those credentials and external mutations. This source task
must stop before performing them.
