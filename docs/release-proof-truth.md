# Release Proof Truth — 8.1.3

## Current assertion

8.1.3 is **SOURCE COMPLETE / RELEASE BLOCKED**. This document does not
authorize a release, publication, deployment, service mutation, credential
change, tag, or push.

The integrated source passed the current local corpus. Exact-commit package
receipts must still be regenerated from the clean handoff commit, and trusted
physical macOS/provider evidence is absent. Any artifact bound to an earlier
SHA is historical only. The 8.1.2 release stamp is stale and cannot authorize
8.1.3.

## Evidence classes

- **passed-hermetic** means a local test, build, fixture, or gate artifact
  passed. It is never proof of a user environment.
- **not-run-real** means no redacted, target-bound real receipt exists.
- **blocked-external** means a necessary target environment or operator
  authority is outside this checkout.

These classes are deliberately non-interchangeable. A successful diagnostic
exit, a configured key, a process listing, or a fixture cannot promote a
real-environment row to passed.

## Product and user-override boundary

8.1.3 has one SKS-managed routing runtime: Desktop Bridge. Codex-LB and
OpenRouter are independent profiles that may coexist. Requests use the combined
catalog's explicit route index with `fallback: none`.

The user explicitly overrides the work order's former temporary-alias proposal:

- public `sks codex-lb` paths are deleted and return `unknown_command`;
- no legacy Desktop/provider mode is an active runtime state; and
- historical SKS-owned values are readable only by the private,
  receipt-backed migration path.

Historical migration recognition is not a live compatibility runtime and must
not be represented as an alias or fallback path.

## Current evidence inventory

| Area | Classification | Truth boundary |
| --- | --- | --- |
| source, fixture, and release-focused tests | passed-hermetic | current integrated source |
| full canonical corpus | passed-hermetic | 2,851 parallel plus 33 resource-sensitive serial tests, zero failures |
| Naruto capacity lifecycle | passed-hermetic | 102/102; terminal agents return capacity immediately and duplicate terminal events are idempotent |
| physical/stage/release focused corpus | passed-hermetic | 50/50; producer trust and exact nonce/run association included |
| package receipt and installed smoke | passed-hermetic when generated from the clean handoff commit | must bind the exact SHA and tarball bytes; historical receipts are invalid |
| real-evidence check | not-run-real | result is `real_required_missing` and non-authorizing |
| macOS/Providers UI/OAuth/provider/WebSocket/deep proof | not-run-real | required receipts are absent |
| final stamp/physical receipts/upgrade proof | blocked-external | requires release-commit promotion and authorized real target collection |
| GitHub main/tag/npm owner/stage approval | blocked-external | operator authority and human 2FA are required |

## What must be proved before a release claim

| Area | Required evidence | What does not prove it |
| --- | --- | --- |
| Version identity | final package/lock/runtime/Rust/README/changelog agreement plus a fresh source-bound stamp | a version string in one file or a stale stamp |
| Command surface | installed/help/registry proof that `sks bridge` is registered and `sks codex-lb` is unknown | a documentation statement or a source-only fixture |
| Routing | final combined-catalog/route-index tests and source-bound package proof | a selected profile or model-name convention |
| Credentials | profile-isolation tests plus redacted target-bound live checks | configured state, fixtures, or a key-presence flag |
| OAuth | byte/semantic preservation and upstream-header stripping evidence | a stored OAuth file or provider setup result |
| Migration | receipt/idempotency/rollback tests and ownership conflict checks | a code path without a read-back receipt |
| Transport | TCP, HTTP, upgrade, protocol, frame, and close evidence at their actual stages | process running, HTTP health, or upgrade alone |
| Capability v3 | scoped level/schema tests with deep results reported separately | a successful command exit or manifest advertisement |
| Catalog | atomic generation/read-back and mandatory catalog-sync schema | a temp file or stale receipt |
| Native UI | target-bound macOS build/run and current Providers UI evidence | Swift compilation, decoder fixtures, or another-version screenshot |
| Deep features | provider-bound real output/artifact for each feature | synthetic output, fixtures, or declarations |

## Required real-environment evidence

The following are **not-run-real** until each has a redacted, target-bound
receipt for the final source/version:

- macOS launchd/service installation, restart, repair, and process read-back;
- Codex Desktop restart and native Providers view state;
- ChatGPT OAuth byte/semantic preservation through bridge/profile/catalog
  actions;
- live Codex-LB authentication, catalog fetch, and bounded text request;
- live OpenRouter authentication, catalog fetch, and bounded text request;
- simultaneous credential preservation on the same user profile;
- a real WebSocket protocol/frame/clean-close result where supported; and
- each deep capability, including a real image artifact and its digest.

## Release decision and handoff

The release stays **BLOCKED** until exact-commit package evidence is current,
all required real evidence exists, and separately authorized external release
actions are available. Review
[release readiness](release-readiness.md) for the exact final commands,
including the read-only staged-tarball verifier.

No local fixture, static source inspection, inferred status, configured
credential, package dry-run, or build result may change a missing live item to
passed. No action in this documentation process publishes, deploys, mutates a
service, changes credentials, creates a tag, or pushes a branch.
