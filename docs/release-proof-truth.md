# Release Proof Truth — 10.1.2
## Current assertion

10.1.2 is a release candidate. Source changes and version metadata do not
authorize publication. The final clean candidate commit must have a passing
canonical test proof, full release DAG, required real-check summary, fresh
dist, and matching release stamp and pack receipt. Direct publication also
requires clean `main` equal to live `origin/main`, an unpublished version,
the configured public `latest` dist-tag, and valid maintainer authentication.
The operator performs the final `npm publish`.

| Claim | Evidence required for 10.1.2 |
| --- | --- |
| Version authorities agree | Current `release:version-truth` result after the final build |
| Center reads the effective MCP inventory | Native process tests covering delayed output, workspace arguments, and error responses; desktop captures remain separately identified |
| Existing global roles migrate safely | Tests for Astra/Luna routing, custom homes, missing directories, symlinks, and preservation of user provider/permission settings |
| The package can be published | Full source-bound stamp, pack receipt, provenance, clean live-origin preflight, authenticated maintainer, and successful lifecycle dry run |
| 10.1.2 is published | Registry metadata and tarball identity after the operator publishes; no prepublication check proves this |

The npm registry reported 10.1.1 as `latest` on
2026-09-07. Neither older release receipts nor synthetic fixtures prove
current live behavior. Optional physical and image evidence remains optional
for the direct path and must retain its measured status. See
[the current release procedure](release-readiness.md#direct-npm-publication).

## Historical assertions

Everything below records 10.0.0 or an earlier release. Preserve each original
version, commit, result, and evidence class; none authorizes 10.1.1.

# Release Proof Truth — 10.0.0 (historical)
## 10.0.0 assertion (historical)

10.0.0 is **SOURCE TAG CONDITIONAL / NPM PUBLICATION OPERATOR-OWNED**. It is
Essential Trust: the published 9.2.6, the never-published 9.2.7 readiness-truth
fixes, and a verification-profile architecture whose default, `essential`,
keeps the safety gates and drops the anti-lying rituals — Stop-hook Honest
Mode / completion-summary wording gates and the gap loopback, Stop-time
completion proof / reflection / ledger requirements, the per-tool-call
PostToolUse evidence hook, denial over managed-skill digest drift, refusal of an
interrupted-tool-output prompt, and the image route's manual real-output proof
as a readiness blocker. Hooks run through the warm `sksd` daemon with a
version guard. `strict` is the pre-10 behavior and stays the default inside
the test harness. See `docs/essential-trust.md`.

9.2.7 (commit `4de781997995ba737dc9d50983ecaea8e455652d`, gate-verified with
`release:check:full` exit 0, never published — superseded by 10.0.0 before the
operator published it) is the
published 9.2.6 plus three readiness-truth fixes found while recording the
9.2.6 live evidence on this machine: (1) the serving bridge's state heartbeat
rewrote the whole state document from its in-memory copy every ~100 s, erasing
the `last_verified_probe_ids` a `bridge verify` had just written, so the
transport diagnostic never bound to the current process and readiness sat at
`degraded` — `ready: false` with an empty blocker list, reported ok — on every
machine; the heartbeat now adopts the on-disk ids. (2) `sks doctor --json`,
the fast path SKS Center's Diagnostics view calls, emitted a fixed
`not_checked` bridge stub; it now reads the serving process's own log (state
file plus bounded tail, no launchctl, no probes, no secret stores) and names
`desktop_bridge_upstream_unreachable:*` in `desktop_bridge`, `warnings`, and
`next_actions` while keeping the fast contract. (3) `sks doctor --fix` and the
`sks update` catalog-repair stage run one transport verify after a restart or
whenever the bridge reads `degraded`, so a repaired machine finishes `ready`;
the full doctor names a remaining `degraded` instead of swallowing it.

