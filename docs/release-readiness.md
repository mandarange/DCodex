# SKS 10.1.2 Release Readiness

## Current release

10.1.2 enables experimental Codex context management by default during global
setup and repair. SKS Center Settings and `sks codex-app context-management`
provide an explicit opt-out that updates preserve. Changes apply to new tasks;
Codex account and provider eligibility still determine runtime availability.

On 2026-09-07 npm reported `latest` as 10.1.1. The release stamp and pack receipt
must bind the final clean 10.1.2 commit. Actual publication remains the operator's
final `npm publish` step.

## Direct npm publication

Finish source changes, version metadata, documentation, source-index refresh,
and focused verification before creating the candidate commit. Then run the
normal full release workflow from that clean commit:

```sh
npm run release:check:full
```

This command performs one clean build, one canonical release test run, the full
release DAG, creation of the clean-HEAD pack receipt, required real checks,
dist freshness verification, and release-stamp creation, in that order.
Missing or failed required Codex, SDK, or worktree checks block the stamp.
Optional image-generation and staged physical evidence are reported according
to their actual coverage and cannot be represented as passed live execution.

Generated navigation projections are local caches and stay out of Git and the
npm package. After the final checks and dry run, run `sks align run` and
`sks wiki validate .sneakoscope/wiki/context-pack.json --json` to include the
latest proof-bank evidence without changing the release commit.

After the checks pass, the authorized maintainer pushes the same candidate
commit to `main`. Direct publication requires a clean `main` checkout exactly
matching live `origin/main`; it does not require a pre-existing release tag.
Before handing publication to the operator, verify:

```sh
npm run release:version-truth
node ./dist/scripts/release-check-stamp.js verify
node ./dist/scripts/release-pack-receipt.js verify
node ./dist/scripts/release-provenance-check.js --publish
npm whoami --registry https://registry.npmjs.org/
npm view sneakoscope maintainers --json --registry https://registry.npmjs.org/
npm publish --dry-run --json
```

The dry run executes the normal lifecycle. `prepublishOnly` checks repository
reproducibility, the npm dist-tag, and the full release stamp; `prepack` performs
a deterministic clean rebuild and verifies the same stamp again. A dry run
does not check upload authentication, so the separate identity and maintainer
checks above are required for the handoff. The actual publication repeats its
registry-authentication preflight.

After a successful handoff, the operator runs only:

```sh
npm publish
```

`publishConfig` supplies the public npm registry, public access, and the
`latest` tag. npm may request the operator's authentication or two-factor
confirmation. Do not disable lifecycle scripts. Do not modify or commit files
after creating the stamp: a new commit or changed source requires a fresh full
release check. Registry publication remains the operator's action.

## Historical release records

The following 10.0.0 and earlier records preserve their original claims and
evidence. Their candidate commands, versions, and pending decisions are not
the 10.1.1 release procedure. The staged workflow described later is a separate
publication option; direct `npm publish` does not require its physical receipts.

# SKS 10.0.0 Release Readiness (historical)

## 10.0.0 candidate decision (historical)

**SOURCE TAG CONDITIONAL / NPM PUBLICATION OPERATOR-OWNED.**

10.0.0 is Essential Trust. SKS was built when models lied often enough that every completion had to be policed — an "Honest Mode" section matched by regex before a turn could end, a completion proof per route, a reflection gate, evidence ledgers written after every tool call, skill files whose one-byte drift denied every subsequent tool call — and those rituals became the product's largest cost: two cold hook processes per tool call (~1 s of harness time per call), finishes blocked over wording, and a `sks doctor --full` that could never be `ready` on a real machine because the image route's proof is a hardcoded `false`, which kept SKS Center's health badge permanently orange. 10.0 introduces a verification profile with `essential` as the default: the safety gates stay (DB safety and the catastrophic set, secret handling, the harness-maintenance guard, recursion and fan-out caps, no-question interactive-command refusal, host-capability allowlists) and the anti-lying rituals go — the Stop hook accepts a finished turn, managed-skill digest drift is repaired or advised instead of denying work, the interrupted-tool-output prompt is advised instead of refused, the PostToolUse evidence hook is no longer installed (and `sks update` removes the stale entry), hooks run through the warm per-project `sksd` daemon (~150 ms instead of ~600 ms, with a version guard that retires a daemon the next `sks update` outgrows), and the image route's manual proof is a warning. `strict` restores the pre-10 behavior (`SKS_VERIFICATION_PROFILE=strict` or `verification-profile.json`); inside the SKS test harness `strict` stays the default so the existing suite keeps proving it. It also fixes the readiness matrix's dead Desktop Bridge branch (it read the doctor's wrapper object). The release pipeline itself is unchanged in 10.0.0 and is slated for the same simplification in the next minor. Live evidence stays operator-owned: only the installed 10.0.0 finishing a real Codex turn without a Stop block, and `sks doctor --full --json` reporting `ready: true` on the operator's machine, can produce it. Regenerate the isolated 7.6.0 to 10.1.2 upgrade smoke, the full release gate DAG, pack receipt, and release-check stamp from the clean candidate commit. The 9.2.7 candidate below (commit 4de78199) was gate-verified but never published; its fixes ship inside 10.0.0.

