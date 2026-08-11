# Release Proof Truth — 8.6.5

## Current assertion

8.6.5 is **SOURCE TAG CONDITIONAL / NPM PUBLICATION OPERATOR-OWNED**. The
candidate carries behavioral fixes on top of shipped 8.4.0: a Codex-LB session
pin is no longer voided by catalog churn it had no part in (which is what made
`session_pin_route_unavailable` appear intermittently mid-session), and the Codex
config surface that `sks doctor --fix` owns no longer refuses, silently no-ops,
or reverses explicit user settings. This document does not authorize
publication, deployment, a credential change, a Git tag, or a push. Exact-commit
proof can exist only after the candidate is committed and all source-bound gates
are regenerated from that clean commit.

All release artifacts bound to 8.4.0 or an earlier commit are historical. They
must not be renamed, copied, or treated as 8.6.5 evidence.

## Claim ledger

| Claim | Current support | Boundary |
| --- | --- | --- |
| A session pin survives catalog churn that leaves its route unchanged | passed-hermetic | both resolvers compare the pin against the current route and reissue it against the live generations; pinned by unit, bridge, and architecture-hardening tests, and by a reproduction in which adding one unrelated model changes `policy_generation` |
| A session pin whose provider or upstream model would change still fails | passed-hermetic | `session_pin_route_unavailable` is retained for that case and for a pin naming a provider or upstream the resolver cannot compare; pinned by the same three suites |
| `doctor --fix` can repair a managed project config whose `.sneakoscope/manifest.json` is gone | passed-hermetic | reproduced end to end against this repository's own `.codex/config.toml` in an isolated HOME: `config_file_repair.ok` went false to true, ownership resolves from the config's own shape, and the run stamps the durable marker |
| A blocked `doctor --fix` names its blockers | passed-hermetic | the ten conditions behind the verdict are enumerated into the top-level `blockers`, and a refused config repair carries the manual step in `operator_actions` |
| SKS only strips Codex feature flags Codex no longer honours | passed-hermetic | `test/unit/codex-feature-flags.test.mjs` runs the vendored Codex 0.147 binary's `features list` and fails if any stripped flag is still live; the assertion was confirmed to bite by injecting `computer_use` |
| The `[features.multi_agent_v2]` table SKS writes is accepted by Codex | passed-hermetic | the same suite writes the exact table and asserts Codex resolves `multi_agent_v2` to enabled; the struct is `deny_unknown_fields`, so an unknown key would reject the whole config |
| The doctor idempotence gate can observe a mutating second run | passed-hermetic | measured end to end in an isolated HOME: a first `doctor --fix` on a fresh project reports 26 changed files, the second reports 0; the gate now also fails closed when the field is absent, which is how it silently passed before |
| `doctor --fix` verifies its result against the files on disk | passed-hermetic | `config_disk_verification` runs after every mutator, including the two that write configs once the fix transaction has closed; `test/unit/doctor-config-disk-verification.test.mjs` pins the unparseable and lane-disabled cases and the `agents.enabled = false` false positive |
| A mission never requires an architecture-map baseline the seed declined to write | passed-hermetic | reproduced: `seedArchitectureMapBaselineArtifacts` returns `ok: false` with remediation text on a root without a compiled context graph; the plan binding is dropped instead of leaving an unsatisfiable Stop gate, and the four canonical tests it blocked now pass |
| A spawned subagent thread resolves to its own pin identity | passed-hermetic | reproduced against the compiled resolver: a child turn carrying the parent's `session_id` with its own `thread_id` was rejected as `bridge_codex_session_identity_mismatch` and now resolves; `desktop-bridge-transport.test.ts` pins the child, sibling, bare-WebSocket-header, same-field-conflict and missing-thread cases |
| A decomposed wider wave is not throttled by the pre-decomposition plan | passed-hermetic | `wave-lifecycle.test.ts` pins all three arms: a grown target with host slots opens the full wave with no blocker, a live slot shortage still throttles, and a plan whose target never grew keeps its deliberate wave staging |
| A bridge older than the installed package is detected and restarted | passed-hermetic | measured against the real long-running bridge on the development machine: `sks_version` absent, status reports `desktop_bridge_runtime_version_stale:pre-8.6.5:<installed>`; the restart is skipped under test isolation because it shells out to real launchctl |
| A refused bridge request is logged without leaking a secret | passed-hermetic | `test/unit/desktop-bridge-rejection-log.test.mjs` pins that the capability path segment and query string never reach the log, that a storm is capped at a per-code burst plus a summary, and that a failing write cannot take the bridge down |
| A home-directory root cannot claim the global Codex config | passed-hermetic | reproduced with a host-owned global config: the marker is no longer stamped and the repair reports `project_config_is_codex_home_noop` with the operator action |
| npm publish refuses a missing login before building the tarball | passed-hermetic | reproduced against the real expired token that failed an 8.6.2 publish: preflight now exits 1 with npm_publish_auth_missing_or_expired and names the login step; test/unit/publish-registry-auth.test.mjs pins that pack, dry-run, CI trusted publishing and offline runs all skip the check |
| A pinned thread routes its Responses WebSocket | passed-hermetic | reproduced against the compiled resolver and the live settings (16 model routes, none keyed by the empty string): the upgrade carries no model, so routing came from the thread's session pin; `test/unit/desktop-bridge-websocket-routing.test.mjs` pins the pinned, unpinned, explicit-header and foreign-pin cases |
| An unroutable upgrade is refused as permanent, not as a bad gateway | passed-hermetic | answered `501 Not Implemented` with `retryable: false`, so a client falls back instead of spending its reconnect budget; the real error code is returned and logged where every failure previously reported an unavailable upstream and recorded nothing |
| A stale bridge is actually restarted by doctor --fix | passed-hermetic | measured against the real install: the restart resolved the bridge only once the home directory was passed instead of the project root, taking a 29-hour-old pre-8.6.2 process to the installed version with `sks_version` recorded |
| Every bridge error path records its cause | passed-hermetic | the fourth and last silent writer now logs; triggered live and confirmed `catalog_model_route_missing`, `bridge_websocket_route_unresolvable` (501) and `bridge_responses_body_invalid_json` reach the log with the capability path segment redacted |
| No remedy points at a command that cannot satisfy it | passed-hermetic | `codex_imagegen_real_output_unverified` states the manual step instead of recommending the doctor run whose own output carries the blocker |
| The canonical suite is green | passed-hermetic | 2928 of 2928, zero failures, from the candidate tree |
| All checked version authorities report 8.6.5 | requires `release:version-truth` from the clean candidate commit | package, lock, `src/core/version.ts`, changelog, and release-doc surfaces are bumped together |
| The reported 8.6.5 package is ready to publish | not proved | requires a clean exact-commit build, the full release gate DAG, canonical tests, package receipt, provenance, release-check stamp, and the operator's final registry checks |
| 8.6.5 physical release evidence exists | not proved | GitHub artifact attestation is producible only by the publish workflow; no local run can create it |

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
lifecycle, or require a live Paseo session as 8.6.5 release proof. The owned
contract is limited to the committed `paseo.json` and accurate usage guidance.

