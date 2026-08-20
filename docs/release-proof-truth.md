# Release Proof Truth — 9.1.1

## Current assertion

9.1.1 is **SOURCE TAG CONDITIONAL / NPM PUBLICATION OPERATOR-OWNED**. It is
9.1.0 plus a stability patch: the desktop bridge absorbs 502/503/524 gateway
transients (and `upstream_request_timeout`) internally so Codex compact never
sees a leftover 503 after one miss, stops showing the sentence
"Upstream request failed", keeps 429 as `rate_limited`, and no
longer dies on write-after-end during a WebSocket refusal. `sks update`
quarantines OMX/DCodex harness markers itself and removes only SKS-owned
retired skills from `~/.cursor/skills` and `~/.claude/skills`. Unnamed hook
payloads no longer inherit a cwd-sticky official workflow, and an official
workflow with no activity for two hours stops capturing later prompts. This
document does not authorize publication, deployment, a credential change, a
Git tag, or a push. Exact-commit proof can exist only after the candidate is
committed and all source-bound gates are regenerated from that clean commit.

All release artifacts bound to 9.1.0 or an earlier commit are historical. They
must not be renamed, copied, or treated as 9.1.1 evidence.

The 9.1.0 ledger below remains for upgrade context. New 9.1.1 claims:

| Claim | Current support | Boundary |
| --- | --- | --- |
| A 502/503/524 gateway transient is absorbed before Codex compact can see it | passed-hermetic | first try plus 3 fresh-connection replays; `upstream_request_timeout` included; unidentified 502/503/524 bodies included; genuine `response_not_found` stays 404; leftover 503 only after the budget; pinned by the bridge keepalive suite including a 4th-attempt compact-shaped 503 heal |
| Exhausted upstream errors no longer say "Upstream request failed" | passed-hermetic | 429 → `rate_limited` + Retry-After; transient exhaust → `temporary_upstream_failure`; other 4xx/5xx → `bridge_upstream_request_failed`; identifiers still survive; free text still dies |
| WebSocket refusal cannot crash the bridge process | passed-hermetic | `safeEndUpgradeSocket` swallows socket errors and refuses to write an already-ended stream; unit-tested on an ended and a destroyed PassThrough |
| `sks update` quarantines other-harness conflicts | passed-hermetic | `other-harness-cleanup` now calls `cleanupOtherHarnessConflicts` instead of failing closed; from-home update e2e still runs every migration stage |
| Host extra skill dirs lose only SKS-owned retired residue | passed-hermetic | `~/.cursor/skills` and `~/.claude/skills` remove managed retired names only; user-authored collisions stay in place |
| A stale or cwd-sticky official workflow cannot capture a later prompt | passed-hermetic | unnamed hooks use `loadOwnedRouteState`; idle > 2h is inactive even with leftover open threads; same-session follow-ups still bind while the run is fresh |
| All checked version authorities report 9.1.1 | passed-hermetic | `release:version-truth` 15 surfaces at 9.1.1 after incremental build |
| The reported 9.1.1 package is ready to publish | not proved | requires a clean exact-commit build, `npm run release:check:full` stamp, pack receipt, and provenance |

## 9.1.0 assertion (historical)

9.1.0 is **SOURCE TAG CONDITIONAL / NPM PUBLICATION OPERATOR-OWNED**. It is
9.0.6 plus one opt-in feature: `sks codex-app context-1m status|on|off` and the
SKS Center "Codex 1M Context" card, which together manage the OpenAI-documented
1M-token context window for GPT-5.6 Sol (`model_context_window = 1000000`,
`model_auto_compact_token_limit = 900000` as top-level keys in
`~/.codex/config.toml`, inline `# sks-codex-context-1m prev=...` ownership
markers that record and restore the pre-enable value, guarded CAS writes, and
an automatic Codex Desktop restart only when Codex is already running). The
default is unchanged: the keys are absent until an operator enables them.

All release artifacts bound to 9.0.6 or an earlier commit are historical. They
must not be renamed, copied, or treated as 9.1.0 evidence.

The full engineering record for this candidate — including every measurement
cited below, the corrections to earlier claims, and the findings that were
refuted — is `docs/work-orders/context-retrieval-v2/release-record.md`. Where
this ledger and that record disagree, the record wins; it was written as the
work happened.

## Claim ledger