9.2.7 makes Desktop Bridge readiness tell the truth after 9.2.6's heal. Recording the 9.2.6 live evidence on the maintainer's Mac showed the bridge `degraded` minutes after a green transport verify: the serving process's state heartbeat rewrote the whole state document from its in-memory copy every ~100 seconds, erasing the `last_verified_probe_ids` the verifier had just written, so the transport diagnostic never bound to the current process and readiness sat at `degraded` — `ready: false` with an empty blocker list, which doctor and every surface above it read as green. The heartbeat now adopts the on-disk ids before it writes. Two more truth gaps close with it: `sks doctor --json` (the fast path SKS Center's Diagnostics view calls) emitted a fixed `not_checked` bridge stub and now reads the serving process's own evidence (state file plus bounded log tail, no launchctl, no probes, no secret stores) into `desktop_bridge`, `warnings`, and `next_actions` while keeping the fast contract; and `sks doctor --fix` plus the `sks update` catalog-repair stage run one transport-level verify after a restart or whenever the bridge reads `degraded`, so a repaired machine finishes `ready`. The full doctor names a remaining `degraded` as `desktop_bridge_readiness_degraded:transport_unverified_for_current_process`. Live evidence stays operator-owned: only the installed 9.2.7 holding `readiness.state: ready` past a heartbeat tick on the operator's machine can produce it. Regenerate the isolated 7.6.0 to 9.2.7 upgrade smoke, the full release gate DAG, pack receipt, and release-check stamp from the clean candidate commit.

9.2.6 stops the Desktop Bridge from dialing a dead upstream address for the life of its process. On 2026-09-01 the maintainer's bridge — started 2026-08-28 while a VPN was up — had pinned the first DNS answer for the codex-lb gateway at prepare time; after the network changed, every codex-lb request failed `bridge_upstream_unavailable:EHOSTUNREACH` for days while `sks bridge status`, doctor, SKS Center, and the update path all reported green: the diagnostics health endpoint never touches the upstream, readiness read a cached report, repair restarted only on version skew, and nothing consumed the rejections the bridge itself was logging. The bridge now re-resolves a pin in place on unreachable-class connect failures (steering away from the address that just failed, under the same private-address and rebinding validation as a fresh start, deduped across concurrent requests) and replays the buffered Responses body on the fresh address; WebSocket upgrades reconnect once; pins also re-resolve on a 5-minute TTL without flapping a still-listed address; DNS being unavailable at bridge start defers the pin instead of crash-looping the launchd service; and `sks doctor` reads the serving process's own log (state file plus log tail, no probes) to name `desktop_bridge_upstream_unreachable:*`, while `sks doctor --fix` and the `sks update` catalog-repair stage restart the service on standing evidence. The official ChatGPT upstream gets the same heals. Live evidence stays operator-owned: only the installed 9.2.6 bridge surviving a network change (or a doctor run on a machine whose bridge log carries the rejections) on the operator's machine can produce it. Regenerate the isolated 7.6.0 to 9.2.6 upgrade smoke, the full release gate DAG, pack receipt, and release-check stamp from the clean candidate commit. Published 2026-09-02 as `sneakoscope@9.2.6` from commit 49f0b46c (tag `v9.2.6`): the registry tarball's `dist.integrity`, `dist.unpackedSize`, `dist.fileCount`, and `gitHead` all equal the local pack receipt for that commit — and because the maintainer's Mac was upgraded from that same gate-verified tarball, its measurements are measurements of the published bytes: the bridge was serving 9.2.6 on a new pid 26 seconds after the install landed (`started` 06:18:02Z against an install at 06:17:36Z), `sks bridge verify --level transport --json` reports `bridge_ready` and `active_routes_ready` with zero blockers, `sks bridge route explain gpt-5.6-sol --json` resolves `codex-lb`, and the full read-only doctor bridge inspection (`sks doctor --full --json`, which now includes the upstream-evidence read) reports `ok: true` with empty blockers and recovery actions for the serving pid — no `desktop_bridge_upstream_unreachable` false positive against the healthy log. The heal under a real network change has not yet been exercised on this machine; the real-socket e2e in `remote-target-refresh.test.ts` remains the standing proof of the mechanism.

9.2.5 puts `gpt-5.6-*` turns back on the registered codex-lb gateway. On 2026-08-27 one 9.2.4 bridge start resolved official-models `auto` off a transient not-ready provider-registry snapshot, flipped the bare `gpt-5.6-*` routes to the official `openai` identity, and persisted that policy; the serve-time apply was one-directional (it only ever flipped TOWARD passthrough), so every later healthy start kept sending `gpt-5.6-sol` through the operator's ChatGPT OAuth while SKS Center showed a ready, registered gateway. `applyOfficialModelPassthrough` gateway mode now un-flips each bare official id to the target its `codex-lb:<id>` twin names, and the serve path applies the resolved mode in both directions, so one bridge restart on 9.2.5 converges the persisted policy back onto the gateway. The release also moves the Codex runtime contract to Codex CLI/SDK 0.150.1 (vendored base instructions byte-identical, feature-flag strip list re-verified against the 0.150.1 table, SDK gates green) and adds the legacy runtime data GC to shared convergence (aged config backups beyond the newest 3, non-active non-rollback bridge generation bundles under an intact active pointer, retired `codex-01xx-*` caches, the superseded v1 chrome-hosts record, and the moved-config marker pile compacted to its newest line). Live routing evidence stays operator-owned: only a bridge restart on the installed 9.2.5 followed by `sks bridge status --json` (bare `gpt-5.6-sol` on `codex-lb`) on the operator's machine can produce it. Regenerate the isolated 7.6.0 to 9.2.5 upgrade smoke, the full release gate DAG, pack receipt, and release-check stamp from the clean candidate commit. Published 2026-08-28 as `sneakoscope@9.2.5` from commit a8dd9664 (tag `v9.2.5`): the registry tarball's `dist.integrity`, `dist.unpackedSize`, and `gitHead` all equal the local pack receipt for that commit — and because the maintainer's Mac was upgraded from that same gate-verified tarball, its measurements are measurements of the published bytes: the running 9.2.4 bridge's supervised skew check restarted it onto 9.2.5 within one 60-second tick of the install (`version_skew … action=restarting` then a 9.2.5 `started` on a new pid), the 9.2.5 start wrote no `official_models_auto_applied` event against the already-converged policy (the both-directions apply is idempotent in production), and `sks bridge route explain gpt-5.6-sol --json` resolves `codex-lb` upstream `gpt-5.6-sol` at the registered gateway endpoint with zero blockers.