9.2.6 (published 2026-09-02, tag `v9.2.6`, source commit
`49f0b46ca291e9dcab612b1096d418fe46ed1c15`) remains fully proven: it is the
published 9.2.5 plus the Desktop Bridge upstream re-resolution fix. The registry tarball is the tarball
the release gates verified — `dist.integrity`
`sha512-S6b79RwP8di+Lb9VhwaW9S2w+wY7izcofhDfF4yRqTdP+03/tPzn25Du6Tmiehd1q3wxkpbQCfbuzls4GD5KUg==`,
`dist.unpackedSize` 12314948, `dist.fileCount` 1738, shasum
`00c138cf8e4aac208ad61ec5ad3d9d2ac44290aa`, and `gitHead` all equal the local
pack receipt for that commit byte for byte, and the maintainer's Mac was
upgraded from that same gate-verified tarball, so the live measurements below
are measurements of the published bytes. The 2026-09-01 field shape on this
machine: the bridge started 2026-08-28T05:28Z
while a VPN was up, resolved the codex-lb gateway's DNS once at prepare time,
and pinned the first answer for the life of the process; after the network
changed every codex-lb request was rejected
`bridge_upstream_unavailable:EHOSTUNREACH` (66 suppressed in one 60-second
window at 14:18Z alone) while `sks bridge status`, doctor, SKS Center, and the
update path all reported green — the diagnostics health endpoint never touches
the upstream, readiness read a cached report, repair restarted only on version
skew, and nothing consumed the rejections the bridge itself was logging. A
`launchctl kickstart -k` re-resolved the pin and every transport probe went
green within a minute. 9.2.6 makes the bridge re-resolve a pin in place on
unreachable-class connect failures and replay the buffered Responses body
(WebSocket upgrades reconnect once), re-resolve pins on a 5-minute TTL without
flapping a still-listed address, defer instead of crash-loop when DNS is down at
start, and lets `sks doctor` read the serving process's own log to name
`desktop_bridge_upstream_unreachable:*` — with `--fix` and the `sks update`
catalog-repair stage restarting the service on standing evidence.

9.2.5 (published 2026-08-28, tag `v9.2.5`, source commit
`a8dd9664e5fa07614819e68584078c3c2bc8d2ff`) remains fully proven: it is the
published 9.2.4 plus the official-models `auto` convergence fix, the Codex
0.150.1 runtime contract, and the legacy runtime data GC. The registry tarball
is the tarball the release gates verified — `dist.integrity`
`sha512-s2tnlnHQfbF+HL/7bQtpTa2Mk21DSwqJCHTiSqWYbM71jb5Xxxt6uC7eRdXomd8PNop4/eMtfWE7JYVuZ6gI4g==`,
`dist.unpackedSize` 12303242, shasum `9174200bb7fc08c2ceb06797efa25c39d58c0e5d`,
and `gitHead` all equal the local pack receipt for that commit byte for byte,
and the maintainer's Mac was upgraded from that same gate-verified tarball, so
the live measurements below are measurements of the published bytes. The 2026-08-27 field
shape on this machine: one 9.2.4 bridge start resolved `auto` off a transient
not-ready provider-registry snapshot (`official_models_auto_applied
mode=passthrough` at 10:04:38.427Z against registry generation `cca21cfa…`),
flipped the bare `gpt-5.6-*` routes to the official `openai` identity, and the
one-directional serve apply preserved that flip across every later healthy
start — `gpt-5.6-sol` turns left through the operator's ChatGPT OAuth while
status showed a ready, registered codex-lb. `applyOfficialModelPassthrough`
gateway mode now un-flips each bare official id to the target its
`codex-lb:<id>` twin names, the serve path applies the resolved mode in both
directions and logs which mode it applied, and a passthrough→gateway round
trip regenerates the original policy generation, so one bridge restart on
9.2.5 converges the persisted policy back onto the gateway.