| Claim | Current support | Boundary |
| --- | --- | --- |
| v2 must-include recall exceeds v1 | passed-hermetic | 0.481132 vs 0.460692 over 62 cases, 3 repeats, real engines; re-measured independently on a clean build after every landing with zero per-case drift; the predicted honest ceiling (0.4811) was hit without moving any ranking threshold |
| The §4 confidence ceiling held through every change | passed-hermetic | violations 10 (v1) / 3 (v2) at every step; name matches claim `text_candidate` structurally (nothing in the change calls `table.claim`), and `demoteKernelConfidence` makes depth monotonically weakening, so deeper traversal cannot promote |
| Metadata values keep their authored type | passed-hermetic | format revision 2, 16-byte row with type tag and ordinal; both former `todo` tests are plain tests with inverted assertions; `preserved === authored` for all five types across all 14 fixture families; 10 mutations run, the 1 survivor (helper narrowing) closed with a both-spellings test |
| A revision-1 index is refused with the repair that works | passed-hermetic | refusal happens before any header count is believed; the repair command depends on skew direction — older artifact → `sks align run --rebuild-index`, newer or unknowable → `sks update`; the direction branch is mutation-tested and the pre-existing test's blind spot (`+1` only) is recorded |
| Freshness answers without the 63 MB parse, and `missing` when no index exists | passed-hermetic | `contextIndexFreshness` verdicts match the JSON path on every measured pair; the meta-present/pointer-absent hole (the exact 8.7.0→9.0.6 upgrade shape) is closed, with the four test sites that asserted the old behaviour named in the record; the preflight was mutated into the refused shape and 4 of 5 tests failed |
| Caller-supplied changed paths reach the kernel as verified seeds | passed-hermetic | one resolver serves both production call sites and the benchmark; the response cache key includes the resolved seed set; the one case the join costs (`review-reverse-dependency`, −0.500) is named and kept, not netted out |
| Subagent workers cannot outlive their work | passed-hermetic | process-group teardown on exit/timeout/abort, pre-spawn orphan sweep, stale heartbeats excluded from active sessions, generation-depth guard against recursive spawning; pinned by the worker-runtime, janitor, and orchestrator suites |
| A stale pooled socket is replayed, not surfaced as 502 | passed-hermetic | replay requires `request.reusedSocket === true` plus ECONNRESET/EPIPE/ECONNABORTED and is one-shot on a fresh connection; pinned by the bridge http-forward suite |
| Truncating caps report themselves and cut deterministically | passed-hermetic | test selection, added gates, gate warnings, advisor recommendations, and query terms each carry a named reason; kept sets ordered `(depth, key, nodeId)` — invariant under six arrival-order permutations where the old rule kept as few as 66 of 128; gate selection hash-identical across 7 real diffs |
| Machine feedback runs the runnable related tests | passed-hermetic | the alphabetical pre-filter cut deterministically kept unrunnable tests (`'src/' < 'test/'` is the runnability split); reordered by runnability before the cap, mutation-tested; on the reproducing four-file change the selection went 0 → 7 runnable including the version-sync regression test |
| Test selection migrated to v2 without shrinking | passed-hermetic | before/after over 19 real diffs: gates and `gate_details` hash-identical 19/19, recommended tests identical 17/19 with the two differences additive or same-count-at-cap; no workspace in the harness contained `context-graph.json`, so a reverted module fails on the first case |
| Secrets do not reach the index bytes through claim prose or the lexicon | passed-hermetic | entropy guard covers base62/base64/base64url/hex/JWT/email/IPv4 at ≥99.9% on 5,000 random 32-byte secrets per encoding; the extension-join bypass (`<secret>.json` indexed whole while telemetry reported it dropped) is closed with the stem's verdict carried to the join; cost on real claim prose 0 of 24, index bytes byte-identical |
| The generation store is invisible to git and to its own cache key | passed-hermetic | `.gitignore` and `SKS_GENERATED_GIT_PATTERNS` cover `.sneakoscope/wiki/context-graph/` (fresh installs never had even the v1 protection); cache-key exclusion is by subtree — before the fix, publishing moved `wikiContextHash` and republishing identical content moved it again |
| The verification budget reacts to what actually changed | passed-hermetic | the hardcoded empty `changedFiles` made `release` unreachable from preparation for every mission ever prepared; the finalizer now recomputes from the parent's reported list and never returns weaker than the plan; both fixes mutation-tested, including against the tempting in-scope variable that would have been wrong |
| A quiet WebSocket is not executed by the bridge | passed-hermetic | the idle timer that destroyed an established Responses socket after `idle_timeout_ms` of silence is replaced by TCP keepalive on both legs; a join test holds a routed tunnel silent past the timeout and round-trips a frame after it, and reverting the change in `dist` fails exactly that test |
| A supervised bridge converges to the installed package | passed-hermetic | the server reads the installed version on a timer and fires once after two consecutive identical mismatches — never on one read (npm writes package.json mid-install), never for an unreadable file; under launchd (`XPC_SERVICE_NAME` or `--supervised`) the handler drains and exits non-zero so `KeepAlive.SuccessfulExit=false` relaunches on the new code; mutation to fire-on-first-read fails the streak test |
| `sks update` restarts a stale bridge immediately | passed-hermetic | `desktop-bridge-restage` migration stage: `kickstart -k` only (never bootout), gated on a live pid whose recorded version differs, and structurally skipped under `node --test` because launchctl addresses the real gui domain regardless of HOME — the skip is witnessed by a test running under exactly that condition |
| An upstream error status leaves a bridge-side record | passed-hermetic | 4xx/5xx passthrough now logs status, provider id, public model, and path — catalog-published identifiers only, control characters stripped, bodies never logged; rows without the new fields stay byte-compatible |
| Doctor from home repairs the bridge, not just reports it | passed-hermetic | global-only fix invokes the shared catalog-repair module (extracted verbatim from the 8.7.0 fix transaction) before the status read; repair-before-status is join-tested and the status-only mutation fails 3 tests; a failed sync retains blocker plus remedy so a re-run stays meaningful |
| sks update completes from any directory | passed-hermetic | the migration-profile global-only doctor writes the home-rooted receipt (its absence failed every from-home update since 9.0.2, proven by a real-child e2e spawning the built CLI); catalog repair added as a guarded migration stage, operation stage list untouched; receipt-write mutation fails the e2e |
| Align completes end to end on this real workspace | passed-hermetic | sks align run ok:true with exact_file_coverage true, 3099 file nodes, 17 artifacts, zero blockers; extractor caps sized from the measured real inputs (162 gates, 880 proofs) with headroom; five cap/exemption mutations each failed the suite; the stale architecture-map:freshness gate cleared by the run |
| Align holds exact file coverage on real workspaces | passed-hermetic | every extractor-minted file node passes an inventory-membership choke point; 26 real out-of-inventory nodes on this repository went to zero, real align end-to-end green on a fixture citing .codex/config.toml and AGENTS.md; both guards mutation-tested in dist and the invariant itself untouched |
| A self-described upstream transient is retryable | passed-hermetic | only the exact signature 404 + type upstream_error + no code becomes 503 with Retry-After: 10; a genuine not-found (different type or any specific code) passes as 404; both arms join-tested and the condition mutation fails exactly that test |
| An upstream error keeps its identifiers and loses its text | passed-hermetic | machine-shaped `error.type`/`error.code` (charset-validated, ≤64 chars) survive redaction into the response body and the log; the free-text message, which can echo request content, is still replaced; join-tested with a secret-bearing upstream body, and the mutation forcing the identifier to null fails exactly that test |
| A skipped doctor check never renders as a failure | passed-hermetic | every console row fed by a `skipped: true` source says `not measured (run: sks doctor --full)`, never `degraded`/`missing`/`optional_missing`/`unavailable` and never a fake `ok`; a measured check that genuinely fails still renders its failure (control pinned); one legacy test had *encoded* the defect (null → `unavailable`) and was corrected, not deleted |
| The home directory cannot become a project root | passed-hermetic | a `.sneakoscope`/`.dcodex`/`.git` marker directly in `os.homedir()` is skipped by discovery — `~/.sneakoscope` is the product's own global state dir, so the defect fired on most machines; `sks doctor --fix` from home routes to the existing global-only repair with run-from-your-project guidance; join-tested through the real doctor path and mutation-tested in both halves |
| The 1M context toggle writes exactly the documented recipe and nothing else | passed-hermetic | `on` upserts the two int keys top-level before the first `[table]` header with inline ownership markers recording the prior value; `off` restores that value or removes the key, and never touches a value without the marker; duplicate declarations and unparseable values fail closed; 12-test suite covers round-trip on a realistic host-config fixture, idempotence, drift detection, and the guard mode-lock stripper leaving the operator's `model` line intact |
| Enabling 1M context never launches Codex on its own | passed-hermetic | restart is attempted only when `codex-app context-1m on/off` changed the config AND Codex Desktop is already running (osascript bundle-id probe); `codex_not_running`, `config_unchanged`, `--no-restart`, and `SKS_SKIP_CODEX_APP_RESTART=1` all skip without probing or launching; injected-impl tests pin each skip reason and the restart-attempted path |
| The 1M toggle surfaces the documented caveats | passed-hermetic | a non-`gpt-5.6-sol` active model warns (`codex_context_active_model_not_...`) because the keys are global and not model-aware; both CLI and SKS Center state that only new sessions pick up the change and that >272K-input requests bill the entire request at the long-context rate |
| The canonical suite is green | passed-hermetic | 3,515 of 3,515 (3,482 canonical + 33 stamp-phase), zero failures, zero skipped, zero todo, on a clean build at the 9.1.0 candidate under the lifecycle Node v24.0.2 (3,474 at 9.0.6); the affected release-gate DAG ran strict with 0 blockers |
| The integration audit's blockers are closed | passed-hermetic | 29 candidates across six dimensions, 6 survived adversarial refutation, 4 were blockers, all 4 fixed in-tree before this bump; the refuted 23 are recorded so they are not re-derived |
| All checked version authorities report 9.1.0 | requires `release:version-truth` from the clean candidate commit | package, lock, `src/core/version.ts`, plugin manifest, Cargo.toml/lock, README banner, changelog, and the rebuilt `dist/build-manifest.json` move together |
| The reported 9.1.0 package is ready to publish | not proved | requires a clean exact-commit build, the full release gate DAG, canonical tests, package receipt, provenance, and release-check stamp regenerated from that commit |
| 9.1.0 physical release evidence exists | not proved | GitHub artifact attestation is producible only by the publish workflow; no local run can create it |