9.2.4 keeps the Desktop Bridge launchd service alive across an update. Its plist has always passed `bridge serve --supervised`, but the CLI argument parser never registered `--supervised`, so every launchd start exited with `bridge_command_unknown_option`; `KeepAlive { SuccessfulExit: false }` does not restart a clean exit, the failed activation booted the service out, and Codex reconnected forever against a loopback port nothing was listening on. The CLI option table and the launchd argv are now one module (`src/core/codex-lb/bridge-cli-contract.ts`) with the subcommand allowlists typed against it; `sks update` bootstraps an installed-but-down bridge instead of silently skipping it, and still never fails an update over bridge readiness; and `bridge ensure|repair` no longer pins a launch entry under Desktop/Documents/Downloads, where a launchd agent has no files-and-folders grant and node cannot even read `package.json`. Live bridge-serving evidence stays operator-owned: only an install of the published 9.2.4 followed by `sks bridge status --json` on the operator's own machine can produce it. Regenerate the isolated 7.6.0 to 9.2.4 upgrade smoke, the full release gate DAG, pack receipt, and release-check stamp from the clean candidate commit. Published 2026-08-26 as `sneakoscope@9.2.4` from commit 502c83a4 (tag `v9.2.4`): the registry tarball's `dist.integrity`, `dist.unpackedSize`, and `gitHead` all equal the local pack receipt for that commit, and the launchd service was then measured serving on the maintainer's Mac — `sks bridge status --json` installed/loaded/running true, no blockers, a new pid on 127.0.0.1:53451, and a plist argv ending in `--json --supervised`.

9.2.3 makes Desktop Bridge status accept the official `openai` identity route for bare official-family models such as `gpt-5.6-luna`, matching OpenCodex `OPENAI_CODEX_PROVIDER_ID`. The live route policy already flipped those models onto that target; the status schema and runtime validator now enumerate `openai` as a route target so `sks doctor --fix` and Control Center no longer fail closed on `provider_id:enum`. Provider profiles stay `codex-lb`/`openrouter` only. Regenerate the isolated 7.6.0 to 9.2.3 upgrade smoke, the full release gate DAG, pack receipt, and release-check stamp from the clean candidate commit.

9.2.2 makes auto official-models routing follow the operator: registering and enabling codex-lb IS choosing the gateway (selected models keep running through it until the provider is un-registered, when a ChatGPT-OAuth host converges back onto its own identity at the next bridge start or sync), OpenRouter picks stay sticky per model route, and explicit pins beat registration both ways. This change was staged for 9.2.1, but the 9.2.1 tarball on the registry (published 2026-08-23T11:44Z, shasum 72c37a1a) was built from the pin-persistence commit (146e6cc5) hours before the registration change landed (0734523a) — verified by downloading the registry tarball and inspecting its dist — and npm forbids republishing a version, so it shipped as 9.2.2.

9.2.1 (published) makes the official-models pin durable: two settings writers (defaultDesktopBridgeServiceSettings and the catalog-sync serializer) dropped the official_passthrough field, so an explicit gateway/passthrough choice silently reverted to auto on the next rebuild or sync. Found by post-publish verification of 9.2.0 on this machine; both writers now carry the field, with a serializer round-trip regression test.

9.2.0 fixes the identity architecture that made "auth keeps dropping during compaction" true on real machines. The bridge was a pure provider multiplexer: every request lost its ChatGPT OAuth `Authorization` (and `chatgpt-account-id`) and gained a substituted gateway key, so everything server-side that binds to the operator's ACCOUNT — Codex Apps connector links ("This app connection requires reauthentication", 431 rollout occurrences on this machine), conversation affinity for `previous_response_id`, plan quotas — broke intermittently, and re-authenticating could never fix it because the runtime path kept presenting the other identity. Official identity passthrough now forwards the client's own credentials to the official upstream for everything the route policy does not claim for a provider (unknown models, non-Responses backend-api endpoints such as `alpha/search`, unpinned WebSocket upgrades), official error bodies stream back verbatim, and official-models routing follows the operator's auth automatically: the default `auto` mode flips bare official-family models onto the operator's own identity on every bridge start and catalog sync when the host is signed in with ChatGPT OAuth — `sks update` converges without a manual command — while `sks bridge route official-models gateway` pins a deliberate gateway choice that no update can flip; the applied policy survives catalog syncs, absorbs pre-flip gateway pins, and never crosses credentials with provider routes. Alongside it: the supervised skew restart is cooldown-bounded (the 438-cycle, 14.5-hour restart storm of 2026-08-19 can no longer repeat), subagent auth write-back keeps the newest token rotation instead of stranding the host on a dead refresh token, `authSemanticIdentityPreserved` keys on account identity instead of bytes (ending the intermittent catalog.sync aborts on legitimate token refreshes), every bridge log record now carries a timestamp, and the desktop-bridge release gates re-fire on bridge-core changes. 

9.1.1 is a stability patch on 9.1.0. The desktop bridge stops manufacturing the
user-visible sentence "Upstream request failed", heals 502/503/524 gateway
transients the same way it already healed 404+`upstream_error`, keeps 429 as a
rate limit, and no longer dies on a write-after-end during WebSocket refusal.
`sks update` now quarantines conflicting third-party harness markers and removes
SKS-owned retired skills from Cursor/Claude host skill directories. 9.1.0's
opt-in 1M context window is unchanged.