The active Telegram command, transport, Doctor projection, native poller and
settings, feature/package entries, tests, and release requirements must be
absent. Historical changelog entries and narrowly scoped retired-state
migration code remain historical or upgrade-safety records; their presence is
not evidence of an active integration.

## Exact-commit release evidence

Before any release claim, regenerate and verify current 8.6.5-bound artifacts
from the clean handoff commit, including the build manifest, version metadata,
package proof, pack receipt, release provenance, and release-check stamp. Each
must bind the exact source digest, Git commit, tarball bytes, and package
version required by its schema.

Existing 8.4.0 and earlier canonical-test proofs, pack receipts, provenance,
and stamps are stale for this candidate. Local focused tests and a dry-run
tarball remain preparation evidence only until the repository's clean-commit
release flow produces current receipts.

## Remaining real and operator evidence

The following remain **not-run-real** or **blocked-external**:

- source-bound physical release evidence. `inspectMainPushGuard` reports
  `physical_proof_requirement_missing` until the publish workflow produces a
  GitHub-attested capture run; `gh attestation verify` cannot be satisfied by
  any local run, so this is the one release requirement no local flow can meet;
- user confirmation that a live Codex Desktop session keeps its pinned provider
  across a catalog refresh (the host boundary policy forbids driving
  `com.openai.codex` directly, so the fix is proved hermetically and by
  reproduction, not against the running Desktop app);
- npm publication or dist-tag mutation.

Regenerated from the candidate commit, the release gate DAG, canonical tests,
the isolated 7.6.0→8.6.5 upgrade smoke, and the macOS Menu Bar proof are
**passed-hermetic**; the live `codex-sdk:real-smoke` and Codex core real probes
report `proven` against the real runtime.

The operator owns those credentials and registry mutations. Git promotion is
allowed only under an explicit user request after exact candidate checks and
must be verified against the remote commit and tag.