## Known limitations shipped deliberately

These are not open defects; each is a measured decision the record explains.
They are listed here because a limitation that ships unnamed becomes next
release's "regression".

- **The JSON snapshot file is not deleted.** Two readers remain by design: the
  lint rules that assert properties of the file's bytes (serialization order, a
  hash over it) and the architecture-map baseline that embeds and hashes the
  whole snapshot. Both need contract changes, not migrations. The v1 query
  engine is unreachable from production search but still present.
- **`requiredForPublish` / `alwaysOnRelease` are predicate-verified and
  production-unreachable.** `buildGateNodes` sets the flag and protected risk in
  one call, so the metadata arms cannot fire on real data; a green run after any
  future migration is not evidence they work. The quality gate reports
  `protected_metadata_arm_unreachable: true` so this stays visible.
- **Two benchmark cases resist both engines** (`focus-path-restricted-answer`,
  `graph-dependency-cycle`) — documented v2 limitations, not chased.
- **Four evidence-lane gold targets are unrealized** (62 of 76): the benchmark
  fixture has no context pack, so both engines score zero there and cancel.
  Resolving this must not be done by editing gold; it is a recorded decision
  waiting on a fixture, not a cleanup.
- **The system-wide extractor metadata entropy gap remains open** for fields
  other than claim prose (proof hashes and digests are legitimate
  entropy-shaped content, so the guard is per-field opt-in). Tolerable for a
  local, gitignored cache — which the store now provably is.