9.2.4 (published 2026-08-26, tag `v9.2.4`, source commit
`502c83a42784a71747d153783b8d54bb3bbb68fa`) remains fully proven: the registry
tarball is the tarball the release gates verified — `dist.integrity`
`sha512-PA3hGuc62w2AZgF92uFKiMVf7sIzNWXWTqug35Nh2SL9I3COf/RYq8t7flklhmaXRJwaoknzUldUfcoOcKzspQ==`
and `dist.unpackedSize` 12293683 equal the local pack receipt byte for byte, and
the registry's `gitHead` is that same commit — the 9.2.1 failure mode, where the
published tarball predated the change it was cut for, is excluded by
measurement rather than by assumption. It is the published 9.2.3 plus the
Desktop Bridge service-lifecycle fixes: the launchd
plist has always passed `bridge serve --supervised`, the CLI argument parser had
never registered that flag, so every launchd start exited immediately with
`bridge_command_unknown_option`, `KeepAlive { SuccessfulExit: false }` declined
to restart a clean exit, and the failed activation booted the service out —
Codex then reconnected forever against a loopback port nothing was listening on.
The CLI option table and the launchd argv are now one module, `sks update`
bootstraps an installed-but-down bridge instead of skipping it, and a launch
entry under a macOS-protected user folder is never written into the plist.

9.2.3 (published) is the published 9.2.2 plus one contract fix: Desktop Bridge status validation accepts
the canonical official identity route id `openai` for bare official-family
models such as `gpt-5.6-luna`. The live route policy already flipped those
models onto that target (the same public id OpenCodex uses as
`OPENAI_CODEX_PROVIDER_ID`), but the status schema and runtime validator still
enumerated only `codex-lb` and `openrouter`, so `sks doctor --fix` and Control
Center failed closed with
`desktop_bridge_status_schema_invalid:$.routing.policy.model_routes."gpt-5.6-luna".provider_id:enum`.
Provider profiles, `default_provider_id`, and session pins stay provider-only.

9.2.2 (published) is the published 9.2.1 plus one semantic change: `auto`
official-models routing follows the operator's registration — codex-lb
registered+enabled+credentialed resolves `auto` to the gateway even on a
ChatGPT-OAuth host, un-registering converges back onto the official identity at
the next bridge start or catalog sync, and explicit pins beat registration in
both directions. This change was staged for 9.2.1, but the registry's 9.2.1
tarball (published 2026-08-23T11:44:38Z, shasum
`72c37a1a05afda0d777364d56812fb2862947e73`) was built from the pin-persistence
commit `146e6cc5` — hours before the registration change landed in `0734523a`.
Verified by downloading the registry tarball: its dist carries the
`official_passthrough` serializer fix but no `codexLbRegistered` resolution.
npm forbids republishing a version, so the change shipped as 9.2.2.

9.2.1 (published) is 9.2.0 plus one durability fix: the official-models pin (official_passthrough.models) survives settings rebuilds and catalog syncs — two writers dropped the field, found by post-publish verification. 9.2.0 was
9.1.1 plus the identity-architecture fix behind "auth keeps dropping during
compaction": official ChatGPT identity passthrough in the Desktop Bridge
(client credentials forwarded verbatim to the official upstream for everything
the route policy does not claim for a provider, plus explicit `openai` model
routes and the `sks bridge route official-models` flip), a cooldown-bounded
supervised skew restart (the 438-cycle 2026-08-19 storm shape), newest-rotation
auth write-back for subagents, an identity-keyed (not byte-keyed)
`authSemanticIdentityPreserved`, timestamped bridge log records, re-firing
desktop-bridge gates, and the three-replay compact-503 absorber that had been
committed after the 9.1.1 publish. This document does not authorize
publication, deployment, a credential change, a Git tag, or a push.
Exact-commit proof can exist only after the candidate is committed and all
source-bound gates are regenerated from that clean commit.