9.1.0 adds one opt-in feature and changes nothing by default: `sks codex-app context-1m status|on|off` plus a "Codex 1M Context" card in SKS Center Settings, managing the OpenAI-documented 1M-token context window for GPT-5.6 Sol. Enable writes `model_context_window = 1000000` and `model_auto_compact_token_limit = 900000` as top-level keys in `~/.codex/config.toml` — before any `[section]` header, the only placement Codex honors — each carrying an inline `# sks-codex-context-1m prev=...` marker that records the pre-enable value; disable restores that value or removes the key, and never deletes a value SKS did not write. Duplicate declarations and unparseable values fail closed, every write goes through the guarded CAS config writer, and Codex Desktop restarts automatically only when it is already running — SKS still never launches Codex on its own; when it is closed the change applies on the next launch. Both surfaces state the documented caveats: only new sessions pick up the change, requests beyond 272K input tokens bill the entire request at the long-context rate, and a non-Sol active model draws a warning because the keys are global and not model-aware.

9.0.6 restores the two repair paths a home directory broke in 9.0.2: the global-only doctor now runs the real bridge catalog repair (sync, read-back verify, retry, stale-runtime restart) and reports the post-repair snapshot instead of printing a remedy it never executes, and sks update from any directory writes its own home-rooted migration receipt so the update no longer fails after a successful install — with a new self-guarding catalog-repair migration stage and a named follow-up when the catalog cannot converge.

9.0.5 made align complete end to end on real workspaces: extractor caps sized before topology/evidence ever faced real inputs (162 gates, 880 proofs) blocked compile fail-closed; they are now sized from measurement with headroom, an over-wide glob is represented whole instead of failing the compile, two silent mid-expansion breaks now fail closed, and the evidence guard shares the snapshot lint's structural exemption instead of refusing an honest gate id. Field-verified: sks align run ok:true, exact coverage, freshness gate cleared.

9.0.4 fixed the two prior field failures. `sks align run` works again: 8.4.0
widened align to the topology and evidence extractors while the
exact-file-coverage invariant stayed keyed to the code inventory, and those
extractors minted `file` nodes for out-of-inventory paths (gate cache inputs,
cited `.codex/config.toml`/`AGENTS.md`) — 26 poison nodes on this repository,
every align since failing, and on 9.0.x that cascaded into a context search that
could never rebuild its index. File nodes now pass one inventory-membership
choke point per extractor family; the invariant was right and is untouched, and
the check moved left into the extractor and compiler suites. And the gateway's
self-described transients stop killing compact tasks: exactly the
`404 + type: upstream_error + no code` signature is corrected to
`503 + Retry-After`, so Codex retries instead of abandoning; a genuine
not-found carries a different type and passes untouched.

9.0.3 stopped the bridge from erasing what the gateway actually said. Upstream
error bodies are redacted because they can echo request content, but the
redaction replaced identifiers too, so every upstream failure reached users as
the same sentence — "Upstream request failed" — and the undiagnosable report was
manufactured by the bridge itself. Machine-shaped `error.type`/`error.code` now
survive into the response and the bridge log; free text still dies at the
bridge. The recurring "remote compact task 404 after a rate limit" was also
reproduced against the live gateway: follow-ups on the same
`previous_response_id` flip from 200 to persistent errors when routing shifts to
a node that does not hold the conversation — a gateway-side conversation-affinity
gap, now attributable per-failure from the bridge log.

9.0.2 added two doctor fixes, from a customer machine that looked
broken and was not. `sks doctor --fix` skips the deep Codex App measurements by
design, but the console rendered every skipped row as `degraded`/`missing`/
`optional_missing`/`unavailable` — a wall of red over checks that never ran; a
skipped source now renders `not measured (run: sks doctor --full)`, and a
measured failure still says so. And the home directory can no longer become a
project root: `~/.sneakoscope` is the product's own global state directory, so
discovery was treating most machines' home as a project the moment a command ran
outside a repo — global installs read as project-local, init-deep aimed at home,
the Menu Bar target read dirty every run, and Codex config gained a trusted
`[projects."~"]` entry. A marker directly in home is now skipped (the 8.6.6
`project_config_is_codex_home_noop` judgment extended to discovery itself), and
doctor from home runs the global-only repair with a pointer to the project.

9.0.1 was the 9.0.0 candidate plus three bridge fixes, shipped the same day the
field reported them. A quiet WebSocket is no longer executed by the bridge's own
idle timer — the "reconnecting" flash on healthy machines — with liveness handed
to TCP keepalive. A supervised bridge converges to the installed package on its
own (drain, exit, launchd relaunch) and `sks update` restarts a stale bridge
immediately, closing the class where every bridge fix stayed invisible until
someone ran `doctor --fix`: users kept reporting bugs that were already fixed,
and each report was true of their running process and false of their installed
package. And an upstream 4xx/5xx now leaves a bridge-side record (status,
provider, public model, path — never bodies), so a report holding only a cf-ray
id stops being undiagnosable. The 9.0.0 narrative below is otherwise unchanged;
the format break described there is what made 9.0.x a major.

9.0.x replaces the context-retrieval engine. `sks search --mode context` and the
subagent attention path now answer from a compiled binary index (SKSCG2, format
revision 2) instead of parsing a 63 MB JSON snapshot per query, and the major
bump is the format break: a revision-2 reader refuses a revision-1 index, so the
first context query after upgrading asks for one `sks align run
--rebuild-index`. Nothing is migrated because there is nothing to migrate — the
index is a generated cache with a deterministic rebuild.

The number that gates the cutover is recall, and it was held to. v2 must-include
recall is **0.481132 against v1's 0.460692** over 62 benchmark cases and real
engines, re-measured independently on clean builds with zero per-case drift, with
confidence violations at 3 against v1's 10 and zero determinism mismatches. The
gap was closed by feeding two inputs that were built, wired, tested, and never
fed — caller-supplied changed paths, and name anchoring gated by query shape —
not by tuning: no ranking threshold moved, and the predicted ceiling (0.4811)
was hit to four decimals.