- **`maxTests: 128` was not raised.** It bites on 1 of 7 sampled real diffs and
  now reports itself; raising it is an unmeasured decision left on the record.

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
lifecycle, or require a live Paseo session as 9.1.0 release proof. The owned
contract is limited to the committed `paseo.json` and accurate usage guidance.

The active Telegram command, transport, Doctor projection, native poller and
settings, feature/package entries, tests, and release requirements must be
absent. Historical changelog entries and narrowly scoped retired-state
migration code remain historical or upgrade-safety records; their presence is
not evidence of an active integration.

## Exact-commit release evidence

Before any release claim, regenerate and verify current 9.1.0-bound artifacts
from the clean handoff commit, including the build manifest, version metadata,
package proof, pack receipt, release provenance, and release-check stamp. Each
must bind the exact source digest, Git commit, tarball bytes, and package
version required by its schema. The release-check stamp must be produced under
the lifecycle Node (nvm v24.0.2), not the Homebrew Node, or it fails with a
false `canonical_test_proof_node_version_mismatch`.

Existing 9.0.6 and earlier canonical-test proofs, pack receipts, provenance,
and stamps are stale for this candidate. Local focused tests and a dry-run
tarball remain preparation evidence only until the repository's clean-commit
release flow produces current receipts.

## Remaining real and operator evidence

The following remain **not-run-real** or **blocked-external**:

- source-bound physical release evidence. `inspectMainPushGuard` reports
  `physical_proof_requirement_missing` until the publish workflow produces a
  GitHub-attested capture run; `gh attestation verify` cannot be satisfied by
  any local run, so this is the one release requirement no local flow can meet;
- an upgraded real workspace observed end to end: a machine arriving from
  8.7.0 should hit exactly one `context_graph_missing` refusal naming
  `sks align run --rebuild-index`, run it once, and retrieve normally — proved
  hermetically by the upgrade-shaped freshness tests, not yet witnessed on a
  user machine;
- npm publication or dist-tag mutation.

The operator owns those credentials and registry mutations. Git promotion is
allowed only under an explicit user request after exact candidate checks and
must be verified against the remote commit and tag.