All release artifacts bound to 9.2.7 or an earlier commit are historical. They
must not be renamed, copied, or treated as 10.1.2 evidence.

New 10.1.2 claims:

| Claim | Current support | Boundary |
| --- | --- | --- |
| The essential profile is the product default and strict is the harness default | passed-hermetic | `resolveVerificationProfile`: env `SKS_VERIFICATION_PROFILE` → project `.sneakoscope/verification-profile.json` → global `verification-profile.json` → `strict` under `NODE_TEST_CONTEXT`/`SKS_TEST_ISOLATION` → `essential`; garbage env falls through; summary names the source |
| A finished turn finishes | passed-hermetic | Stop hook under `essential` returns `continue` with `essential_profile_stop_accepted` for a plain completion message; the same message under `strict` is still blocked for Honest Mode wording; loop continuation and no-question autonomy are untouched |
| Skill digest drift and interrupted tool output never stop work in essential | passed-hermetic | prompt-time, post-hoc, and per-tool-call admission blocks are gated on `managedSkillDigestBlocksEnforced`; the quarantine prompt returns `continue` with the recovery advice as context; strict still refuses |
| PostToolUse is not installed and stale entries converge | passed-hermetic | `managedHookEventNames` omits PostToolUse in essential (10 events in strict); `mergeManagedHooksJson` removes the SKS PostToolUse entry from a legacy hooks.json, keeps a user-authored one, and drops the event when nothing remains; the managed TOML installer filters the same way |
| Hooks are warm by default and a daemon cannot outlive an update | passed-hermetic | `hookDaemonEnabled`: on unless `SKS_HOOK_DAEMON=0`, off inside the harness unless `=1`; a request carrying a different `sks_version` is answered `sksd_version_mismatch` without reaching the handler and the daemon retires (real-socket test); measured on this machine: ~600 ms cold → ~150 ms warm per hook |
| `doctor --full` can be `ready` on a real machine | passed-hermetic | `route-image` manual-proof blockers are warnings in essential and blockers in strict (matrix test both ways); the readiness matrix unwraps the doctor bridge wrapper so a blocked bridge fails `core_ready` (matrix test) |
| The installed 10.0.0 finishes a real Codex turn without a Stop block on the live machine | not proved | requires the installed 10.0.0 hooks on the operator's machine completing a real turn with no Stop `decision: block`, plus `sks doctor --full --json` reporting `ready: true` |
| The serving process's heartbeat cannot erase the verifier's attestation | passed-hermetic | `refreshDesktopBridgeState(…, { preserveVerifiedProbeIds: true })` adopts the on-disk `last_verified_probe_ids` into the in-memory state before rewriting; the verifier's own refresh still writes exactly what it passes (an empty set clears stale ids); unit-tested against a real state file across verify → heartbeat → verify |
| Fast `sks doctor --json` names a stranded bridge | passed-hermetic | state file + 256 KB log tail through the import-free `upstream-evidence` module; `desktop_bridge.status` is `log_evidence_clear`, `upstream_unreachable_evidence` (blocker + repair in `blockers`/`recovery_actions`, mirrored into `warnings`/`next_actions`), or `not_checked` with the reason; `ok`/`fast_readonly_ok` unchanged; `doctor:fastpath` gate 64 ms on this machine; no secret store read (sentinel test) |
| `--fix` and `sks update` finish `ready`, not `degraded` | passed-hermetic | `reverifyTransportIfDegraded` runs one `verify --level transport` when the serving bridge reads `degraded` or was just restarted, under fix only; a ready bridge triggers no probe; the read-only doctor never probes; `desktop_bridge_transport_reverified` / `…_reverify_incomplete:<state>` name the outcome |
| Degraded readiness is named, not swallowed | passed-hermetic | `inspectDoctorDesktopBridgeStatus` adds `desktop_bridge_readiness_degraded:transport_unverified_for_current_process` plus the verify command when `ready` is false with no blockers |
| The maintainer's Mac holds `ready` past a heartbeat tick on 9.2.7 | not proved | requires the installed 9.2.7 bridge and `sks bridge status --json` reporting `readiness.state: ready` more than 100 s after a transport verify |
| A dead pinned upstream address heals inside the serving process | passed-hermetic | `refreshDesktopBridgeRemoteTarget` re-resolves the shared target in place on `EHOSTUNREACH`/`ENETUNREACH`/`ENETDOWN`/`EHOSTDOWN`/`EADDRNOTAVAIL`/`ECONNREFUSED`/`ETIMEDOUT`/connect timeout/`ERR_TLS_CERT_ALTNAME_INVALID`, steers away from the address that just failed, runs the full private-address and rebinding validation of a fresh start, dedupes concurrent callers, and cools down 5 s; the HTTP path replays the buffered Responses body on a fresh connection and the WebSocket path reconnects once; real-socket e2e: a bridge pinned to `::1` where nothing listens answers 200 (HTTP) and 101 (upgrade) once DNS answers `127.0.0.1`, and the shared pin is durably rewritten |
| A pin follows DNS without flapping | passed-hermetic | the 5-minute TTL refresh keeps a still-listed address and switches only once it has left the answer set; a fresh pin performs no lookup; a failed or newly-forbidden resolution keeps the existing pin |
| DNS unavailable at bridge start defers the pin instead of crash-looping the service | passed-hermetic | only `bridge_remote_dns_failed` at prepare yields a deferred pin (`unresolved`, address `0.0.0.0`, named in `deferred_upstreams` on the `started` log line); first use resolves it or answers `bridge_remote_dns_failed`; private-address and rebinding answers still refuse to prepare exactly as before |
| Doctor and update converge a stranded bridge | passed-hermetic | `detectUnreachableUpstreamEvidence` reads `bridge_upstream_unavailable*` rejections written by the CURRENT process (state-file `started_at`, 10-minute window; a newer `bridge_upstream_unreachable_rerouted` line clears the evidence); read-only doctor names `desktop_bridge_upstream_unreachable:*` with the repair; `--fix` and the update catalog-repair stage restart the service on standing evidence; version-stale restart precedence unchanged; harnessed runs never reach `launchctl` |
| The installed 9.2.6 bridge is serving on the live machine | verified-on-machine | measured 2026-09-02 on the maintainer's Mac after installing the gate-verified 9.2.6 tarball: the global install landed at 06:17:36Z and the bridge log shows a 9.2.6 `started` on a new pid (62482) at 06:18:02.879Z, 26 seconds later, with no `version_skew` line in between (the install-side convergence restarted it before the in-process skew check had to); `sks bridge verify --level transport --json` on the installed 9.2.6 reports `bridge_ready`, `active_routes_ready`, and `transport_level_satisfied` with zero blockers; `sks bridge route explain gpt-5.6-sol --json` resolves `codex-lb`; and the full read-only doctor bridge inspection (`sks doctor --full --json`, `sks.doctor-desktop-bridge.v1`, which now includes the upstream-evidence read) reports `ok: true` with empty `blockers` and `recovery_actions` for the serving pid — no `desktop_bridge_upstream_unreachable` false positive against the healthy log (the fast `sks doctor --json` path does not inspect the bridge at all and says so: `not_checked`/`fast_readonly_json`). One machine, one macOS version |
| The installed 9.2.6 bridge survives a network change on the live machine | not proved | requires the installed 9.2.6 bridge on the operator's machine to log `bridge_upstream_unreachable_rerouted:*` followed by no `bridge_upstream_unavailable` after a real network change, or a `sks doctor --fix` run that restarts a bridge whose log carries the rejections; the standing proof of the mechanism is the real-socket e2e in `remote-target-refresh.test.ts` (dead `::1` pin → 200 / 101 after DNS answers `127.0.0.1`) |
| The published 9.2.6 tarball is the tarball the gates verified | verified-on-registry | `npm view sneakoscope@9.2.6` reports `gitHead` 49f0b46c and `dist.integrity` / `dist.unpackedSize` / `dist.fileCount` equal to the local pack receipt for that commit (`sha512-S6b7…KUg==`, 12314948, 1738; registry shasum `00c138cf…`); `latest` now resolves to 9.2.6; the tarball was not rebuilt into something the gates never saw |
| Official-models `auto` converges to the gateway on a registered host | passed-hermetic | `applyOfficialModelPassthrough({ mode: 'gateway' })` restores each bare-official `openai` route to the target its `codex-lb:<id>` twin names, catalog upstream aliases included; a passthrough→gateway round trip regenerates the original policy generation; twin-less official routes stay passthrough |
| A stale passthrough flip cannot outlive a healthy bridge start | passed-hermetic | serve-time auto apply computes the converged policy for BOTH resolved modes, persists settings + route-policy file only when the generation moves, and logs which mode it applied; both directions are idempotent, so healthy starts write nothing |
| The Codex runtime contract tracks 0.150.1 | passed-hermetic | `@openai/codex-sdk` 0.150.1 with the SDK capability and dependency-graph gates green; the feature-flag strip list re-pinned against the vendored 0.150.1 `features list` (strip set unchanged, `multi_agent_mode` now absent rather than `removed`); vendored models-manager base instructions byte-identical to rust-v0.150.1 |
| Legacy runtime data GC deletes only provable SKS residue | passed-hermetic | exact SKS backup name shapes with the newest 3 kept; bridge generation bundles deleted only under an intact active-generation pointer (no pointer ⇒ keep everything); retired `codex-01xx-*` caches and the superseded chrome-hosts v1 record only; moved-config provenance markers compact to the newest line; inert on a clean machine |
| `gpt-5.6-sol` routes through codex-lb on the live machine | verified-on-machine | measured 2026-08-27 on the maintainer's Mac after installing the gate-verified 9.2.5 tarball: the running 9.2.4 bridge's supervised skew check logged `version_skew running 9.2.4 installed 9.2.5 action=restarting` within one 60-second tick and launchd relaunched it as 9.2.5 on a new pid; the 9.2.5 start wrote no `official_models_auto_applied` event against the already-converged policy (both directions idempotent in production); `sks bridge route explain gpt-5.6-sol --json` on the installed 9.2.5 resolves `{provider_id: codex-lb, upstream_model: gpt-5.6-sol}` at the registered gateway endpoint with zero blockers, and the status route table shows bare `gpt-5.6-sol`/`-luna`/`-terra` all on `codex-lb`. One machine, one macOS version: an existence proof for the fixed path, not a fleet claim |
| The argv launchd passes to `bridge serve` cannot contain an option the CLI rejects | passed-hermetic | one table (`bridge-cli-contract.ts`) backs `parseArgs`, every subcommand allowlist (typed against it, plus a runtime desync assert for the shipped JS), and the plist argv builder, which throws on an unregistered option; the contract suite drives the builder's argv — and the same argv round-tripped through the rendered plist — through the real CLI and asserts `bridge_command_unknown_option` never appears for a registered option |
| `--supervised` means the same thing to the plist writer and to the runtime | passed-hermetic | one exported constant is written into the plist, registered in the option table, and read by `desktopBridgeIsSupervised`; the suite asserts a process started from the launchd argv reports itself supervised and an argv without the flag does not |
| `sks update` revives a Desktop Bridge that is installed but not running | passed-hermetic | the restage stage bootstraps a service with a plist plus settings and no live pid, still kickstarts only a live stale one, leaves a current bridge alone, and never turns a failed recovery into a failed update; tests inject both launchd seams, and the stage entry point still refuses the real `launchctl` under `NODE_TEST_CONTEXT`/`SKS_TEST_ISOLATION` |
| A launch entry under Desktop/Documents/Downloads is never written into the plist | passed-hermetic | `resolveLaunchCommand` skips protected candidates by realpath (so an `npm link`ed global counts as protected), falls back to the `sks` on PATH, and reports `desktop_bridge_entry_macos_protected_folder` when no runnable entry remains |
| A past release's upgrade-smoke record is not restamped by a version bump | passed-hermetic | the readiness-doc rewrite is non-global and anchored on the leading current-decision line; the current-docs suite asserts a historical `7.6.0 to 1.1.0 upgrade smoke` line survives a bump |
| The published 9.2.5 tarball is the tarball the gates verified | verified-on-registry | `npm view sneakoscope@9.2.5` reports `gitHead` a8dd9664 and `dist.integrity` / `dist.unpackedSize` / shasum equal to the local pack receipt for that commit (`sha512-s2tnln…gI4g==`, 12303242, `9174200b…`); `latest` now resolves to 9.2.5; the tarball was not rebuilt into something the gates never saw |
| The legacy runtime data GC ran on a real machine | verified-on-machine | applied 2026-08-27 on the maintainer's Mac by the shipped convergence: `~/.codex` config backups went from 25+ files to the newest 3, `.sks-bridge-generations` from 5 bundles to active + 1 rollback under the intact active pointer, the retired `codex-0138/0139-*` caches and the superseded v1 chrome-hosts record are gone, and the moved-config marker pile compacted from 60+ lines to the single newest line — with the GC report showing zero errors and the next run detecting nothing (inert on a clean machine) |