The release's recurring defect class is named in the record and drove most of
its fixes: **work that silently does not happen behind an answer that reads as
complete.** Twelve instances of "built, wired, never fed" (a declared field no
production caller populates) and a family of silent caps (test selection
truncating alphabetically before filtering to runnable tests, then reporting
ok; recommendation lists cut in index-layout order; a freshness verdict of
`fresh` for an index that does not exist; telemetry counting a secret-token drop
that did not happen). Each fix carries a mutation-tested join-level test,
because unit tests structurally cannot see this class.

Also in this candidate: subagent worker processes detach into their own process
group and are torn down tree-wide (the zombie/RAM report), a pre-spawn sweep
reaps orphans first, a generation-depth guard stops subagents spawning
subagents, and the desktop bridge replays requests that died on a stale pooled
socket after a network transition instead of surfacing 502.

**Scope facts recorded rather than smoothed over:** the JSON snapshot file is
*not* deleted in 9.0.6 — two remaining readers (the byte-level lint rules and
the architecture-map baseline hash) are contract changes, not migrations, and
have their own cards. The v1 query engine is unreachable from production search
but still present. `requiredForPublish`/`alwaysOnRelease` protection arms are
predicate-verified and unreachable-by-construction; a green run is not evidence
they fire. The final integration audit (29 candidates, 6 survived adversarial
refutation) had all four of its blockers fixed in-tree before this bump.

The canonical suite is green end to end: 3,474 of 3,474, zero failures, zero
todo — against 2,929 at 8.7.0; the growth is CRK2 and the defect-class fixes.

Still to regenerate from the clean candidate commit before any release claim:
the full release gate DAG, the isolated 7.6.0 to 9.1.0 upgrade smoke, the macOS
Menu Bar proof, the pack receipt, and the release-check stamp. The affected-scope
DAG ran strict with zero blockers at every landing in this candidate, which is
preparation evidence, not exact-commit evidence. The upgrade smoke matters more
than usually this time: it is the run that witnesses the revision-1 → revision-2
index refusal and its `sks align run --rebuild-index` repair end to end.

> Supersedes the 8.7.0 readiness narrative. Historical evidence below remains for upgrade context.

# SKS 8.7.0 Release Readiness (historical)

## Current decision

**SOURCE TAG CONDITIONAL / NPM PUBLICATION OPERATOR-OWNED.**

8.7.0 makes `sks doctor --fix` able to clear a stale bridge catalog, and removes
Local LLM support in full. The minor bump is the removal: a published CLI
command, two dollar-command routes, and a release-gate resource class are gone.

Four independent defects compounded into the report users kept sending — a
`--fix` that runs clean and changes nothing. Each was sufficient on its own. The
provider catalog was treated as fresh for fifteen minutes with nothing behind it
to refresh it: the running bridge never reads `expires_at`, and only an explicit
`catalog.sync` rewrites the file, so doctor synced the catalog, verified it, went
green, and a quarter of an hour later reported the identical
`<provider>_catalog_stale` blocker. Freshness is now a named twelve-hour contract
that outlives a working session. The repair also addressed the wrong home: every
bridge path derives from `HOME`, but the repair passed the project root, so any
doctor run started inside a project found no managed bridge, concluded there was
nothing to do, and returned a green check over an untouched catalog. Doctor then
reported the bridge snapshot taken *before* the repair transaction, so a repair
that did succeed still printed `Desktop Bridge: blocked` listing the blockers it
had just cleared. And the phase could be skipped outright as "clean" — a catalog
lapses with the passage of time, which no input hash observes, so the marker
written while it was fresh made `--fix` skip the repair it was invoked for.

An inactive provider no longer holds the bridge unready. Readiness demoted an
unconfigured provider's problems to `inactive_provider:<id>:<problem>` warnings
and the combined-catalog aggregate promoted the same facts straight back, so one
report carried `warning: inactive_provider:openrouter:openrouter_credential_missing`
beside `blocker: openrouter_credential_missing`. Nothing routes to that provider
and no `--fix` can invent an API key.

Local LLM is removed: the `with-local-llm` command, the `$with-local-llm-on` and
`$with-local-llm-off` routes and skills, the Ollama and MLX worker backends, the
local control-plane adapter, the local worker capability card, the
`local-llm-real` release-gate resource class, and the machine-local model config.
Workers run on Codex official backends only. GPT Final survives with a narrower
trigger: it existed because local model output was draft material, and
worktree-derived candidate output still is, so the arbiter, its acceptance rule,
and the all-pipelines gate remain — the gate is now
`gpt-final:all-pipelines-required`, driven by a worktree candidate. The
local-collaboration policy, its four modes, and the "the arbiter must not itself
be local" check are removed with the backend that gave them meaning. An installed
package still proves it rejects both removed dollar commands: that proof was
derived from live routes, so deleting the route deleted the proof, and the two
commands are now pinned explicitly beside the other removed features.

The canonical suite is green end to end: 2929 of 2929, zero failures, against
2931 of 2931 at 8.6.6 — the difference is deleted local-LLM coverage.

Regenerated from the candidate commit: the release gate DAG, canonical tests, the
isolated 7.6.0 to 8.7.0 upgrade smoke, the macOS Menu Bar proof, the pack
receipt, and the release-check stamp. `inspectMainPushGuard` reports
`physical_proof_requirement_missing` and nothing else; that evidence requires a
GitHub-attested capture run and cannot be produced locally.

> Supersedes the 8.6.6 readiness narrative. Historical evidence below remains for upgrade context.

# SKS 8.6.6 Release Readiness (historical)

## Current decision

