# Release Proof Truth — 8.1.3

## Claim boundary

This document defines the proof boundary for Sneakoscope Codex 8.1.3. It is
not a release authorization, publication record, deployment record, or a claim
that real credentials or macOS evidence have been collected.

8.1.3 has one SKS-managed routing runtime: Desktop Bridge. Codex-LB and
OpenRouter are independent profiles that may coexist. Requests are routed from
the combined catalog's explicit route index with fallback fixed to `none`.
The removed `sks codex-lb` command must return `unknown_command`; no alias or
legacy mode may make it runnable.

## What must be proved before a release claim

| Area | Required evidence | What does not prove it |
| --- | --- | --- |
| Version identity | package metadata, lockfile, runtime/Rust metadata, README identity, and one 8.1.3 changelog section agree | a version string in one file |
| Command surface | installed/help/registry proof that `sks bridge` is registered and the removed command is unknown | a documentation statement |
| Routing | combined catalog and route-index tests prove explicit resolution, conflict rejection, and no fallback | a slash-containing model name or a selected profile |
| Credentials | profile-isolation tests plus redacted target-bound live checks | configured state, fixtures, or a key-presence flag |
| OAuth | byte/semantic preservation and upstream-header stripping evidence | a stored OAuth file or a provider setup result |
| Migration | receipt/idempotency/rollback tests and ownership conflict checks | a migration code path without a read-back receipt |
| Transport | stage-aware TCP, HTTP, WebSocket upgrade/protocol/frame/close evidence | process running, HTTP health, or upgrade alone |
| Capability v3 | scope/level/schema tests; transport and deep readiness are separately reported | a successful command exit or a manifest advertisement |
| Catalog | atomic generation/read-back tests and mandatory catalog-sync schema | a catalog temp file or an old receipt |
| Native UI | a target-bound macOS build/run and visual/state proof | Swift compilation, fixture-only decoder tests, or screenshots from another version |
| Deep features | provider-bound live artifact/evidence per feature | fixtures, synthetic output, or a capability declaration |

## Truth rules

- `execution.ok` says whether a diagnostic/report operation completed; it does
  not mean every requested feature is ready.
- A transport report may be satisfied while deep rows are `not_attempted`.
- An inactive profile failure is recorded in that profile's warning/evidence
  scope; it is not a top-level routing failure when an active route is ready.
- A stale receipt is stale, not current verified evidence.
- A successful image assertion requires an actual validated output artifact;
  fixture data never becomes live evidence.
- Secrets, OAuth tokens, raw keys, and unredacted endpoint details must not
  appear in status, reports, logs, receipts, catalog data, route indexes, or
  release evidence.

## Required real-environment evidence

The following are **not-run-real pending final evidence** for this release
until a redacted, target-bound receipt exists:

- macOS launchd/service installation, restart, repair, and process read-back;
- Codex Desktop restart and native Providers view state;
- ChatGPT OAuth byte/semantic preservation through bridge/profile/catalog
  actions;
- live Codex-LB authentication, catalog fetch, and bounded text request;
- live OpenRouter authentication, catalog fetch, and bounded text request;
- simultaneous credential preservation on the same user profile;
- a real WebSocket protocol/frame/clean-close result where supported; and
- each deep capability, including a real image artifact and its digest.

No local fixture, static source inspection, inferred status, credential
configuration, or build result may change one of these items to passed.

## Evidence intake and release decision

The final release owner must record each executed command and result, bind
artifacts to the release source/version, and update
`docs/internal/8.1.3-implementation-report.md`. The release is **BLOCKED**
while required proof is absent, stale, mismatched, or red. Running a package
dry-run does not publish; publication, deployment, credential changes, and
service mutation require separately authorized operator actions.