9.2.3 claims (published):

| Claim | Current support | Boundary |
| --- | --- | --- |
| Status schema accepts official `openai` route targets including `gpt-5.6-luna` | passed-hermetic | `validateRouting` and `validateDesktopBridgeStatusV3` accept a flipped official-passthrough policy; unknown provider ids still fail `:enum`; official-models-route-flip + desktop-controller-v3 suites pin the exact doctor error path |
| Provider profiles, default_provider_id, and session pins stay registry-only | passed-hermetic | route-target enum is `codex-lb`/`openrouter`/`openai`; session pin and provider profile enums stay `codex-lb`/`openrouter` |

9.2.2 claims:

| Claim | Current support | Boundary |
| --- | --- | --- |
| auto follows the operator actions: codex-lb registered+enabled → gateway; un-registered on a ChatGPT-OAuth host → passthrough; explicit pins beat registration both ways | passed-hermetic | resolver unit tests pin registered/unregistered/pinned arms across real auth.json shapes; both auto-resolution sites (bridge start, catalog sync) pass the live registry state |
| The registry's 9.2.1 does not contain this change | verified-on-registry | the published tarball (shasum 72c37a1a…, built from 146e6cc5) was downloaded and inspected: dist has the official_passthrough serializer fix and zero codexLbRegistered references |