**SOURCE TAG CONDITIONAL / NPM PUBLICATION OPERATOR-OWNED.**

8.6.6 is a stability candidate on top of shipped 8.4.0, covering the Codex-LB
session pin and the Codex config surface that `sks doctor --fix` owns.

A Codex-LB session pin records the catalog and route-policy generations it was
minted under, and both resolvers refused any pin whose stamps had moved.
`policy_generation` digests the entire route map, so an unrelated model appearing
or a bridge restart regenerating the catalog aged every live pin at once —
threads that had never been pinned kept working, which is what made
`session_pin_route_unavailable` look intermittent. A pin now constrains the
request to its provider and upstream model rather than to its bookkeeping: when
the current route still names them the thread keeps them and is re-pinned against
the live generations, and the blocker is retained for a pin that really would
move the thread.

The config surface carried a self-perpetuating ownership failure. Ownership of a
project `.codex/config.toml` was proved only by an entry in the gitignored
`.sneakoscope/manifest.json`, and the entry was re-listed only when ownership
already held, so losing the manifest lost ownership permanently and every later
`doctor --fix` refused with `user_owned_file_without_sks_marker` — while
reporting `status: "blocked"` with an empty top-level `blockers` array. Managed
writes now stamp the ownership marker into the file, the managed config shape
proves its own provenance, and a blocked run names each condition behind the
verdict. Alongside it: `sks setup` no longer rewrites configs it has not proved
it owns, machine-local keys are no longer dropped between the project and home
configs when a guarded write is refused, the removed-feature-flag list no longer
deletes nine flags Codex 0.147 still reports as `stable` (which reverted user
opt-outs to `true`), and an explicit `multi_agent_v2 = false` survives the merge.
The removed-flag list is pinned against the vendored Codex binary by
`test/unit/codex-feature-flags.test.mjs`.

Multi-agent V2 utilization is corrected in two places: a write mission is no
longer clamped to two workers because its recommended roles end in `_reviewer`,
and stale `max_concurrent_threads_per_session` totals of 5, 6, and 7 are
refreshed rather than left pinned while the `[agents]` key migrated to 256.

Three verification surfaces that could not fail are now able to. The doctor
idempotence gate compared a `changed_files` field nothing in the pipeline ever
emitted, so it read every run as a clean no-op; phases now report the paths they
wrote, and the gate fails closed when the field is absent. The doctor postcheck
was a pure function over the transaction object and ran before two repairs that
write configs after the transaction closes; both now feed the verdict, and a new
`config_disk_verification` re-reads both Codex configs after every mutator. And
a mission no longer inherits an architecture-map requirement whose baseline the
seed had already declined to write — the discarded seed result was the only
reason four canonical tests could not pass.

This patch restores the official subagent lane. The Desktop Bridge treated a
request's `thread_id` and `session_id` as one identity, but a spawned agent runs
in its own thread inside the parent's session, so every subagent request was
rejected with `bridge_codex_session_identity_mismatch` and no subagent could
start at all. Only `thread_id` is used downstream — it keys the route and the
provider pin, and a per-thread pin is what allows subagents to run in parallel.
Alongside it, `wave_capacity` was pinned to the pre-decomposition `first_wave`,
so a parent that decomposed into more slices than it first requested was
throttled to the narrow wave and then told `subagent_wave_capacity_exceeded` for
opening the wider one; capacity is now recomputed against the live thread-slot
ledger when the target outgrows the plan, while deliberate wave staging and a
genuine slot shortage both still throttle.

A shipped bridge fix could not reach anyone. The Desktop Bridge is a long-lived
launchd service, so upgrading replaced the files on disk while the running
process kept executing its original code, and the bridge state recorded no
version for anything to notice. The serving process now records its version, the
service status reports a stale runtime, `doctor --fix` restarts it, and refused
requests are logged — secret-free and rate-limited — where previously the bridge
emitted one line in its whole lifetime and nothing on rejection. Running
`sks doctor` from the home directory also no longer lets the project-config
repair claim the host-owned global Codex config.

A publish could also fail only at the very end: preflight proved the package was built correctly but never that it could be uploaded, and npm reports an unauthorized upload as a 404 that reads like a missing package. The login is now verified before the tarball is built.

8.6.6 makes the Codex Responses WebSocket routable at all. An upgrade carries no
request body and no `x-sks-model` — that header is SKS's own and only its probes
send it — while the HTTP path reads the model from the JSON body, so the model
was always empty here and `model_routes['']` never resolved. Every WebSocket
upgrade through the bridge failed, unnoticed because Codex falls back to HTTP and
serves the turn anyway; the only visible trace was the reconnect banner at the
start of every conversation. A thread's session pin already holds that routing
decision, so a pinned thread now routes, and a thread nothing has bound yet is
refused as permanently unroutable rather than as a flaky upstream, letting the
client fall back at once. Refusals on this path also carry their real code and
reach the log, where every one of them used to be reported as an unavailable
upstream and recorded nowhere.

8.6.6 makes the bridge restart actually happen. `doctor --fix` handed the
restart the PROJECT root where it needed the home directory, so it looked for the
bridge inside the repository, concluded it was not running, and did nothing while
reporting the repair had run — measured on a real install, a bridge up for 29
hours on pre-8.6.2 code. The last unlogged bridge error path now records its
cause, and the image route no longer tells the operator to run the very command
whose output carries the blocker.

8.6.6 stops a bridge restart from cutting the requests it is carrying. Shutdown
destroyed every open socket immediately, so in-flight work died mid-request — the
client reporting `error sending request for url` or `stream disconnected before
completion` while the bridge recorded `bridge_client_disconnected`, each side
blaming the other. A configuration change restarts the service, so this fired in
ordinary operation and a long turn such as compaction lost the race most often.
The catalog repair also reads the catalog back instead of trusting the sync
command, and retries: the unification migration inside it was observed failing —
its rollback failing too — and then succeeding on the next attempt, on two
machines, which is what left users a stale catalog behind a green check.