9.2.1 claims (published 2026-08-23T11:44:38Z):

| Claim | Current support | Boundary |
| --- | --- | --- |
| A pinned official-models choice survives every settings writer | passed-hermetic | defaultDesktopBridgeServiceSettings carries the input field through validation and serializedSettings round-trips it; regression test pins a gateway choice through the sync serializer; machines without a pin keep the auto default |

9.2.0 claims:

| Claim | Current support | Boundary |
| --- | --- | --- |
| Official passthrough carries the client identity and never a bridge credential | passed-hermetic | e2e suite: unrouted model, `alpha/search`, explicit `openai` route, and unpinned WS upgrade all reach a mock official upstream with the client's own Authorization + chatgpt-account-id and no `x-codex-lb-api-key`; a provider-routed model in the same bridge still strips the client identity and injects the provider key; header-policy unit tests assert the strip/keep sets both ways |
| Official error bodies reach Codex verbatim | passed-hermetic | a mock official 401 with `token_expired` detail streams back byte-preserved; provider-routed errors keep the existing redaction; transient official 5xx on buffered Responses bodies still replay (503-then-200 heal pinned) |
| The official-models mode is auto-applied, durable, and scoped | passed-hermetic | default `auto` resolves from the host auth at every bridge start and catalog sync (ChatGPT OAuth → passthrough, gateway/API-key/missing → gateway) and `sks update` converges via the bridge restart; explicit `gateway`/`passthrough` choices persist in settings and are never overridden; `applyOfficialModelPassthrough` rewrites bare `gpt-*`/`o*`/`codex-mini*` ids only — prefixed picks and `codex-auto-review` keep their provider; policy_generation regenerates and self-validates; a pre-flip codex-lb session pin is absorbed into passthrough instead of failing the thread |
| A skew restart that cannot converge is suppressed, not repeated | passed-hermetic | marker records the exact (running, installed) pair; the same pair within 30 minutes logs `suppressed_cooldown` and keeps serving; either version moving restarts immediately; pure-function unit tests pin all four arms |
| Subagent auth write-back keeps the newest token rotation | passed-hermetic | host-newer/undated conflict resolves ok as `host_newer_kept` with the temp root removed; ours-newer retries the CAS once against the fresh host state, installs the newer rotation, and preserves host-written non-token fields (`refreshed_persisted_after_conflict`); both arms pinned in the native-provider policy suite |
| Auth preservation keys on identity, not bytes | passed-hermetic | same-fingerprint byte drift preserves; identity change, mode flip, unverifiable fingerprint, and existence change still fail; non-OAuth snapshots keep byte equality; the no-op migration path no longer blocks on `desktop_auth_changed_during_noop` for an identity-preserving refresh |
| Bridge log records carry wall-clock timestamps | passed-hermetic | every rejection/summary record stamps `at` (ISO) and `started`/`version_skew` records stamp `at` + version fields — the 14.5-hour storm forensics gap |
| A 502/503/524 gateway transient is absorbed before Codex compact can see it | passed-hermetic | first try plus 3 fresh-connection replays; `upstream_request_timeout` included; unidentified 502/503/524 bodies included; genuine `response_not_found` stays 404; leftover 503 only after the budget; pinned by the bridge keepalive suite including a 4th-attempt compact-shaped 503 heal |
| Exhausted upstream errors no longer say "Upstream request failed" | passed-hermetic | 429 → `rate_limited` + Retry-After; transient exhaust → `temporary_upstream_failure`; other 4xx/5xx → `bridge_upstream_request_failed`; identifiers still survive; free text still dies |
| WebSocket refusal cannot crash the bridge process | passed-hermetic | `safeEndUpgradeSocket` swallows socket errors and refuses to write an already-ended stream; unit-tested on an ended and a destroyed PassThrough |
| `sks update` quarantines other-harness conflicts | passed-hermetic | `other-harness-cleanup` now calls `cleanupOtherHarnessConflicts` instead of failing closed; from-home update e2e still runs every migration stage |
| Host extra skill dirs lose only SKS-owned retired residue | passed-hermetic | `~/.cursor/skills` and `~/.claude/skills` remove managed retired names only; user-authored collisions stay in place |
| A stale or cwd-sticky official workflow cannot capture a later prompt | passed-hermetic | unnamed hooks use `loadOwnedRouteState`; idle > 2h is inactive even with leftover open threads; same-session follow-ups still bind while the run is fresh |
| All checked version authorities report 10.1.2 | passed-hermetic | `release:version-truth` 15 surfaces at 10.1.2 after incremental build |
| The reported 10.1.2 package is ready to publish | not proved | requires a clean exact-commit build, `npm run release:check:full` stamp, pack receipt, provenance, and the release commit fast-forward pushed to origin main (the prepublish reproducibility preflight refuses `head_not_origin_main`) |

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