With those corrected the canonical suite is green end to end: 2931 of 2931,
zero failures, where 8.5.0 stood at 2870 of 2874.

Regenerated from the candidate commit: the release gate DAG, canonical tests, the
isolated 7.6.0 to 8.6.6 upgrade smoke, the macOS Menu Bar proof, the pack
receipt, and the release-check stamp. `inspectMainPushGuard` reports
`physical_proof_requirement_missing` and nothing else; that evidence requires a
GitHub-attested capture run and cannot be produced locally.

> Supersedes the 8.4.0 and 8.3.3 readiness narratives. Historical evidence below remains for upgrade context.

# SKS 8.4.0 Release Readiness (historical)

> Superseded the 8.3.3 readiness narrative for the Architecture Map (AMG/ADR) release line. Historical 8.3.3 evidence below remains for upgrade context.

# SKS 8.3.3 Release Readiness (historical)

## Current decision

**SOURCE TAG CONDITIONAL / NPM PUBLICATION OPERATOR-OWNED.** The 8.3.3 source
candidate makes the Codex Desktop model surface correct and operator-curated on
top of the shipped 8.3.2 baseline: the combined catalog now preserves the
gateway's complete Codex ModelInfo row (restoring the reasoning selector and
Fast mode for Codex-LB models), OpenRouter exposure becomes an explicit
per-model selection applied from SKS Center or the CLI, `sks doctor --fix`
repairs a stale catalog instead of only naming the action and no longer strips
host-owned rows from the global Codex config, and SKS Center's Run Doctor
button runs the full diagnostic profile instead of the fast read-only path. A
source tag is authorized only after the exact candidate commit passes the
repository checks and matches `origin/main`.
Registry publication remains an explicit operator action outside that source-tag
decision.

Earlier SHA- or 8.3.2-bound artifacts are historical only. A version string,
focused test, package dry run, or old green stamp cannot authorize 8.3.3.

Evidence labels are intentionally narrow:

- **passed-hermetic** — current local source/build/test evidence only;
- **not-run-real** — no redacted target-bound live receipt exists for a gate
  that still requires one; and
- **blocked-external** — a clean promoted commit, private credential, target
  environment, or operator authority is required.

The current execution surface is `$sks-naruto` / `sks naruto run`, with
`$sks-work` as the explicit plan-execution route. `sks doctor --fix` remains
an operator-run repair command and must not be invoked automatically. Update
and Control Center views share the `sks.update-status.v3` snapshot.

## 8.3.3 candidate scope

- The combined bridge catalog preserves the gateway's native Codex ModelInfo
  rows. The gateway returns both a native `models` array and an
  OpenAI-compatible `data` array; ModelInfo now wins, object-shaped
  `supported_reasoning_levels` pass through unchanged, and neither the provider
  normalizer nor the canonical model builder reconstructs a reduced row. Codex
  Desktop regains its reasoning selector and Fast service tier for Codex-LB.
- Reasoning-capable OpenRouter models carry a reasoning ladder. OpenRouter
  never serves Codex ModelInfo, so those rows had an empty
  `supported_reasoning_levels` and Codex Desktop showed no reasoning control
  for them. Rows whose OpenRouter `supported_parameters` advertise `reasoning`
  now expose `low`/`medium`/`high`/`xhigh` with a `medium` default; rows
  without reasoning no longer advertise the reasoning summary parameter. The
  ladder is fixed rather than derived because the OpenRouter listing reports
  only that `reasoning` is accepted, never its granularity, and a live round
  trip through the desktop bridge is the evidence that every rung is honoured
  upstream.
- Codex picker exposure is operator-curated: every Codex-LB model is always
  exposed, OpenRouter models are opt-in through `sks bridge models
  list|select` and the SKS Center "Codex Picker Exposure" card, the first run
  seeds the OpenRouter model already configured, and selections for models the
  provider stops serving are pruned.
- `sks doctor --fix` gains a `desktop_bridge_catalog_repair` phase for
  `*_catalog_stale`, and its project-local forbidden-key pass no longer
  resolves onto the global Codex config (which had removed the SKS-managed
  `openai_base_url` row and the user's `notify` hook).
- SKS Center's Run Doctor runs `doctor --full --json`; the previous
  `doctor --json` selected the fast read-only profile and skipped every deep
  diagnostic.
- The strict Swift Desktop Bridge status decoder
  (`DesktopBridgeStatusV3Truth`) accepts the `sks.desktop-bridge-status.v3`
  object nested inside a command result, which never carries the command
  envelope trio. `ok`/`execution_ok`/`command_summary` are allowed and
  type-checked when present, never required; unknown top-level keys and
  mistyped envelope values still fail closed. The SKS Center Combined Model
  Catalog refresh succeeds again.
- Combined bridge catalog ordering places every codex-lb row before every
  openrouter row (`compareModels` remains a total order for unknown
  providers), and codex-lb rows default to Codex ModelInfo `priority` 100
  while an upstream-provided priority wins, so gateway models survive Codex
  Desktop picker truncation regardless of its tie-break direction.
- Regression tests pin the nested-status decode (compiled Swift truth
  harness), the provider ordering, and the priority defaults; the XCTest
  suite mirrors the same envelope assertions.
- The previous release's baseline remains in force: resident menu bar observer with
  `follow_codex_lifecycle`, completed `codex-lb` v1-to-v2 desktop-bridge
  migration, structured repair-receipt validation in SKS Center, full
  ModelInfo-superset catalog rows, the desktop bridge surviving real Codex
  0.147 traffic, and the Computer Use exclusion of the hosting Codex Desktop
  app (`com.openai.codex`).
- The active first-party Telegram command, transport, native poller and settings,
  feature/package surface, tests, and release requirements are absent. Historical
  changelog records and guarded retired-state migration code remain historical
  or upgrade-safety surfaces, not an active integration.
- `sks telegram` is an ordinary unknown command. Doctor and current feature
  inventories do not project Telegram readiness or credentials.
- The root `paseo.json` uses the ordered worktree setup commands
  `npm ci --ignore-scripts` and `npm run build:clean`, then exposes only the
  existing build, typecheck, test, affected-release, and confidence-release
  package scripts.
- README guidance recommends Paseo desktop first, documents the official
  headless and Codex launch flows, and keeps installation, authentication,
  pairing, relay operation, and product support with the independent Paseo
  project.
- Codex compatibility derives from the package dependency and the resolved
  runtime's generated App Server schema; MCP list pagination is bounded and
  fail-closed, and superseded static Codex schemas and hook fixtures are absent.
- Package, lockfile, plugin, runtime, Rust, README, changelog, performance, and
  agent bridge version surfaces name 8.3.3.

These are source claims. They become release claims only after the exact
candidate commit passes the repository's release flow.

## Pre-commit preparation checks

Run from the integrated working tree before creating the final candidate
commit. Retain the command output, but do not treat it as exact-commit release
proof:

```sh
jq -e . paseo.json
node -e "const p=require('./package.json'),c=require('./paseo.json'); for (const row of Object.values(c.scripts)) { const name=row.command.replace(/^npm run /,''); if (!p.scripts[name]) throw new Error('missing package script: '+name) }"
npm run build:clean
node --test --test-concurrency=1 \
  test/unit/removed-telegram-surface.test.mjs \
  dist/cli/__tests__/command-help-contract.test.js \
  test/unit/package-publish-lifecycle.test.mjs
npm run typecheck
npm run release:version-truth
npm run release:metadata
npm run changelog:check
npm run release:check:affected
npm run release:check:confidence
npm pack --dry-run --ignore-scripts --json
git diff --check
```

## Clean candidate handoff

After the user creates and pushes the exact candidate commit, repeat from a
clean checkout. Do not reuse generated proof from the dirty preparation tree:

```sh
git fetch origin main --tags
test "$(git branch --show-current)" = main
test -z "$(git status --porcelain)"
test "$(git rev-parse HEAD)" = "$(git rev-parse origin/main)"
npm ci --ignore-scripts
npm run release:check:full
npm run release:version-truth
node ./dist/scripts/release-check-stamp.js verify
node ./dist/scripts/release-pack-receipt.js verify
node ./dist/scripts/release-provenance-check.js --publish
npm whoami --registry https://registry.npmjs.org/
npm view sneakoscope maintainers --json --registry https://registry.npmjs.org/
npm view sneakoscope@10.1.2 version --json --registry https://registry.npmjs.org/
npm publish --dry-run --json \
  --registry https://registry.npmjs.org/ \
  --tag latest \
  --access public
```

Before publication, the version lookup should report that 8.3.3 is not already
present. The dry run is not publication. The user performs the actual publish,
push, tag, workflow dispatch, or approval separately.

## Removed-surface and Paseo contract

8.3.3 has no live Telegram credential, BotFather, pairing, poller, or cellular
round-trip evidence requirement. Release verification instead proves that the
active Telegram surface is absent and that the checked-in `paseo.json`, README,
package scripts, package metadata, Rust metadata, and runtime version agree with
the 8.3.3 contract.

Paseo installation, daemon health, authentication, pairing, relay availability,
and cross-device execution are also not Sneakoscope release evidence. Paseo is
an independent project; this release checks only the repository configuration
and documentation that Sneakoscope owns.

## TriWiki source binding

For a generated code pack, `git_head_sha` is the generation parent commit. A
later metadata-only code-pack commit may carry that pack only while the bound
parent remains an ancestor and intervening changes are confined to metadata.
The release flow starts from a clean worktree and refreshes the pack after
source changes. Source-change history, a non-ancestor pack, truncated history,
or an unverified Git read is a blocker rather than inferred freshness.

## Official Remote and SKS fleet control

The official Remote transport remains host-owned. SKS does not implement,
proxy, or reverse engineer that transport and never presents an SKS worker ID
as an official Remote session ID. The separate SKS SSH stdio worker is
proof-aware fleet control over an allowlisted typed channel; it is not a
replacement for official high-fidelity Remote coding.

## Release staging boundary

Only after current source-bound gates and required physical evidence exist may
an authorized operator create a registry staging record with
`npm stage publish`. A second explicit authorization uses
`npm stage approve <stage-id>`. Neither command is implied by this source
preparation, and no stage mutation is performed here.

Maintainer-side stage review resolves the pinned npm CLI as
`npx --yes npm@11.15.0`. Its verifier is read-only and must bind the exact
stage, workflow, physical run, local receipt, and tarball:

```sh
node ./dist/scripts/npm-stage-tarball-verifier.js \
  --stage-id <stage-id> \
  --dispatch-nonce <32-lowercase-hex> \
  --physical-evidence-run-id <physical-capture-workflow-run-id> \
  --workflow-run-id <stage-workflow-run-id> \
  --local-receipt /absolute/path/to/local-pack-receipt.json \
  --local-tarball /absolute/path/to/sneakoscope-8.3.3.tgz \
  --stage-receipt /absolute/path/to/npm-stage-receipt.json
```

The verifier does not approve, reject, publish, tag, or modify a stage.

The final migration matrix includes a `7.6.0 to 8.4.0 upgrade smoke`, covering
installed update finalization, guarded retired-state cleanup, preserved user
configuration, and the current command surface. Fixture success cannot replace
real macOS evidence required by other protected gates.
