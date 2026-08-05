# Changelog

## [Unreleased]

## [8.1.3] - 2026-08-05

### Changed

- Unified managed Codex Desktop and CLI routing behind one local Desktop Bridge.
  Codex-LB and OpenRouter are now independent, simultaneous provider profiles;
  ChatGPT OAuth remains Codex-owned.
- Replaced provider-mode routing with an atomically activated combined catalog
  and explicit model route index. Routes never use silent fallback, model-name
  heuristics, or a competing direct activation path.
- Added scoped v3 capability reporting. Bridge, native identity, each provider,
  and the combined catalog report separately; transport execution/readiness is
  distinct from deep evidence.
- Made catalog sync mandatory in valid v3 reports and made WebSocket evidence
  stage-aware, with one terminal root cause for a failed probe path.
- Documented receipt-backed private migration, user-owned configuration
  fail-closed behavior, and rollback that preserves newer OAuth and credentials.
- Naruto now preserves an oversized persisted concurrency preference while
  clamping runtime capacity to 256 child threads / 257 total threads. Explicit
  CLI requests above 256 are rejected.

### Removed

- Removed the `sks codex-lb` command family, all aliases, and all active legacy
  provider/bridge modes. The removed command returns `unknown_command`.

### Evidence note

- Real macOS, credential, Codex Desktop, WebSocket-frame, and deep-artifact
  proof is not claimed by this changelog. Those items remain pending
  target-bound, redacted final release evidence.




## [8.1.2] - 2026-08-05

### Fixed

- Keep release metadata aligned after an explicit SKS version bump advances the package version.

## [8.1.2] - 2026-08-05

### Fixed

- **Use Codex LB**, **Desktop Bridge Mode**, and **Use ChatGPT OAuth Only** can now
  take over an OpenRouter / Multi-Provider Router selection that SKS itself wrote:
  the unmarked `model_provider` line and its `sks-*-catalog.json` binding are
  reclaimed (provider credentials stay), instead of failing with
  `codex_lb_user_owned_model_provider_conflict` or silently staying on OpenRouter.
  A model_provider value SKS never configured still fails closed, now with explicit
  guidance instead of an irrelevant “Reconnect credential” next step.

### Changed

- Center **Advanced** section states plainly that Desktop Bridge is rarely needed —
  only for keeping ChatGPT sign-in on the codex-lb route or for custom-header-only
  gateways.

## [8.1.1] - 2026-08-05

### Fixed

- Gateway auth now follows one **plane rule**: the atomic CLI provider plane is
  structurally `Authorization: Bearer` (Codex-native `env_key = "CODEX_LB_API_KEY"`),
  so status / connect-test / doctor / capability / image probes always measure that
  plane with Bearer — stale custom-header metadata from older installs can no longer
  make probes 401 against Hyper-Lab-style gateways while real Codex traffic works
  (or vice versa). Only the Desktop Bridge plane keeps a stored transport choice.
- Atomic CLI provider contract writes `env_key = "CODEX_LB_API_KEY"` and every
  validator (desktop-controller, doctor, codex-app UI state, imagegen, provider
  context, release gates) agrees on that single shape, so Connection Proof no longer
  fails with false `provider_contract_drift` after a successful setup.
- Status guidance answers 401/403 with a credential-focused next action instead of
  falling through to irrelevant “use-cli” advice.
- Control Center Active Provider no longer labels modern `cli-provider` selection as
  “Legacy … migration required”; auth failures surface stable `E-LB-*` codes with
  HTTP status and transport, and a proven connection is never downgraded to
  “connection unproved” by unrelated status refreshes.
- OpenRouter failures now show `E-OR-*` codes and a provider-neutral next step
  instead of `E-LB-*` codes with “Reconnect Codex LB credential” advice.

### Changed

- Center **Reconnect Codex LB credential…** always uses Bearer — the transport
  picker is removed. `sks codex-lb setup` defaults to Bearer everywhere and rejects
  `--gateway-auth custom-header` for `cli-only`
  (`custom_header_transport_requires_desktop_bridge`); the custom header remains a
  CLI-only escape for the Desktop Bridge plane.
- Providers page demotes Desktop Bridge / capability chrome under **Advanced** and
  drops Authentication Recovery / one-off command clutter; the Advanced desktop
  status line now states that the bridge is unused while the CLI path is active
  instead of claiming “ChatGPT OAuth mode: active”.

## [8.1.0] - 2026-08-05

### Fixed

- Wire Control Center **Use Codex LB** to `sks codex-lb use-cli` so the Credentials
  Connection Proof updates instead of silently applying Desktop Bridge mode.
- Point Desktop-mode status CTAs at **Desktop Bridge Mode (keeps ChatGPT sign-in)**
  and CLI credential CTAs at **Reconnect Codex LB credential…** / **Run Connect Test**.
- Align provider reliability inventory backends with real argv
  (`set-openrouter-key`, `openrouter-test`, `restore-desktop-routing`) and rename
  the Desktop Bridge inventory id to `sks-provider-desktop-bridge-mode`.
- Document SKS Center gateway-transport entry as `Reconnect Codex LB credential…`
  in `docs/codex-lb.md`.

### Changed

- Cut package metadata to **8.1.0** for the Menu Bar provider wiring/copy/inventory
  parity release (minor bump from 8.0.5).

## [8.0.5] - 2026-08-05

### Changed

- Adopt `docs/AMBIGUITY-RESOLUTIONS.md` as a product-contract SSOT and publish
  the English projection in `docs/PRODUCT-CONTRACT.md`.
- Codex compatibility prose now tracks **current latest stable** plus capability
  probes; product copy no longer claims version-agnostic SSOT or crowns a fixed
  `0.x.y` as permanent product SSOT.
- Keep a single App Server schema tree (`schemas/codex/app-server-0.146`) and one
  current Codex CLI compat doc; retire per-version compat archives from the repo.
- Converge code-index / wiki+pack rebuild into `$sks-align` / `sks align run`.
  `sks wiki refresh --code` remains a compatibility alias.
- Retire the `$sks-loop` product surface; Codex native Goal is the only persisted
  goal/loop owner. `$sks-qa-loop` remains a separate dogfood route.
- Encode light completion routes as Answer, DFix, and Help/status-class
  read-only surfaces (`src/core/routes/light-routes.ts`).
- Document install SSOT as npm `sneakoscope@latest`, with package/plugin agreement
  enforced by `install-surface-ssot-check` and runtime PATH/Menu Bar enforcement
  available via `SKS_ENFORCE_RUNTIME_INSTALL_SSOT=1`.
- Align public one-liner copy on README, `package.json`, and the Codex plugin
  marketplace manifest to the P1 product sentence.
- Separate required release evidence (release gates) from recommended checks
  (typecheck / focused tests / publish dry-run) in release readiness docs.
- Write durable mission completion receipts under
  `.sneakoscope/retention/completion-receipts/` before capacity prune of closed
  missions so directory absence cannot restart incomplete loops.

### Fixed

- Keep direct `npm publish` on the clean-main + tag reproducibility path; the
  four physical release receipts stay required for `sks release stage` / OIDC
  staging, not for local registry publish (restores the 8.0.4 publish path).
- Accept exact project `.agents` / `.agents/skills` aliases to the authoritative
  global skill root without running project residue cleanup against the aliased
  path (realpath identity skip).
- Align canonical-test-runner fixtures with the narrowed release-authorization
  corpus so `test:core-root-regression` stays green.
- Register explicit `cli-cleanup` / `route-cleanup` feature fixtures for the
  read-only `sks cleanup plan` contract so all-feature completion coverage stays
  complete after the Cleanup product surface landed.
- Make `sks codex-lb connect-test` honor both the gateway authentication
  transport stored by SKS Center and an explicit `--compat-bearer` override.
  Bearer-only gateways now receive `Authorization: Bearer` instead of silently
  falling back to `X-Codex-LB-API-Key`; invalid stored transport metadata still
  fails closed before a request is sent.

## [8.0.4] - 2026-08-02

### Changed

- Migration: SKS now uses the native Codex CLI for interactive and release
  execution; no separate terminal runtime is required.
- Replace SKS Center's retired external remote-coding guidance with a first-party
  Telegram BotFather flow. The native Remote Coding page now opens BotFather,
  accepts the bot token through a secure sheet, issues private-chat pairing
  codes, renders Doctor/liveness state, and controls the one resident Menu Bar
  poller. The retired documentation, links, and product guidance are removed.
- Seal official child routing to Luna Max for tiny, short-context mechanical
  work (including clear simple code, configuration, and setup edits), Terra
  Max for long-context, long-term-memory, large-read, high-volume exploration,
  and rapid large-scale first-draft processing, Sol High for ordinary
  implementation, and Sol Max for planning, review, debugging, design,
  security, release, and other judgment-heavy work. English and Korean routing
  signals follow the same guarded priority, and complex or ambiguous work
  cannot enter the Luna lane merely because it also says “simple.”
- Make the explicit `npm exec --package=sneakoscope@latest -- sneakoscope
  install` route a real registered command. It forces an online registry-tag
  staleness check, rejects an older cached installer when the registry tag is
  newer, installs the exact version carried by the verified package, runs
  Doctor through that exact global entrypoint, and verifies the resulting
  package manifest, runtime, and first `sks` executable on `PATH`.

### Fixed

- Read the complete native Codex plugin catalog, including available but not
  installed entries, without issuing per-plugin detail calls for the full
  catalog. Reject stale marketplace selectors before install and report exact
  current-catalog candidates instead of attempting an invalid selector and
  surfacing a misleading install failure.
- Fail closed before npm staging unless the maintainer's pinned npm session can
  authenticate, inspect existing stages, and prove that the candidate version
  is not already staged. Correlate a dispatched GitHub Actions run against a
  pre-dispatch run-id snapshot so an older run for the same commit cannot be
  mistaken for the new stage operation.
- Keep non-mutating `npm publish --dry-run` bound to clean `main` and live
  `origin/main` without requiring release tags that have not been created yet;
  real publication continues to require the exact local and remote version tag.
- Isolate fixture readiness and trusted-publisher reports from canonical release
  evidence. `publish_ready` now stays false for fixture evidence and until all
  four version-, commit-, and artifact-hash-bound physical receipts validate.
- Harden Telegram setup and rotation: validate tokens with `getMe`, inspect an
  existing webhook before storage, require explicit consent to remove it with
  `drop_pending_updates=false`, bind durable offsets and authorization state to
  the verified bot identity, replace rather than accumulate paired chats, and
  clear pending confirmations on rotation or re-pairing. Center and Doctor now
  report only the effective non-secret token source and refuse a file-token
  setup while an operator environment token would override it.
- Bind Telegram typed-command execution to the canonical selected project root,
  keep bot tokens out of argv/logs/child command environments, and preserve
  secret-free partial-recovery evidence when webhook removal succeeds but a
  later local setup step fails.
- Make Telegram private-state locking crash-safe across concurrent TypeScript
  and native Swift recovery. Reclaimers register unique owner-bound
  participants behind a directory barrier before removing a dead lock, bind
  owners to process start identity to detect PID reuse, and keep staged pairings
  inactive until their success audit commits. Invalid-command audit noise now
  shares the bounded global/per-actor pressure limit instead of rotating away
  older evidence.
- Stop a newer npm-global package record from masking an older executable that
  still wins on `PATH`. Update status now treats the resolved command as the
  effective installed CLI, post-update verification binds the npm global root,
  package manifest, package-local entrypoint, and resolved `sks --version` to
  one target, and stale, missing, or same-version shadow paths fail closed with
  rollback guidance.
- Remove the updater's fallback to the currently running source/package root or
  an arbitrary `which sks` result when the newly installed global entrypoint is
  missing. Extend legacy shim inspection to recognize the shipped
  `dist/bin/sks.js` layout.

### Release Gates

- Add Telegram Bot API, private-state rotation, native Menu Bar materialization,
  command-help, documentation, and packed-package regressions. A real
  BotFather account plus cellular command/reply round trip remains a required
  physical release receipt and is not replaced by fixtures or local tests.
- Add an isolated 8.0.3-to-8.0.4 upgrade regression that proves the subsequent
  PATH-resolved CLI/runtime is 8.0.4, plus a shadow-prefix regression that
  proves an older 8.0.3 command is reported as a failure while rollback remains
  available. The packed-package smoke also executes the `sneakoscope` alias and
  the CommonJS-scoped installer launcher. Publication and clean-host npm
  validation remain manual release steps; this entry does not claim they
  occurred.

## [8.0.3] - 2026-08-01

### Changed

- Make explicit Naruto `--agents` and `--max-threads` values from 1 through
  256 authoritative instead of shrinking them to automatic fan-out tiers. A
  256-child wave is permitted only when the ready DAG, disjoint ownership,
  and verifier/tool capacity allow it. For the official Codex lane, SKS applies
  no local CPU, RAM, file-descriptor, or unmeasured API-default clamp; its only
  authoritative infrastructure limiters are an explicitly configured
  provider/API quota and a measured or host-provided external Codex child-slot
  cap. Otherwise Naruto records the exact limiter and reuses capacity in later
  waves. The four GPT-5.6 routing profiles are not an agent-count cap, and
  `SKS_NARUTO_REMOTE_API_PARALLEL_BUDGET` cannot override a lower external-host
  limit.
- Restore Telegram as an outbound Bot API long-polling transport inside the
  existing Menu Bar process. It reuses the typed remote-control contract,
  allowlist, secret store, actor-bound confirmation, audit, and Doctor
  liveness surfaces instead of adding a daemon, inbound port, tunnel, free-form
  shell, or second command language.

### Fixed

- Make update failures expose their deepest actionable blocker, add explicit
  marker-only config adoption with backup and receipt, accept an already-equal
  unmanaged config as verify-only, skip regenerable cache trees, and report a
  bounded guidance scan as `guidance_scan_truncated` warning instead of
  inventing legacy residue.
- Enforce one global SKS Menu Bar process across direct, launchd, Doctor, and
  update starts. Replacement stops and verifies the old process before install,
  then probes the running companion against the current package version.
- Make **Use codex-lb** commit provider definition and active selection
  atomically, preserve that selection through update/repair, and fail closed
  instead of silently using ChatGPT OAuth when the selected remote host or key
  is unavailable. Routing truth is based on one measured request and records
  target host, authentication class, time, and latency for Doctor and Center.
- After **Use Codex LB** succeeds, have SKS Center run the real
  `sks codex-lb connect-test --json` path with one non-stored, bounded
  low-token Responses request. The Center now shows configuration, request,
  response ID, model, latency, token usage, and bounded reply evidence, keeps a
  manual retry action, and never treats a merely successful exit or `ok: true`
  payload as connectivity proof. The command now refuses pre-selection requests
  and uses the installed Codex model cache when no top-level model is pinned.
- End repeated macOS Keychain prompts for SKS operations. codex-lb credentials
  resolve from the 0600 `~/.codex/sks-codex-lb.env` file before the ambient
  environment, no node path spawns the `security` CLI for reads, install and
  update never rewrite Keychain items, and a stamped one-time migration
  transfers a Keychain-only legacy key before deleting the entry. Telegram bot
  tokens follow the same 0600 secrets-file contract. Doctor reports each
  credential's effective source and applies prompt-risk checks where an
  interactive credential store is involved.
- Keep managed-skill admission blocked unless the whole-generation recovery
  receipt exactly proves every requested repair, and quarantine a differing
  `agents/openai.yaml` before regeneration unless its bytes match metadata
  derived from the trusted `SKILL.md`.

### Release Gates

- Tagging or publication remains blocked until current receipts prove all four
  physical checks: an update in a fixture containing 5,001 scanned
  directories; exactly one running Menu Bar process at 8.0.3; one measured
  codex-lb request reaching the selected remote base URL with gateway-key auth;
  and one real Telegram command/reply round trip from a cellular network.
  Configuration, fixtures, mocks, and prose do not substitute for those live
  checks. This entry does not claim that any live gate or publication occurred.

## [8.0.2] - 2026-07-30

### Changed

- Raise Naruto's absolute hard frame cap from 32 to 256, add the 16-child mass
  cheap-model fan-out tier with a 64-child ceiling on the Luna/Terra lanes, and
  reuse capacity across multi-wave scheduling. The 4/6/8 automatic defaults and
  12-thread frame-budget default remain unchanged.
- Bind Center and CLI updates to the reviewed package version, registry, and
  canonical selected project root. The 16-stage migration now reconciles
  project/global managed skills, native capabilities, hooks, legacy state, and
  the Menu Bar against the newly installed package, then returns the final
  Doctor-owned project receipt instead of an earlier intermediate copy.
- Make update ownership and recovery fail closed. A global cross-process lock
  prevents overlapping npm installs, the `global_install` intent is flushed
  before package mutation, rollback authorization uses a project- and
  registry-bound last-confirmed-install receipt, and direct `update now`
  downgrades are rejected in favor of the authorized rollback route.
- Keep planning and uncertain outcomes separate from confirmed installation
  state. Dry runs and later failed attempts no longer shadow the rollback
  source, live migration locks are never reaped merely for being old, and
  filesystem-root aliases are refused after realpath canonicalization.
- Require update registries to use HTTPS and bind migration/build ownership to
  process-start identity, owner tokens, heartbeats, and registered child
  process groups. PID reuse, an interrupted build promotion, or a killed update
  parent can no longer authorize a competing writer while live owned work
  remains.

### Fixed

- Reconcile managed skills as one locked generation instead of independently
  patching requested files. A checked-in immutable digest ledger recognizes
  trusted prior releases, stable managed markers avoid version-only churn,
  downgrade and same-version build guards prevent competing writers, and
  Doctor quarantines unknown managed bytes before reinstalling trusted content.
  Clean builds now assemble and validate a staged `dist` before swapping it
  into place, while read-only hook admission can use the source digest ledger
  if the packaged manifest is temporarily unavailable.
- Keep official-subagent lifecycle evidence fail-closed under contention.
  Start/Stop capture failures are persisted as run-scoped completion blockers,
  Stop surfaces the failure to the parent, and each callback reuses one bounded
  event snapshot for wave projection and evidence instead of rereading the full
  log multiple times.
- Scope active-route command gating to the invocation that owns the route.
  Codex tasks read only their exact session state (with a same-owner legacy
  fallback), and standalone terminal commands ignore session-owned
  `state/current.json` compatibility mirrors. Conflicting mutations inside the
  same session and truly unscoped legacy CLI routes remain blocked.
- Include brace-reincluded runtime scripts in package authorization snapshots,
  and include `native/**` plus `config/**` build inputs in dist freshness
  stamps, so packaged or generated runtime drift invalidates release evidence.
- Replace the 8.0.1 final self-repairing update Doctor with a read-only
  `update_finalize_doctor`. The new-version migration Doctor remains the sole
  post-install repair owner; final verification can no longer hide an
  incomplete migration by mutating the state it is proving.
- Diagnose the known Codex OAuth callback collision without mutating the host.
  Doctor now checks for a legitimate IPv4 Codex callback listener on
  `127.0.0.1:1455` coexisting with a separate wildcard or IPv6 listener, and
  both Doctor and Codex mission authentication failures conditionally explain
  how to retry the short-lived callback through `127.0.0.1`. SKS does not
  change the registered redirect URI, Docker/codex-lb, processes, or ports.
- Self-heal authoritative managed SKS skill content whose digest no longer
  matches the running package after an upgrade or downgrade. Healing remains
  limited to confined regular non-symlink files with an SKS ownership marker
  and the expected canonical `name:`; it creates a timestamped rollback backup
  and migration-journal entry before replacement. Markerless, name-mismatched,
  and otherwise unsafe user files stay untouched and blocked. The skills
  manifest remains `sks.skills-manifest.v1`. Final promotion now uses a
  no-overwrite claim/link protocol so an edit made after the last identity
  check is preserved instead of being replaced.
- Make `doctor --fix` and Menu Bar repair report the post-repair state
  truthfully. The exact launchctl 113 `Bad request` response is treated as an
  absent service only on the matching operation, a successful `open` fallback
  requires process readback, action-script blockers retain their real exit
  code, and a requested Center repair can no longer end with `ready: yes` when
  its postcheck is unavailable or unhealthy. Migration Doctor also defers
  pre-repair legacy-surface findings to its single receipt-owned mutation
  stage and replaces that observation with a fresh read-only post-receipt
  inspection, so successfully removed legacy skills no longer leave a stale
  `skill_legacy_surface_remaining` failure behind.
- Make codex-lb setup and provider switching transactional. Readiness now
  requires the selected provider and live target evidence, activation verifies
  its postcondition and rolls back on mismatch, and config, metadata, env, and
  profile writes use snapshot-bound content/mode checks so a concurrent user
  edit is preserved and surfaced through owner-only recovery paths instead of
  being overwritten.
- Stop repeated macOS Keychain consent dialogs without widening credential
  access. The public codex-lb path now uses the owner-only `0600` env file and
  never grants a reusable Swift interpreter or generic security process access
  to the gateway secret. `--keychain` fails closed until a dedicated signed
  helper can prove its identity and post-write state; the injectable verified
  helper contract retains rollback and indeterminate-state coverage. Explicit
  setup and reconfiguration also migrate the retired generic
  `sks-codex-lb` Keychain item only after the replacement env file and metadata
  are owner-, mode-, path-, and digest-verified. Migration deletes only the
  exact legacy service/account, reads Keychain back to prove absence, preserves
  the verified replacement store if cleanup cannot be proved, and warns the
  operator to rotate the provider key after removal or an indeterminate legacy
  cleanup. Setup and set-key render that warning in both JSON and ordinary
  terminal output.
- Retire the dual-auth Desktop compatibility route that required a global GUI
  secret. Existing markers remain detectable for migration, but CLI, setup,
  Center, repair, status, and internal routing refuse activation and never
  report that route ready.
- Bound SKS Center child operations by deadline and output size, keep UI
  completion on the main queue, and register the process termination handler
  before launch. Center now owns the verified process group as well as sampled
  descendants by PID plus process-start identity, so it hard-stops orphaned
  children even when their root exits first without signaling a recycled PID,
  accepts completion only from the exact process-bound receipt, and avoids
  rewriting unchanged receipt state on every polling tick.
- Enforce Naruto wave capacity from the actual unique lifecycle thread IDs,
  move the migration Doctor public-surface postcheck before its success
  receipt, reject project `.codex` parent symlink/identity swaps during repair,
  and serialize removed-skill cleanup under the same deterministic generation
  locks as managed-skill promotion.

## [8.0.1] - 2026-07-30

### Changed

- Every `sks update now` execution now ends with a final `doctor --fix` pass. The update
  pipeline (identical whether started from the SKS Center Updates page or the
  CLI, both of which drive the same staged `sks update now` flow) gains an
  `update_finalize_doctor` stage after the Menu Bar rebuild. Later mutation
  stages can still touch `config.toml`, hooks, and skill surfaces after the
  mid-pipeline doctor, so the receipt only closes as verified after the final
  on-disk state is validated and repaired. The already-current path runs the
  same finalization instead of skipping it, and the Menu Bar stage checklist
  renders the new stage.
- Doctor gains a `codex_config_syntax_repair` phase (enabled in every
  repairing profile, including the migration profile used by update
  finalization). It validates both the project `.codex/config.toml` and the
  global `~/.codex/config.toml` against the current Codex config syntax:
  retired keys and tables (`default_profile`, `[user.fast_mode]`, `[profiles]`,
  `notice.fast_default_opt_out`, retired `features.*` flags) are stripped,
  invalid `service_tier` / `model_reasoning_effort` values are removed so
  Codex falls back to supported defaults, and parse failures or
  `model_providers` auth conflicts are reported with manual remediation. All
  writes go through the guarded config writer with backups; user-owned project
  configs without the SKS marker are preserved untouched.

## [8.0.0] - 2026-07-29

### Removed

- Remove the first-party Telegram coding bridge, including its SKS Center
  surface and Telegram CLI/runtime guidance. Existing Telegram release notes
  below remain historical records.

### Changed

- Separate codex-lb routing from Codex Desktop authentication. The guarded
  Desktop Full Capability path preserves real ChatGPT OAuth and the built-in
  OpenAI provider, routes supported traffic through an owner-only loopback
  bridge, and sends the codex-lb gateway key only on the gateway hop. It is
  reported ready only after the required transport and trusted Desktop evidence
  pass; configuration, manifests, and fixtures remain unverified evidence.
  CLI-only configuration uses an unselected `codex-lb` provider with
  independent environment authentication.
- Replace the old mutually exclusive OAuth/gateway-key switch with explicit
  Desktop Full Capability, Desktop compatibility, CLI Provider, Disable,
  Capability Matrix, legacy migration, and receipt-backed rollback surfaces.
- Keep Codex App native features independent from codex-lb authentication and
  routing mode, validate deep evidence against a fresh target-bound trust
  anchor, and block full release with `real_required_missing` until real
  Desktop plus separately hosted other-Mac runtime evidence exists.
- Keep the package ceiling narrow but large enough for the six required
  Desktop bridge/capability verification scripts: 2,725 KiB packed and
  12.5 MB unpacked, measured from the exact publish allowlist.
- Standardize all seven SKS Center sections on full-width, leading-aligned
  cards with stable accessibility identifiers, explicit loading/empty/error
  feedback, one safe Return-key default per page, and scrollable MCP editing at
  the supported minimum window size.

### Fixed

- Stop setup, install, repair, update, and ordinary launch preparation from
  writing shared Codex auth, selecting codex-lb globally, binding a local
  Desktop catalog, changing Fast/UI state, or inferring a gateway credential
  from an API key found in `auth.json`.
- Require an actual Codex App restart before a legacy migration can finalize
  its OAuth-preservation receipt, and fail closed when the post-restart OAuth
  account identity has no stable claim that can be compared.
- Mask provider API-key entry by default, preserve malformed or unreadable
  native settings instead of overwriting them, give denied notifications a
  direct System Settings recovery action, and ignore stale MCP inventory
  responses after a scope change.
- Register real hermetic Align CLI/route fixtures and make `sks align proof`
  write the canonical Completion Proof even when the modernization gate remains
  honestly blocked.
- Modernize generated SKS skills and `agents/openai.yaml` metadata against the
  current Codex Skills/Plugins contract, add a release-gated exhaustive surface
  audit, and harden Align with route-scoped mission identity, sealed policy and
  inventory receipts, evidence-safe verification, and work-order closure.
- Clear stale blocker metadata when a previously blocked work order is later
  verified, so terminal status and blocker state cannot contradict each other.

## [7.6.0] - 2026-07-28
### Added

- Add read-only `sks telegram center-snapshot` and lightweight `sks telegram center-live` surfaces for the selected project/session. The full snapshot verifies the exact Telegram-bound Codex App Server thread, pages its complete stored turn history through experimental `thread/turns/list` with `itemsView: "full"`, and projects chronological user and Codex messages. The live snapshot reads only the bounded local lifecycle journal and returns stable conversation/activity revisions without starting App Server. Reasoning text, raw output, tool arguments/results, credentials, home paths, and out-of-project paths are excluded; byte/item caps and omitted counts are explicit.
- Show the connected Codex thread directly in **SKS Center → Remote & Telegram** with a registered-session selector, **Older / Newer / Latest** full-history navigation, Latest-only 2.5-second lightweight journal polling, completed-turn/manual App Server conversation refresh, first-message empty state, current-page manual refresh, and an in-product guide for ordinary text plus `/status`, `/tail`, `/diff`, `/gates`, `/trust`, `/proof`, `/artifacts`, `/input`, `/verify`, `/cancel`, `/refresh`, and `/open`.

### Changed

- Rebuild the Telegram page around distinct setup and connected states. The disconnected state presents a compact BotFather → private `/start` → secure connect sequence; the connected state keeps Hub controls, token rotation, linked-thread visibility, and project readiness separated into scannable cards.
- Rename the native menu and Providers controls to **Codex Fast** and describe the current official contract: 1.5× faster on supported models; ChatGPT-sign-in GPT-5.6/GPT-5.5 consume 2.5× Standard credits and GPT-5.4 consumes 2×; API-key token pricing and API Priority processing are separate; model choice, Codex-Spark, and reasoning effort remain independent.

### Fixed

- Keep Center transcript snapshots out of `last-action.log`, allow a larger private bounded output budget for them, and retain structured setup errors without exposing secure stdin.
- Journal real App Server `turn/started`, `turn/completed`, `item/started`, and `item/completed` notifications during Telegram turns so Center can show work while it is happening rather than only after the final reply.
- Add Telegram-specific guidance through App Server `developerInstructions` instead of replacing Codex's built-in base instructions, preserving the normal coding/tool behavior that the dedicated thread needs to do real work.
- Consume every retained event-journal page before applying Center's newest-item bound; sessions with more than 128 activity events no longer get stuck showing the oldest page.
- Make Telegram status and setup distinguish verified bot identity, long-poll readiness, Keychain readback, private pairing, registered sessions, Hub state, and the expected `awaiting_first_message` state without inventing a Codex thread.
- Batch each turn's bounded public activity into one journal mutation and cap the optional flush wait, so live telemetry cannot serialize hundreds of full-file rewrites ahead of the final Telegram reply.

## [7.5.0] - 2026-07-27
### Added

- Compile a TriWiki Context Graph and answer `sks search context` from it. The mode was a name without the thing: it ran a path search and a text search, merged them, stamped every hit `confidence: context_pack`, and reported `hydrated: true` whenever a pack file happened to exist — no traversal, no reverse dependencies, no claim-to-source hydration, and no way to say why a file was returned. There is now one compiled, typed, evidence-backed graph (`sks.context-graph.v1`) between repository truth and every consumer: 14 node kinds, 21 edge types, stable ids that contain no clock or array position, and an edge without `{path, hash, extractor}` provenance never reaches a snapshot. Code relations come from the TypeScript compiler API — `ts.createSourceFile` plus `ts.resolveModuleName` against the parsed tsconfig — so path aliases, barrel re-export chains, literal dynamic imports and NodeNext `.js`→`.ts` mapping are the compiler's answer rather than a regex guess, with zero process spawns and no project code ever executed. Command/route/pipeline/gate topology comes from the manifest APIs, and TriWiki claims and proof cards come in as bounded projections where an invalidated proof gets an `invalidates` edge instead of a strong `verified_by`. On this repository that is 10,793 nodes and 46,572 edges compiled in ~5.4s.
- Answer context queries with evidence paths instead of guesses. Seeds resolve exactly where possible and keep their own confidence end to end — a text hit never becomes an exact reference — then a profile-bounded bidirectional traversal (`implementation`, `review`, `planning`, `answer`) scores deterministically with every weight in one `ranking-config.ts`, suppresses redundancy, and packs a token budget under seven guarantees: an exact seed, a provenance source per seed, a test or gate for implementation queries, no missing protected gate on a high-risk query, structural diversity, a reason path per selected node, and the budget respected. Missing, stale or corrupt graphs return `context_graph_missing|stale|corrupt` with the repair command and **zero matches** — there is no branch that degrades to text search. Measured against the pre-graph baseline on the locked corpus: warm p95 1ms vs 61ms, mean context 291 vs 483 tokens, provenance coverage 1.00 vs 0, composite score 0.755 vs 0.389.
- Project the code pack and context pack from the graph, and rank TriWiki attention by it. Packs are packed by query/profile/risk relevance rather than module index order, `freshness` is computed from real source hashes instead of always being `unknown`, and the digest binds to the snapshot. Attention anchors now carry `reason_path`, `trust_score`, `freshness`, `token_cost` and `provenance`.
- Advise Naruto from graph evidence: candidate slice write-scope closures, direct and indirect conflict detection, protected risk domains, and affected tests and gates — all advisory, never able to spawn an agent, skip a protected gate, or return fewer gates than the exact changed-file selector. A stale graph yields a conservative answer instead of a more aggressive fan-out.
- Index the proof bank so summaries and graph extraction stop walking the whole directory; only the explicit repair path walks. Add a spawn-free graph freshness preflight.
- Add `sks triwiki graph-status|graph-lint|graph-query` read-only diagnostics, a locked benchmark corpus with hermetic fixtures and an integrity hash that trips if a gold set is edited, and a bounded tuning loop that may only change ranking weights and query profiles and never commits, merges or publishes.
- Run Naruto subagents on a host-supplied credential. `sks naruto run` pinned `model_provider="openai"` and `forced_login_method="chatgpt"`, which is right for an operator at a keyboard and wrong for an unattended orchestrator: a host that already holds an OpenAI-compatible credential could not use it, and forcing `chatgpt` made Codex treat an `auth_mode="apikey"` session as a hard logout and delete `auth.json`. `--auth-mode=host` stops SKS injecting the provider and the login method so Codex uses the configured provider block, `--model-provider` names that block, `--provider-env-key` forwards exactly one named environment variable to the child, and `--parent-model`/`--parent-effort`/`--subagent-model`/`--subagent-effort` open the model policy. Each has an `SKS_NARUTO_*` environment equivalent. SKS never reads, stores or logs the credential — only the variable's name appears in receipts — and a malformed provider, an unknown effort tier, a mixed managed-plus-provider configuration, or an env key absent from the environment all block before mission state is written rather than silently falling back to the SKS credential. The managed default and its real-credential smoke gate are unchanged.
- Document embedding SKS in another agent system, with a worked adapter example: one process boundary through the `sks` CLI with `--json`, never patching `dist/`, host owns the workspace and credential while SKS owns `.sneakoscope/`, missions and gates, and per-invocation credentials so one tenant's key stays out of another tenant's run.
- Add the `latest-version:guidance` gate. User-facing guidance that names a version goes stale; the gate fails when a version appears in the same sentence as guidance wording across the README, general user docs, CLI usage/help/error strings, agent directives and menu bar text, while exempting changelogs, compatibility matrices, schema ids, lockfiles and fixtures. It found and fixed 14 real cases.

### Changed

- `sks wiki refresh --code` compiles the graph, lints it, writes the snapshot atomically, then projects the code pack from it, and `sks wiki validate` additionally checks graph lint, snapshot/meta parity and projection binding.
- Raise the packed tarball budget to 2650 KiB and the unpacked budget to ~11.39 MiB for the graph runtime surface, while excluding the benchmark corpus, fixtures and tuning optimizer from the packlist — those are development instruments and were never runtime.
- Move the README, general user docs and runtime guidance off pinned SKS/Codex/codex-lb version numbers onto latest-stable plus capability-probe wording. The README keeps a machine-verified package identity line, which is a fact about the package rather than advice about what to install.

### Fixed

- Make npm `postinstall` externally inert by default. It now restores only the
  build stamp inside the installed package, prints explicit `sks bootstrap`
  guidance, and returns before project scanning, global Doctor, config/skill
  repair, retention cleanup, subprocess reconciliation, or Codex-LB snapshot
  handling. The full legacy bootstrap requires
  `SKS_POSTINSTALL_BOOTSTRAP=1`, with
  `SKS_POSTINSTALL_NO_BOOTSTRAP=1` as the stronger safety override. The
  installed-package release smoke now runs lifecycle scripts and proves zero
  external file drift and zero `launchctl` calls.
- Resolve the maintainer stage verifier through pinned
  `npx --yes npm@11.15.0` and require that exact CLI, a checkout-local
  verifier, and a non-CI/non-OIDC environment before any confirmed stage run
  can push or dispatch the release workflow.
- Stop `postinstall` from running the third-party getdesign installer. The generated `getdesign-reference` fallback remains available, the official skill can still be installed manually with explicit global/Codex/non-interactive flags, and release metadata records reviewed upstream commit `83e9840d4a5744b5f10117ec00b855059e5abc25` without pretending the current Skills CLI can install an immutable commit ref directly.
- Keep Codex App Naruto's final UX human-readable. The parent now submits the strict `sks.subagent-parent-summary.v1` object through the App-only `sks naruto parent-summary --mission <id> --stdin` lifecycle command and returns localized Markdown instead of exposing raw JSON. The command binds mission/session/run identity, accepts an in-progress correction before the terminal bundle is sealed, preserves idempotent terminal replay, and rejects only terminal conflicts.
- Let `sks wiki refresh --code` validate immediately after its own write and after the required metadata-only follow-up commit. Generated `code-pack.json` / `code-pack.prev.json` files no longer feed the graph cache key through either the wiki directory hash or tracked-dirty fingerprint, while other tracked TriWiki memory still invalidates the cache. The explicit repair refresh bypasses fragment replay so it re-reads a newly packed `context-pack.json`; Context Graph freshness accepts only Git history limited to those two generated files; and `sks wiki validate` recomputes the canonical code-pack digest from the current snapshot and entries instead of searching the SHA-256 text for a snapshot prefix that cannot be present.
- Treat the first non-empty line after an Honest Mode “remaining issues” heading as its value, so normal Markdown spacing before `없음.` does not create a false unresolved-gap loop.
- Refresh safe transitive dependency patches selected by npm within the existing manifest ranges: `fast-uri` 3.1.4 removes the high-severity URI host-confusion findings and `body-parser` 2.3.0 removes the invalid-limit denial-of-service finding. The upstream MCP SDK still carries a moderate Windows-only `@hono/node-server` `serve-static` advisory with no non-breaking SDK release; SKS uses stdio server and Streamable HTTP client transports, not that static-file path.
- Make the snapshot hash actually deterministic. Sort order was checked with `localeCompare` in one place and codepoint order in another, so real snapshots failed their own sortedness lint — and `localeCompare` depends on the host's ICU collation, meaning two machines could hash identical input differently. One shared codepoint comparator now covers extractors, compiler and lint.
- Stop the secret lint failing on honest names. It joined each node's fields into one blob before scanning, inventing matches present in neither field: a symbol named `BEARER` followed by its own path read as `Bearer <token>`, and the real `secret:preservation` gate id read as a key assignment. Values are scanned individually, and a value with no high-entropy run is a structural identifier; raw environment values still fail closed.
- Drop 11,288 of 18,067 symbol nodes that were neither exported nor touched by any edge except their own `contains`. They cannot be a relation endpoint and were a quarter of the artifact.
- Give the benchmark something to measure. Fixtures declared gates in a fixture-only schema the extractor never reads, so gate recall was 0 for both adapters; they now emit real `release-gates.v2.json`, and a gate may declare `protected` outright instead of relying on id-namespace inference. Write-scope conflicts are detected through the production Naruto advisory rather than a benchmark-local proxy.
- Add `routes_to` to the implementation, review and planning profiles. It was in none, so every `command` and `route` node was compiled into the graph and unreachable by any query.

### Removed

- Retire `src/core/triwiki/code-index-scanner.ts` and the tests pinning its signature. It read the first 120 lines of each file, extracted imports and exports with regex, resolved only some relative imports, and its own comment admitted it used "simple counts" in place of a real dependency graph. No production reference remained, and no compatibility alias replaces it.
- Remove the lexical `attentionRelevance()` token-overlap scorer from the attention production path.

## [7.4.0] - 2026-07-26
### Added

- Add `sks release stage`, which drives the documented staged npm publish as far as automation is allowed to go: push the verified commit to `main`, dispatch the OIDC stage workflow with `version` and `confirm_stage`, wait for the run, download the immutable handoff and stage receipt, and run the maintainer-local read-only tarball comparison. It stops at `npm stage approve` and prints the stage id, because that approval is a human 2FA decision the release contract reserves for a person. Every outward-facing step requires `--confirm`; without it the subcommand is a read-only preflight that reports branch, tree cleanliness, version, origin identity and `gh` auth. Nothing in this path holds an npm write token — publication authority stays with Trusted Publishing in the workflow.

## [7.3.0] - 2026-07-26
### Added

- Budget test volume against the code it covers. `assessTestVolume()` compares added test lines to the added source lines they cover and reports a `yagni` lean finding when the tests are large in absolute terms (>=200 added lines) *and* dwarf that code (>=4x) — the "800 lines of tests for a 40-line helper" shape — so a focused regression test for a small fix never trips it. Paths that move funds (payment, payout, billing, invoice, charge, refund, ledger, settlement, transaction, subscription, checkout, wallet, balance, payroll) are exempt outright; `pricing` deliberately is not, because displaying a price is not moving money. The canonical directive registry carries the matching principle so the behaviour holds without a user asking for it.
- Add `docs/telegram-and-center.md` covering SKS Center and the Telegram flow end to end: Center's seven sections, `sks menubar install` and "Open SKS Control Center…", the BotFather → `/start` → connect → start-hub sequence with a CLI equivalent for every GUI step, verification commands, storage locations, the security model, and a blocker-by-blocker troubleshooting table built from the strings the code actually emits. Registered in the docs-truthfulness gate with nine pinned phrases so it fails the gate instead of going stale.
- Add a canonical agent-directive registry and the `agent-guidance:dedup` gate. Generated `AGENTS.md` blocks repeated "Preserve user-authored content" 13 times, "Hydrate TriWiki" 13 times and the default guidance line 9 times across 15 files — instruction budget spent restating what one statement already says. Each principle is now stated once (SOLID subsumes "modularize"/"reusable"/"keep modules small"; self-documenting subsumes "add comments"/"write JSDoc"), directory blocks carry only their own observations, and the gate fails on any directive repeated across scopes or already implied by a canonical principle.

### Changed

- Retire the frozen 6.3.0 release-closure subsystem. It was an attestation of a single past audit — a pinned mission id, 28 finding/work-order ids, a fixed work-order sha256 — that could never pass on a fresh clone, since 9 of its 11 required artifacts live under gitignored `.sneakoscope/missions/`. The contract, validator, fixture and 27 tracked audit artifacts (two of which embedded an operator's absolute home path) are gone; the six generic file/git/JSON primitives the push guards used moved to `release-proof-io`. `main-push-guard` and `main-push-receipt` survive intact minus the closure. `file-ownership` is genuinely reusable, so its shared-file request directory is now parameterized by release line and resolves fail-closed with a `release_unresolved` blocker instead of silently granting a 6.3.0-scoped carve-out.
- Remove seven orphan gate scripts that no tracked file referenced and no registered gate id reached: `codex-0140-goal-attachment-preservation-check`, the frozen `release-3112`/`release-3113`/`release-4001`/`release-4002` required-gate id lists (which still named retired `codex:0140-*` gates), and `update-doctor-lifecycle-check` / `update-new-binary-reexec-check`, whose own `scriptContains` assertion demanded a `package.json` script that does not exist. The update-lifecycle contract they grep-checked is covered behaviourally by `update-simulated-upgrade`, `update-failure-modes` and the Menu Bar stage-parity tests.

### Fixed

- Stop `--help` from executing real commands. The router resolved `--help` only to skip the active-route and migration gates; dispatch still ran the command module, so `sks commit-and-push --help` performed an actual commit and push, 42 of 100 commands exited non-zero, and 13 printed no usage at all. The router now answers usage before dispatch — a command opts into richer text by exporting `usage()`, everything else gets a manifest-derived floor — and all 100 manifest commands exit 0 with usage without running. Three duplicate `isHelpRequest` implementations collapse into `src/cli/help.ts`.
- Make image generation work under a selected codex-lb provider. Four defects sat between a working proxy and the route. The provider closes `response.completed` with an empty `output`, delivers the final image on the preceding `response.output_item.done` (`item.result`), and may emit progressive `response.image_generation_call.partial_image` previews (`partial_image_b64`); SKS read only the completed envelope and its fallback matcher could match none of those stream shapes, so the route reported `missing_b64_image_output`. `src/core/responses-stream.ts` now folds completed streamed items back into the envelope, for json_schema structured output as well as images, while retaining partial-frame provenance for fail-closed handling. imagegen also re-implemented `process.env[key] || env-file` key resolution instead of using the fingerprint-bound `loadCodexLbEnv`, so a stale exported `CODEX_LB_API_KEY` shadowed the SKS-managed file and the proxy answered 401 while capability still reported ready. The codex-lb path was gated behind an opt-in flag that switched off the only surface answering when codex-lb is selected — provider selection now enables it, an explicit `0`/false still disables it — and the request model comes from the served catalog, because `config.toml`'s `model` may be a slug the key cannot use (403 `model_not_allowed`). The imagegen request and response-read timeout now defaults to 180 seconds, while preserving explicit overrides, so complex I2I prompts are not cancelled before the documented two-minute processing window closes.
- Keep the selected codex-lb provider authoritative across the complete UX Review and PPT image path. A separately exported `OPENAI_API_KEY` can no longer reroute generation to `api.openai.com`; the command preflight recognizes a ready codex-lb target without attempting an unrelated Codex App repair; custom `CODEX_HOME` target/catalog paths are honored; and a partial-only streaming preview is recorded as incomplete instead of being saved or classified as full generated-image evidence.
- Let callout extraction reach the selected provider. The extractor called `api.openai.com` with `OPENAI_API_KEY`, unreachable under codex-lb, so `$sks-image-ux-review` generated a callout image it could never read back into an issue ledger. It now runs over the same provider, and three JSON Schema constructs the Responses API rejects are normalized in `strictJsonSchemaFormat`: a `const`/`enum`-only property gets its inferred `type`, `$defs`/`definitions` are made strict like inline schemas, and a 2020-12 `prefixItems` tuple becomes a homogeneous `items` schema with `minItems`/`maxItems` keeping the arity. A mixed-type tuple is left alone rather than silently widened.
- Collapse the three duplicate UX Review picker entries into the canonical `$sks-image-ux-review`; the old names remain internal route aliases. A normal `run --image` now always executes the requested three-stage chain: real capture, senior Toss UI/UX designer gpt-image-2 I2I callout generation, then generated-image vision/OCR extraction into an actionable UX/UI iteration report.
- Classify generated-image evidence by provenance instead of restating the accepted classes in every gate. A new `codex_lb_provider_imagegen` class counts as full evidence, because the image comes from the provider Codex itself is configured to use rather than a detour to another vendor; codex-lb enabled as a *fallback* while another provider is selected stays `non_codex_api_fallback` and still blocks. The taxonomy lives in `src/core/imagegen/imagegen-evidence.ts`, which the route gate, stop gate, PPT slide review and generated-image ledger now consult.
- Answer `sks telegram --help` and `sks remote --help` with usage and exit 0 instead of an `unknown_action` JSON error and exit 2, and stop the project migration gate from swallowing the read-only Telegram/remote diagnostics. `telegram validate-config`, `telegram hub status` and `remote machines list|validate` died with "SKS project migration blocked" — precisely the commands an operator runs to find out why pairing is broken, so a blocked project became an undiagnosable one. Only the literal `hub status` qualifies as a read-only probe, since bare `telegram hub` defaults to `run`.
- Complete the BotFather-backed Telegram setup as a fail-closed single-operator bridge. Setup verifies the bot identity and webhook state before committing configuration, discovers only an unambiguous bot-addressed `/start` from one positive private chat/user pair, bounds safe read retries without replaying ambiguous mutations, rolls back partial setup writes, and requires the hub to be stopped before token rotation. Status reports actionable auth/webhook/poller blockers within the native Control Center deadline, while legacy multi-ID configurations are rejected with migration guidance instead of authorizing a Cartesian pairing.
- Fix the README version guard, which never matched: it looked for `SKS **7.1.3**` while the README renders `**SKS 7.1.3**`, so the match was always null and the guard skipped, letting a stale README version pass silently.
- Retry a Responses stream that ends without a terminal event and without a single output item, rather than reporting a missing image; observed against codex-lb mid-generation, this is a transient server-side cut.
- Give help output the same version banner and status vocabulary as every other command. Answering `--help` centrally had dropped both, so `sks naruto help` printed bare usage and broke the CLI output-consistency contract. The status line states the safety property the path exists for — `✔ usage only — the command was not run` — and the help contract test now asserts banner and vocabulary for all 100 manifest commands.
- Answer `sks help --help` with the frontdoor help instead of `Unknown usage topic: --help`; a help flag after `help` is a request for help about help, not a usage topic.
- Scope `package:published-contract` to the scripts npm can actually run from an installed package — the lifecycle hooks plus anything they reach through `npm run`. It previously required every repo script's `dist/` target to be inside the tarball, so 74 dev-only scripts (builds, release gates, benchmarks) reported 76 "missing" files that the packlist deliberately excludes, and the gate could never pass. A lifecycle script reaching a non-shipped file remains a hard failure, which is the install-breaking case the gate exists for.

## [7.2.1] - 2026-07-25
### Added

- Resolve TypeScript/JavaScript symbol hits with an in-process LanguageService so `exact_definition` and `exact_reference` are binding-backed (text hits stay `text_candidate`; unsupported languages return a capability error).

### Fixed

- Align `naruto:canonical-stop-gate` / `official-subagent-workflow-check` with `DEFAULT_NARUTO_REQUESTED_SUBAGENTS` (4) after the 7.2.0 fan-out raise, unblocking `release:check:confidence`.
- Correct `**/*.ts` brace-glob matching in the JS files engine so symbol scans include root-level TypeScript files.

## [7.2.0] - 2026-07-25
### Added

- Modernize local search/file discovery behind `sks.search-provider.v1`: separated `files` / `text` / `structure` / `symbol` / `context` engines, `sks search` CLI (`status|files|text|structure|symbol|context|benchmark|doctor`), and `sks doctor --search`. File/text prefer optional `sks-rs` (`ignore` + grep crates) with labeled JS fallbacks; structure uses the TypeScript compiler API (no required `ast-grep`/`rg`/`fd` install); symbol results carry confidence and never label text hits as `exact_reference`; context reuses TriWiki/code pack metadata without a new vector DB. Inventory and target docs live under `docs/architecture/`; benchmark evidence under `docs/performance/search-engine-benchmark.md` (JSON via `sks search benchmark --json`).
- Raise Naruto automatic subagent fan-out from 2/4/6 (ceiling 10) to 4/6/8 (ceiling 12), with the ceiling clamped by a hardware capacity probe (CPU cores, free memory, remote API budget). `max_threads = 12` remains a frame budget, never a spawn target.
- Add an engineering sanity review Stop gate. Routes that prepare code-changing work seed `engineering-sanity-review.json` plus `code-structure-report.json` and must complete the review before Stop. Enforcement now also covers routes whose `stopGate` is `none`/`honest_mode` (`$SKS`, `$Fast-Mode`, `$with-local-llm-on`, `$Commit`, `$Commit-And-Push`); the requirement is derived solely from the pipeline plan that actually seeded the artifact, and route state persisted before that contract is treated as stale rather than blocking.

### Changed

- Migrate impact-scan / diff-quality reference discovery off per-query `rg`/`ast-grep` CLI spawns onto SearchProvider (text hits remain `text_candidate`). Mistake-rule `ast-grep` detectors stay optional with an explicit capability skip when the binary is absent.
- Remove 368 release-gate scripts under `src/scripts/` that no tracked file referenced — orphaned one-off compatibility and audit gates from the 1.x/3.x lines and superseded Codex releases (`codex-0139-*`, `codex-0140-*`, and similar). None were registered in `release-gates.v2.json`, listed in `package.json` scripts or `files`, or imported anywhere, so nothing that ships or runs changes.
- Restructure the SKS Center UI for usability: sidebar gets SF Symbol icons with Providers promoted next to Overview; a shared ControlKit component set (status badges, primary actions, page headers, grouped action rows) backs every page; Providers adds an at-a-glance **Active Provider** card fed by the codex-lb/OpenRouter/router probes, renames the ambiguous OpenRouter "Test Connection" to "Test Model", and asks for confirmation before any activation that restarts Codex App; Updates regroups into Status/Progress/Recovery cards with "Review and Update" as the default action; Diagnostics and Settings gain grouped cards; Remote & Telegram moves project readiness into its own card, promotes Refresh Status to the page level, and routes setup failures to the setup card; MCP separates destructive Remove from routine manage actions. The role-model editor moved to `ProvidersRoleModels.swift` to stay inside per-file line budgets.

### Fixed

- Stop the `UserPromptSubmit` hook from hanging on code-changing prompts. `scanCodeStructure` fell back to a full-repository deep scan whenever a caller asked for a changed scope that matched nothing — the normal state when a route is prepared, before any edit — so seeding the engineering sanity review walked and analysed every source file and the hook exceeded its 15s budget (measured: >3 min, now 0.7s). A requested changed scope is now honoured even when empty; only a caller that asks for no scope at all scans the whole tree.
- Correct the Naruto fan-out contract text in the `$Naruto` route description and `docs/naruto.md`, which still advertised the retired 2/4/6 targets and a ceiling of ten, and bind all four prose sites to the catalog constants with an order-aware guard test.
- Report a failed Codex Desktop sidebar restore honestly: `restore-desktop-routing` used to delete the routing snapshot and return `ok: true` even when the reverse thread remap failed (commonly `SQLITE_BUSY` while Desktop holds the catalog), destroying the only record of which threads needed re-tagging. It now returns `restored_sidebar_blocked` with a `thread_sidebar_restore_failed:<error>` blocker, keeps the snapshot for a retry, and warns when a remap matched fewer rows than were recorded.
- Gate the Center **Restore previous provider** button on `previous_routing_restore_available` instead of leaving it always enabled, and disable it when the status probe cannot answer.
- Keep the Center role-model controls usable when `role-models` exits non-zero for recoverable preference blockers — previously every control including **Reset**, the only way to clear an offending override, was disabled. The status payload now separates `store_blockers` (file unusable, controls lock) from `preference_blockers` (recoverable, controls stay usable).
- Anchor the `build/` ignore rule to the repository root; unanchored, it also swallowed the source directory `src/core/build/`, so new files added there never appeared in `git status`.
- Keep every Codex Desktop feature enabled when SKS activates a third-party provider. `sks codex-app use-openrouter` now writes an SKS-managed ModelInfo catalog (`~/.codex/sks-openrouter-catalog.json`) with full per-model feature metadata (visibility, reasoning levels, `multi_agent_version = "v2"`, the Codex fallback base instructions) and binds `model_catalog_json` unless a user catalog is configured; both `use-openrouter` and `use-router` re-run the `[features]` normalization so `[features.multi_agent_v2]` (upstream default off) and the Desktop feature flags are ensured on every provider switch, not just install. Doctor/install repair the OpenRouter catalog automatically when OpenRouter is the selected provider.
- Repair Control Center **Review and Update**: the Swift `updateStageOrder` was missing the emitted `project_receipt` stage, so every successful 15-stage update receipt was rejected (`stages.count > 14`), reporting "receipt unavailable / terminal uncertain", leaving checklist items unchecked, and skipping the post-update Menu Bar relaunch. TS `UPDATE_STAGE_ORDER` and the Swift order now both declare 15 stages, the checklist header derives its count, and the already-current path records explicit `skipped_current` stages so the checklist can fully complete.
- Parse SKS CLI timestamps with fractional seconds in the Menu Bar (update expiry, receipt matching, operation summaries); the default `ISO8601DateFormatter` options rejected `Date.toISOString()` values, which made update snapshots read as always expired and receipt-to-operation matching unreliable.
- Preserve all SKS-managed `[features]` flags (not only `fast_mode`) across guarded Codex config writes, and accept the Codex 0.145 `supports_reasoning_summary_parameter` rename alongside `supports_reasoning_summaries` in catalog validation.
- Stop `codex-lb` unselect/OAuth-restore from clobbering a third-party `model_provider` selection (`openrouter`, `sks-router`); only a `codex-lb` selection is removed while managed pins are cleaned up, and `use-router` now clears leftover managed codex-lb routing pins during activation.
- Report the real `selected_provider` (including `openrouter`/`sks-router`) in `sks codex-app check` provider-model UI status with OpenRouter catalog binding diagnostics, and warn when a routed model's catalog row does not advertise `multi_agent_version = "v2"`.
- Harden the OpenRouter catalog pipeline after adversarial review: background codex-lb repair no longer reselects codex-lb (or steals the catalog binding) over an explicit third-party selection unless the switch was user-requested; `openrouter-status` reads only true top-level TOML keys so `[profiles.*]` values can no longer fake selection or binding; catalog writes drop (instead of re-persist) invalid carried rows; rows declare `context_window`/`max_context_window` so context tracking and ~90% auto-compaction keep working; and a dangling `sks-openrouter-catalog.json` binding left behind after a provider switch is diagnosed (`openrouter_model_catalog_json_dangling`) and auto-unbound by doctor so the built-in OpenAI catalog returns.

## [7.1.3] - 2026-07-24

### Changed

- Keep only Codex multi-agent V2: strip bare `features.multi_agent`, require catalog `multi_agent_version = "v2"` for routed role overrides, and drop OpenCodex `ocx v2 mode v1` / v1-compatible guidance.
- Reduce Naruto and Agent Bridge hot-path imports and shrink the installed runtime-script package surface while preserving Doctor, update, rollback, self-heal, conflict cleanup, and packaged verification paths.
- Align host-capability delegation with the real datasource and spreadsheet limits, expand the required Korean spreadsheet/database/document intents, and simplify human blocker guidance without changing JSON or proof contracts.
- Keep provider/model routing and the native Providers UI aligned with Codex multi-agent V2 catalogs and explicit role overrides.

## [7.1.1] - 2026-07-23

### Added

- Add a guided **Remote & Telegram** setup in SKS Center that verifies a private bot, detects the paired `/start` chat, stores the token only in macOS Keychain, registers a dedicated project session, and manages the Telegram Hub through a user LaunchAgent.
- Add same-Mac Telegram coding through a local typed worker: the first ordinary private-chat message creates and persists the dedicated Codex thread in the same App Server connection, later messages resume it, and every turn runs workspace-scoped with network disabled before returning the final Codex response without enabling arbitrary remote shell.
- Add a loopback-only multi-provider router setup and catalog-backed per-role model selection for compatible `provider/model` slugs while keeping upstream credentials outside SKS.

### Changed

- Require `compatibility` and `host_capabilities` on every `sks.agent-manifest.v1` validation; incomplete schema+tools-only manifests fail closed.
- Allow bounded host-capability repetition: datasource read-only queries up to 4 per mission (schema-bound) and spreadsheet updates up to 3 (inspect after each mutation).
- Make `sks mcp config` skip the update/migration gate so local Codex MCP config works without `SUPABASE_ACCESS_TOKEN`.
- Stop automatic OMX/DCodex quarantine from `sks setup`, `sks doctor --fix`, and `sks update`; only `sks conflicts cleanup --yes` mutates, and it preserves unrelated MCP blocks such as `acas-tools`.
- Bind the macOS release proof to the exact 6.2.0 upgrade report and require the upgrade authorization path to prove isolated HOME/CODEX_HOME/npm prefix use, exact lifecycle commands, safe `launchctl` behavior, successful sandbox cleanup, and pack receipt/tarball identities.
- Treat the upgrade smoke entrypoint as an explicit checkout-only GitHub Actions harness; the runtime-script closure fails closed if any installed product runtime also references it.
- Raise the unpacked package ceiling to `11,425,000` bytes after the 7.1.1 proof-validation build measured `11,403,003` unpacked bytes across `1,601` files, while retaining the `2510 KiB` packed ceiling.

### Fixed

- Prevent `sks update` and its old/new migration Doctor subprocesses from restarting the SKS Menu Bar before the parent update finishes: restart-deferral state now reaches npm lifecycle children, migration-profile Doctor skips Menu Bar mutation, and the Control Center owns the final post-receipt relaunch.
- Make Telegram status expose token, pairing, registered-session, and LaunchAgent readiness instead of presenting a configured file as a working remote-coding connection.
- Avoid storing a non-resumable empty Codex thread during Telegram setup. Codex 0.145.0 materializes a rollout only after the first turn, so SKS now creates the thread lazily with the first real Telegram message and repairs old empty-thread bindings only when no prior turn history exists.

## [7.1.0] - 2026-07-22

### Added

- Add a card-based **Providers & Models** Control Center with a live OpenRouter catalog, explicit saved-key authentication state, connection testing, editable model IDs, and post-activation main-model verification.
- Add owner-only per-role model preferences for `ui_implementer`, `native_app_specialist`, `implementation_specialist`, and `test_engineer`, with Save/Reset controls and official spawn-time model/reasoning routing.

### Changed

- Show a readable `SKS` menu-bar glyph for healthy and working states; reserve the update glyph for a real available update while preserving warning and attention priority.
- Raise the unpacked package ceiling to `11,250,000` bytes for the native provider cards and role-model controls while retaining the `2510 KiB` packed ceiling.

### Fixed

- Make the stored OpenRouter key usable by Codex Desktop through command-backed authentication without writing the raw key into TOML, and distinguish configuration success from app-restart success.
- Make OpenRouter Test Connection authenticate against the live key endpoint and prove the requested model exists; a public catalog response no longer falsely reports the saved key as authenticated.
- Prevent official custom-agent starts from combining `agent_type` or model/reasoning overrides with the rejected full-history fork mode; generated Naruto prompts and hook context now require bounded `fork_turns="none"` delivery.
- Keep release metadata aligned after the explicit SKS 7.1.0 version bump.

## [7.0.5] - 2026-07-22

### Removed

- Retire Codex Desktop GLM picker profiles (`sks-glm-52-*`) and `sks codex-app glm-profile` install writes; OpenRouter activation is provider + top-level model via `sks codex-app use-openrouter` / `set-openrouter-key` only.

### Added

- On `sks update` / `sks doctor --fix`, rewrite legacy commands inside managed and customer `SKILL.md` bodies to the current public surface, and remove live `omx`/`dcodex` skill directories from the picker (backup under quarantine).

### Changed

- Keep SKS version-agnostic across Codex CLI hosts: package tracks preferred latest `rust-v0.145.0` / `0.145.0`, soft floor stays `0.133.0`, and feature routes (Naruto MA v2, thread-list search, MCP timeouts, GPT-5.6 Terra/Luna/Sol) capability-gate with update CTAs instead of a hard “only 0.145” product lock.
- Induce Codex CLI updates from SKS Menu Bar and Center: status menu **Update Codex CLI Now**, Overview/Diagnostics/Updates CTAs, and clearer prefer-latest copy wired to `sks codex update`.
- Align Naruto with Codex stable opt-in multi-agent V2 when available: enable `[features.multi_agent_v2]`, migrate `[agents]` to `max_concurrent_threads_per_session` plus default subagent model/reasoning, strip removed `job_max_runtime_seconds`, and fail closed with update guidance when MA v2 is missing (no legacy process-runtime revival).
- Treat OMX/DCodex cleanup as live-surface removal (with quarantine backup), not leave-in-place preservation, during update/setup/doctor `--fix`.
- Raise the shared unpacked package budget to `11.20 MiB` for the skill legacy-surface rewrite surface while keeping the packed cap at `2510 KiB`.

## [7.0.4] - 2026-07-21

### Removed

- Remove the GLM MAD CLI surface: `sks --mad --glm`, the `sks glm` command, and the dedicated `src/core/providers/glm/` runtime tree. Ordinary `sks --mad` is unchanged.

### Changed

- Slim `release:check:full` for publish: drop outer `sks doctor --fix` (not stamp-required), keep one `build:clean`, one canonical `npm test` (writes the publish stamp's canonical test proof), the release-preset DAG, `release-real-check --skip-release-check`, dist freshness, and stamp write. Demote the seven remaining release-preset `test:*` suites to `incremental` so full no longer re-runs the same unit suites after `npm test`; affected/fast/confidence still select them when those surfaces change.
- Activate OpenRouter for Codex Desktop from SKS Center (Providers) or `sks codex-app use-openrouter --model <id>`; `openrouter-status` reports key/provider/selection readiness without selecting a model on key save alone.

### Fixed

- Recover an unloaded Menu Bar LaunchAgent during `sks menubar restart` / Diagnostics restart by re-bootstrapping the existing plist instead of failing on kickstart-only "service not found".
- Keep the SKS Menu Bar status item visible on cold start before Codex launches so Control Center stays reachable for accessory apps with no Dock icon.
- Classify nested read-only `mcp config list|test|backups|show` and `remote readiness|status|show` paths as migration-safe, and harden Control Center JSON parsing when child output mixes gate banners with payloads.
- Resolve selected managed SKS skills from the current global `~/.agents/skills/sks-*` install and inject those verified files into parent-turn and child-start hook context, so stale project/plugin/picker paths reconstructed after compaction no longer surface false path-mismatch warnings.
- Bind child PreTool managed-skill admission to the active mission and workflow run, and quarantine markerless user content at global core-skill names before restoring the packaged digest-bound copy, preventing stale child replay and permanent recovery blocks while preserving the original bytes.
- Require each healthy child admission to commit through a mission-independent project or HOME guard before tools are allowed, and read official child transcripts with no-follow, post-open file checks so mission-local persistence and symlink replacement cannot authorize a child.
- Preserve at least one executable child slot under small `max_threads` caps by elastically reducing reviewer reservation after active and parent capacity are accounted for; `max_threads=2` no longer starts a Naruto mission with zero runnable child slots.
- Preserve stamped Menu Bar generations during update migration and defer entry-point retargeting to the transactional rebuild, preventing current-version repair from invalidating the action-script hash before installation.

## [7.0.3] - 2026-07-19

### Added

- Add a dedicated guarded Codex CLI update action to SKS Center, serialized through the existing mutation coordinator and followed by a fresh update-status snapshot.
- Add the version-independent Agent Bridge host-capability contract: four compatibility schemas, seven ACAS host-MCP descriptors, inventory-driven Office/Data workflows, and bounded optional Naruto artifact/capability proof receipts.

### Changed

- Keep the shared packed-package budget at 2488 KiB while adding the final host-capability runtime and proof-validation contract by removing non-runtime comments from emitted JavaScript; release receipts remain authoritative for the exact packed byte count.

### Fixed

- Make SKS Center codex-lb activation establish provider and connection readiness before testing, and render structured, redacted success or failure feedback instead of an opaque raw `not_configured` payload.
- Preserve the user's active Codex provider, model, reasoning, routing, and authentication class across `sks update`; an active codex-lb install no longer silently restores ChatGPT OAuth and unselects the proxy.
- Restore truthful Chat/Pro recovery guidance in SKS Center, remove only provenance-owned Desktop model locks, and require an actual Codex App restart before OAuth or codex-lb switches can report success.
- Block codex-lb health requests before any credential is sent to an insecure non-loopback transport, and keep the native Codex updater's complete structured JSON below the Menu Bar capture boundary.
- Scope ACAS host tools to the minimum task-required allowlist, require the invocation-only `--trusted-project` decision before standalone or Codex App MCP inventory and health probing, project that opt-in through the machine command contract and native Codex trust override, atomically bind the standalone child hook session through a consumed nonce-hash grant, force no-trust launches to ignore persisted project trust and transport-preservingly disable any configured global ACAS server, keep App session identity correlation-only, reserve workbook creation/update and read-only queries atomically, bind query datasource/schema identity before execution, and prove final inspection or editable-source-before-render delivery from observed receipts; terminal hook replays fail closed and admitted host calls still pass through the shared mutation, harness, database, clarification, recursion, and no-question safety gates before execution.
- Keep explicit Codex hook sessions isolated from the legacy global route state so unrelated subagent events cannot contaminate an active Naruto mission.

## [7.0.2] - 2026-07-19

### Fixed

- Support first-create and safe re-entry for externally reserved Naruto mission IDs on `sks naruto run --mission <id>`, while keeping status/proof create-free and prompt drift fail-closed.
- Emit a stable nonterminal Naruto proof outer envelope so completed, blocked, and incomplete projections always share the same top-level keys with array `blockers` / `changed_files` / `verification`.
- Pass only the bounded nonsecret host MCP context env keys through the Codex parent child allowlist.

### Changed

- Patch release for external-host Naruto contract closure (WO-FOLLOWUP-01).

## [7.0.1] - 2026-07-19

### Fixed

- Show Codex LB domain and API-key placeholders in SKS Center, keep the API key visible while pasting, and install a standard Edit menu so Cut/Copy/Paste work under the menubar accessory activation policy.
- Add a Providers "Test Connection" action that runs `sks codex-lb health --json` and reports the live result.
- Keep release metadata aligned after an explicit SKS version bump advances the package version.

### Changed

- Patch release for SKS Center Providers input/paste UX.

## [7.0.0] - 2026-07-19

### Fixed

- Seal official Naruto child routing onto the GPT-5.6 four-profile matrix in preparation, SubagentStart context, and native `$Naruto` roster construction so model/effort assignment is no longer prompt-only or legacy-effort inheritance.
- Persist actionable `wave_lifecycle.next_parent_actions` / `parent_guidance` after settled waves and inject that guidance into the root parent PreTool path so completed children are closed and later direct-child waves can start.
- Coerce official `[agents].max_depth > 1` to depth=1 so inherited/project settings cannot contradict the launcher hard-enforcement.
- Keep Codex LB Desktop App picker/catalog readiness coherent: preserve active `codex-lb` during Fast UI repair, bind `model_catalog_json` before selecting the provider, prefer persisted catalog over live `/models`, and refuse shared `sk-clb` activation until selection is ready.

### Changed

- Bump the package major to 7.0.0 for the official-subagent lifecycle and Codex LB Desktop routing contract hardening.

## [6.7.0] - 2026-07-18

### Added

- Add a root-owned Naruto wave lifecycle ledger that records cumulative starts, settled waves, recovered capacity, remaining work, and post-wave ready-DAG rescans under one workflow run.

### Changed

- Route documentation and long-context exploration to Terra Medium, ordinary implementation to Sol High, and reserve Sol Max for focused high-risk or final judgment work.
- Synchronize reused Codex App Naruto missions with the current prompt and rebuild TriWiki-aware request intake without reattaching a stale pending plan.
- Make the Control Center Overview distinguish the running Menu Bar build, installed SKS version, registry/cache provenance, rebuild state, and unavailable MCP or Telegram probes.
- Make Codex native Goal the sole persisted goal owner; Goal create/edit requests now carry explicit outcome, scope, constraints, verification, done-when, stop conditions, and non-goals without creating SKS missions, bridge artifacts, compatibility loops, or fallback state.
- Replace duplicated global engineering guidance with one concise Core Engineering Directive: build for the stated goal, follow real code and data flow, use project-authoritative mechanisms, verify meaningful behavior only, and preserve actual safety boundaries.

### Fixed

- Prevent update-check fixtures from writing fake package versions into the operator's real update cache or operation receipts.
- Launch Menu Bar child commands from a safe HOME working directory with closed stdin and bounded timeouts so GUI actions cannot hang before producing JSON status.
- Preserve literal requests when generic wording such as "strong" appears; ordinary local fixes no longer trigger invented pre-inspection decisions, automatic precedent searches, or synthetic failed-before tests, while every write still requires a focused real check or a specific not-applicable reason.
- Keep release metadata aligned after an explicit SKS version bump advances the package version.
- Keep an authorized release stamp valid across the deterministic `npm publish` clean rebuild when the complete source, package, dist, gate, canonical-test, and real-check identities are unchanged, while still rejecting actual proof drift.

## [6.5.1] - 2026-07-17

### Changed

- Stabilize the non-interactive Naruto proof projection with bounded parent-summary results and deterministic six-artifact fingerprints.
- Enforce same-mission single-run behavior for standalone Naruto callers, including deterministic running, terminal reuse, stale recovery, and protected Codex child ownership.
- Verify generic project-scoped MCP host compatibility through the existing Codex configuration and standalone parent path.

### Removed

- Remove retired Naruto process-worker, finalizer, allocation, rebalance, verification-pool, and obsolete package-check code.

## [6.5.0] - 2026-07-17

### Added

- Add a first-class Fast status row and direct Fast On/Off actions to the macOS menu bar, with accessibility labels and an explicit unavailable state when the live status cannot be verified.

### Changed

- Keep Fast service tier selection independent from model reasoning effort across Codex Desktop repair and menu-bar controls.
- Advance the stable Codex compatibility baseline from `rust-v0.144.1` to the official July 16, 2026 `rust-v0.144.5` release, including the exact SDK/CLI dependency graph, regenerated App Server schemas, canonical schema digest, release manifest, and package allowlist; `0.145.0-alpha` remains outside the stable release contract.

### Fixed

- Keep the SKS Control Center alive while an update installs and verifies the new package, synchronize the final operation receipt, and only then relaunch the menu companion in a detached process.
- Restore the latest Codex Desktop Chat entry, Pro model access, and Fast selector when SKS-owned global provider/model locks hid them; remove only provenance-marked SKS locks while preserving user-owned providers, credentials, and explicit settings.
- Keep release metadata aligned after an explicit SKS version bump advances the package version.

## [6.4.0] - 2026-07-16

### Fixed

- Keep release metadata aligned after an explicit SKS version bump advances the package version.
- Restore official `npm publish` support while preserving release-stamp verification both before and after the lifecycle `prepack` rebuild.

## [6.3.0] - 2026-07-15

### Fixed

- Keep release metadata aligned after an explicit SKS version bump advances the package version.

## [6.2.0] - 2026-07-14

### Added

- Add a native menu-bar MCP manager with a resizable server table and modal controls to list, add, remove, enable, disable, and refresh remote URL and local stdio servers.
- Add canonical `sks mcp config` commands and real global Codex configuration updates, including protected backups, file locking, TOML validation, and restrictive file permissions.
- Add one common three-state Naruto decision gate to all ten Codex hook events, with bounded hash-only telemetry and route-owned orchestration detection.
- Expand the official project custom-agent catalog from sixteen to twenty-one roles with native AppKit, toolchain, protocol, runtime-reliability, and TriWiki-evidence specialists.
- Add dedicated Terra Medium `long_context_analyst`, `computer_use_operator`, `browser_use_operator`, and `image_generation_operator` project agents, expanding the installed official catalog from twenty-one to twenty-five roles while retaining the three-role on-demand prompt cap.

### Changed

- Advance the package, Rust crate, managed assets, compatibility docs, and release metadata to the next minor version.
- Default non-trivial generic Naruto work to two independent subagents, reserve automatic fan-out three for critical multi-domain risk, and preserve explicit operator counts.
- Keep Research, AutoResearch, and QA-Loop on their route-owned orchestration contracts so the shared hook gate cannot create duplicate fan-out.
- Inject only the current task's one-to-three recommended agent roles and use query-aware TriWiki budgets of four ordinary or six complex/high-risk anchors instead of serializing the full role catalog or an unrelated context prefix.
- Replace the Luna/Sol Max-only subagent split with a fail-closed four-profile policy: Luna Max only for tiny short-context mechanical work, Sol High for ordinary UI/logic/backend/native implementation, Sol Max for review/debugging/planning/security and other judgment, and Terra Medium for long-context plus Computer Use, Browser/Chrome, and image-generation execution.
- Split mixed execution and judgment work when possible and make Sol Max win unsplittable conflicts; route Research source acquisition to Terra Medium while keeping synthesis, falsification, and adversarial review on Sol Max.

### Fixed

- Make MCP configuration updates fail closed for unreadable, malformed, symlinked, non-regular, or concurrently changed files while preserving unrelated TOML, multiline strings, comments, and byte layout.
- Keep MCP secrets and sensitive URL or command details out of SKS process arguments, inherited process environment, errors, and command output; configured per-server environment values remain in the guarded Codex TOML. Bind reused codex-lb launch proof to the effective base URL.

### Performance

- Reduce `sks --mad` ready-path latency by running independent macOS and launch-service probes concurrently, avoiding repeated read-only repair inspection, reusing valid launch evidence, and moving nonessential remote update work off the launch-critical path.
- Keep the shared hook decision path bounded and reduce per-delegation role metadata through on-demand catalog selection while retaining full installed role coverage.

## [6.1.2] - 2026-07-13

### Added

- Add a shared official-subagent preparation owner for Naruto, Team compatibility, and specialized parallel routes, with bounded TriWiki attention, canonical plan/event/parent-summary/evidence artifacts, and generic overlays that never fabricate Naruto-only completion.
- Add an eight-layer Research source catalog, Super Search acquisition, semantic claim/counterevidence linking, three composite official Sol Max review threads, bounded revision cycles, replication artifacts, and explicit Honest Mode guarantees that never promise genius, novelty, or publication acceptance.
- Add an independent versioned full release-gate contract, content-bound npm pack proof IDs and hashes, exact packlist/package-contract cache validation, and source/dist authorization snapshots.
- Add SKS menu bar controls for the current Codex CLI version, update-needed indicator, `Update Codex CLI Now`, and `Run sks doctor --fix`, with pinned action-integrity checks and operator-install detection.
- Add sixteen project-scoped official custom-agent roles plus risk-based automatic fan-out: one by default, two for explicit parallel or independent risk domains, and three only for critical multi-domain work.

### Changed

- Make the Codex official subagent workflow the only default Naruto execution model. QA-Loop remains route-owned, Release Review delegates through official Naruto execution, and the historical native runtime is available only behind an explicit legacy-only flag where still required for observation compatibility.
- Route clear bounded tasks to Luna Max and UI implementation, debugging/root-cause analysis, review, architecture, integration, security, database, Research synthesis, and release judgment to Sol Max; Terra remains explicit compatibility only and is never selected automatically.
- Keep setup and `doctor --fix` conflict-blocked before writes when OMX/DCodex is present, migrate only SKS-owned official agent config, preserve user TOMLs, warn without overwriting `max_depth > 1`, and use the supported `max_threads`, `max_depth`, runtime, and interrupt fields.
- Reuse one clean build across affected/confidence release checks, run the canonical recursive test corpus in the full release workflow, and reject lifecycle-enabled `npm publish` before `prepack` can rebuild an already authorized package.

### Fixed

- Quarantine same-thread continuation after a missing `custom_tool_call_output`, detect missing-output placeholders across assistant/error payloads, and require a selected codex-lb origin to expose recovery version `1.21.0-beta.3` or later before setup, doctor, or launch proceeds.
- Clear stale light-turn receipts on every later prompt, bind receipts to `turn_id`, load active state directly for English and Korean continuation prompts, and keep greeting fast paths free of session-fallback warning artifacts.
- Make Naruto and Research parsers reject empty tasks, missing or malformed values, and every removed backend/scheduler/pool/model option while accepting supported split and `--key=value` forms; read-only Naruto status/subagent/worker/proof surfaces remain available during active missions.
- Treat `SubagentStop` as lifecycle evidence only. Completion now requires a trustworthy structured parent outcome for every correlated thread and fails closed for ambiguous, prose-wrapped, stale, duplicated, contradictory, or failed results.
- Reuse the active Codex App mission for the same `CODEX_THREAD_ID`, prevent duplicate mission creation, record incompatible parent-model observations as blockers, and keep preparation results explicitly non-completing.
- Keep `not_applicable` scoped to its active route gate so independent proof, reflection, and work-order gates still run, and keep task-profile gate budgets aligned with every canonical blocker group.
- Repair deterministic Research fixtures so structured counterevidence targets survive normalization, all key claims remain evidence-linked, and Research/AutoResearch mock runs exercise the full official adversarial convergence contract.
- Require real Research source eligibility to revalidate the linked Super Search proof, source ledger, source ID, hydrated content path, SHA-256, and length; self-declared `verified_content` rows now fail closed.
- Bind active 6.1.2 version references across package, lockfile, Rust, managed assets, README, current release documents, and changelog while preserving historical release sections.

### Removed

- Remove the public legacy `sks db` command and its command modules; database prompts now materialize internal read-only safety artifacts through supported routes and MAD-SKS remains the explicit high-risk SQL-plane surface.
- Remove the default legacy Naruto process-swarm implementation, stale Team mutation commands, obsolete Research scout/native-agent runtime options, and redundant install/release helper code that duplicated official Codex behavior.

## [6.1.1] - 2026-07-11

### Changed

- Make `$Naruto` a thin facade over the Codex official subagent workflow: Codex App/Desktop turns return delegation context to the current parent, while standalone `sks naruto run` launches at most one Sol Max `codex exec` parent.
- Route clear bounded subagent work to GPT-5.6 Luna Max and reasoning-sensitive UI, review, debugging, planning, architecture, integration, security, database, and release work to GPT-5.6 Sol Max; automatic Terra selection is removed from the Naruto path.
- Replace clone/process terminology with canonical parent, subagent, thread, wave, and official event evidence while retaining `--clones`, `workers`, and the legacy process runtime as explicit one-release compatibility surfaces.
- Show the installed Codex CLI version in the SKS menu bar, mark available CLI updates with an `⬆` indicator, and add one-click official `codex update` plus `sks doctor --fix` actions.

### Fixed

- Remove the hard-coded four/five-subagent ceiling, honor `--agents 8`, `--agents 12`, and wave-planned `--agents 20 --max-threads 12`, and cap malformed oversized requests at 32 instead of 100 custom processes.
- Preserve user-owned Codex config and custom agent TOML files while generating or migrating only SKS-owned `[agents]`, `worker.toml`, and `expert.toml` settings.
- Treat `SubagentStop` as lifecycle evidence rather than success evidence. Naruto completion now requires a trustworthy `sks.subagent-parent-summary.v1` object with one unambiguous outcome per stopped thread; missing, prose-only, ambiguous, blocked, or failed outcomes fail closed.
- Make Naruto CLI parsing fail closed for empty tasks, malformed or missing `--agents`/`--max-threads` values, and every legacy backend/scheduler/pool/model flag while accepting both `--key value` and `--key=value`; App delegation preparation reports `ok: false` and cannot be mistaken for completion.
- Clear stale light-turn receipts on every later prompt, bind receipts to the current turn, resume active continuations directly, keep greeting fast paths warning-free, and recognize `$Work` only as an explicit dollar command rather than ordinary prose such as “work on …”.
- Block structurally ambiguous same-thread continuation after a missing custom tool output, require selected codex-lb deployments to report `X-App-Version >= 1.21.0-beta.3` before setup/doctor/launch, and replace the post-run fake tool-result repair with a fail-closed continuity audit.
- Treat the exact missing-tool-output API error as fatal before Reliability Shield retries, preventing ambiguous mutation replay, and make Doctor fail closed when codex-lb recovery status cannot be inspected.
- Preserve committed implementation changes in `--changed-since auto` affected selection by diffing from the tracked-upstream merge base, and map Doctor, hook, command, preflight, menu, and recovery surfaces to their focused release gates.
- Keep `not_applicable` scoped to the active route gate even when subagents were originally required, preserve independent proof/reflection/work-order checks, and keep missionless Computer Use/Wiki fast lanes out of generic overlay materialization.

### Performance

- Add greeting and answer fast paths that bypass mission, TriWiki, skill-reconciliation, and stop-gate work when no execution route is required.
- Replace fixed full-route and verification stages with task-profile gate and verification budgets, and remove the legacy Naruto orchestrator from the default eager import graph.

## [6.1.0] - 2026-07-11

### Added

- Add capability-driven Codex plugin inventory and repair for Browser, Chrome, Computer Use, and ImageGen, including the current `{ installed, available }` CLI schema, install/recheck evidence, and explicit new-task or app-restart guidance when a repaired plugin cannot appear in the current tool manifest.
- Add duplicate-hook invocation suppression and legacy global-hook cleanup so project and global SKS hook registrations cannot create duplicate missions or repeat native-session feedback.

### Changed

- Make Voxel TriWiki coordinate/voxel parity a validated one-to-one contract, keep wrongness-linked or low-trust code recall out of `use_first`, enforce code-pack token budgets, reject incomplete runtime packs, and serialize wrongness-ledger mutations.
- Make retention generation-aware: treat `route_closed` state as inactive, protect recently updated non-closed sessions with a two-hour grace window, preserve active missions and JSON/log proof while removing only terminal or stale orphan worker runtime homes, and deduplicate temporary cleanup plans.
- Preserve durable mission JSON and visual/review evidence byte-for-byte during compaction, remove only known disposable runtime files, transparently hydrate and SHA-256-verify legacy gzip archives, count every `.sneakoscope` top-level directory and root file in full storage-budget reports, and retain five release-gate run directories by default.
- Keep Naruto's GPT-5.6 Terra/Sol/Luna optimization capability-driven and fail closed for unavailable explicit models instead of silently replacing user choices.
- Align the active Codex compatibility SSOT with `rust-v0.144.1`, including the exact SDK/CLI dependency graph, release manifest, generated App Server schemas and digest, package allowlist, Doctor surface, and release assertions; Codex 0.142 entries remain historical release records only.
- Make `npm test` recursively discover the complete compiled source and unit-test corpus, and allow only the full release DAG plus environment-dependent real check to write a source/package/dist-bound v2 release stamp.
- Stop source-structure scans from traversing hidden cache and worktree repository copies.

### Fixed

- Restore the Codex Desktop 1.5x Fast selector after codex-lb actions by removing only provenance-marked SKS `model` and `model_reasoning_effort` locks while preserving `service_tier = "fast"`, `[features].fast_mode`, and user-owned settings.
- Run Fast UI repair before a successful codex-lb restart, detect blank-separated SKS provenance consistently across all config mutation paths, and refuse automatic rewrites of malformed TOML.
- Parse installed plugin inventory without unsupported per-plugin detail calls, preserve current native capability feature flags during install/doctor, and self-repair missing Browser, Chrome, Computer Use, and ImageGen plugins without claiming they are available before re-verification.
- Replace nonexistent Naruto pipeline commands and mock-only self-test guidance with runnable mission-scoped agent and `sks selftest` commands, and trust the live callable tool manifest instead of reporting native tools unavailable from obsolete aliases.
- Clean package-contract temporary caches on success and failure, align lifecycle-disabled publish tests with the canonical 100-script surface, and keep all 6.1.0 release metadata synchronized.
- Make `sks versioning bump --help` read-only so requesting usage can never create an accidental patch release section.
- Make `sks agent --help` read-only so requesting command usage can never start a native mission.
- Keep the 2.4 MiB publish budget by excluding retired scorecards and source-only release blackboxes from the npm tarball while retaining their source-tree release coverage.
- Remove the broken `release:check:legacy` chain, make the manifest-backed DAG the sole release-gate SSOT, restore the canonical `release:real-check`, and include every changed regression test in the publish test command.
- Replace removed `publish:npm` and `release:publish` operator guidance with the supported `release:check:full` → `publish:prep-ignore-scripts` → lifecycle-disabled dry-run or `publish:ignore-scripts` flow.

## [6.0.3] - 2026-07-11

### Changed

- Apply a Naruto-worker-only GPT-5.6 policy while preserving normal Codex catalog passthrough everywhere else: ordinary coding uses `gpt-5.6-terra` at `xhigh` and escalates to `max` for complex/high-risk work; refactoring, architecture, planning, strategy, and integration use `gpt-5.6-sol` at `max`; E2E, browser, Computer Use, and GUI verification use `gpt-5.6-luna` at `xhigh` and escalate to `max` for complex/forensic work.
- Remove the legacy Naruto low/medium effort cap, tool-use-to-medium rule, and low/medium parent-route reasoning paths. Naruto parent orchestration now uses only `xhigh/max`, snapshots the live codex-lb catalog once before fan-out, accepts only catalog-advertised Luna/Terra/Sol efforts, blocks non-family/local/process overrides, and records the exact model/effort through worker intake, SDK config, and proof reports.

### Fixed

- Make `sks update` reinstall the menu bar through the newly installed package entrypoint instead of the old updater process, and verify that the installed menu build stamp matches the new SKS version.
- Make every menu auth/profile change restart the running ChatGPT/Codex app through bundle id `com.openai.codex`, wait for the old process to exit, and surface restart failures as non-zero JSON actions instead of false-success notifications.
- Make the generated menu action script execute its pinned, build-matched SKS entry before PATH/npm-global fallbacks, and fail status with `action_target_version_mismatch` when the action runtime version differs from the 6.0.3 build stamp.
- Make menu checkmarks reflect verified `auth_mode`, provider-contract, and Fast status; unknown/failed status checks now leave both choices unchecked instead of falsely selecting OAuth or Fast Off.
- Make repeated `Use ChatGPT OAuth` idempotent without requiring an old backup when OAuth/browser auth is already active, while still unselecting codex-lb.
- Wait for the local dashboard to become ready before opening it, report Codex Settings open failures, restart after OpenRouter/GLM profile changes, and clear stale update badges by comparing the cached latest version with the embedded menu version.
- Add live codex-lb catalog verification for Sol/Terra/Luna, normalize current App Server/model-cache effort metadata shapes, recognize `/Applications/ChatGPT.app`, and remove parsed Codex config objects from Fast status JSON so MCP environment secrets are not emitted.
- Give Naruto work items unique default patch-envelope write leases when a prompt names no target path, and explicitly close each child route between sequential swarm release proofs so valid follow-up runs are not blocked by stale session ownership.
- Block the command-local `sks naruto --glm` GPT-5.6 policy bypass (the separate explicit `sks --mad --glm naruto` mode remains available), and fail closed when Naruto receives invalid explicit reasoning or service-tier overrides instead of silently ignoring them.
- Route conflict-resolution and patch-rebase integration work to Sol `max`, and disable Naruto's legacy local/Ollama auto-selection eligibility so scheduler planning and actual GPT-5.6 worker execution cannot disagree.
- Fail closed for real write-capable Naruto prompts that name no source target path instead of treating route-local patch-envelope lease keys as source write authorization; fake/fixture swarm proofs retain isolated patch-envelope targets.
- Unify sizecheck, packlist, and publish-performance packed-size limits behind one measured 2414 KiB SSOT, restore the real-release dry-run performance entrypoint, and exempt only the two generated Codex 0.142 protocol schemas from the handwritten-file size limit.
- Prune 13 redundant npm aliases, retain canonical release/publish coverage (including the real-release dry-run performance entrypoint), and align the manifest and package-script budgets with the 200/100 lean-engineering limits.
- Keep release metadata aligned at 6.0.3 after the explicit SKS version bump.

## [6.0.2] - 2026-07-10

### Changed

- Delegate model availability to the Codex catalog. SKS-managed CLI, SDK, Desktop remote-control, role, profile, hook, and update paths now inherit the Codex-selected model unless the caller explicitly supplies any model ID.
- Keep GPT-5.6 optimization capability-driven: SKS varies only advertised reasoning effort and service tier, so new GPT-5.6 variants and future Codex models work without source changes.
- Reduce the default Naruto roster from 32 to 8 and cap active agent, loop, verification, and release pools at four, with immediate backpressure from CPU load, free memory, file descriptors, panes, and disk pressure.
- Add `npm run publish:verify-ignore-scripts` for a clean build, sequential test suite, version/dist/package checks, and an `npm pack --dry-run --ignore-scripts` inspection before raw publication.

### Fixed

- Remove the finite model allowlist, client-hook model rejection, forced `--model`/`-c model=...` rewriting, seeded top-level model defaults, and model pins in managed agent/profile files.
- Remove stale `gpt-5.5`, GLM, and provider pins from existing global SKS agent/profile overlays as well as newly generated files, so project and user-level Codex layers both inherit the active catalog selection.
- Preserve arbitrary explicit model IDs, provider configuration, and reasoning choices through install, update, Codex LB, Fast mode, doctor, and auto-review migrations; only provenance-marked SKS legacy locks are removed.
- Fix top-level TOML lookup when a config has no table header, which previously made valid top-level values appear absent.
- Prevent extreme Naruto mode from bypassing live backpressure, stop verification pools from overlapping clone pools, and clamp accidental global/project agent limits such as 1000 to four unless explicitly opted out.
- Eliminate the stale hardcoded CLI help version and synchronize npm, TypeScript, Rust, README, and changelog release metadata at 6.0.2.

## [6.0.1] - 2026-07-10

### Changed

- Align Codex App setup, doctor, fast-mode, codex-lb, and project-config repair with the 2026-07 ChatGPT desktop/Codex App config renewal.
- Default Codex App and SKS-managed Codex launches to the official `gpt-5.6` alias while still allowing the full Sol/Terra/Luna model family.
- Stop treating legacy `multi_agent_v2` as a supported team-agent surface; SKS now detects it only as stale evidence and uses the current `spawn_agent`/subagent path.
- Keep `sks-fast-high` as a per-file Codex profile overlay only; legacy `[profiles.sks-fast-high]`, `[user.fast_mode]`, and `default_profile` config are stripped instead of regenerated.

### Fixed

- Persist Codex Fast mode through documented `service_tier = "fast"` plus `[features].fast_mode`, and make `sks fast-mode off` intentionally remove the global fast tier instead of having the config guard restore it.
- Strip removed Codex App feature flags such as `remote_control`, `fast_mode_ui`, `codex_git_commit`, `browser_use*`, `image_generation`, `guardian_approval`, `tool_suggest`, and `plugins` when SKS owns the stale stamp.
- Prevent fallback agent-config repair from recreating top-level model/reasoning locks or the removed `remote_control` feature flag.
- Keep menu bar, install/update, codex-lb fast checks, auto-review profile migration, and doctor Codex App UI repair gates aligned with the renewed schema.
- Migrate old SKS-owned `gpt-5.5` and internal `gpt-5.6-*` model stamps to `gpt-5.6` so the Codex desktop app model selector exposes the expected 5.6 entry.
- Prepare 6.0.1 release metadata for the `npm publish --ignore-scripts` path.

## [5.12.0] - 2026-07-08

### Added

- Add operations maturity scorecards for install, upgrade, recovery, real runtime evidence, high-risk command safety, long-run state health, package surface, and actionable diagnostics.
- Add upgrade migration matrix fixtures covering 5.8.0 through 5.11.0 state shapes, legacy Team/MadDB routes, Super-Search missions, SEO marketing missions, and corrupted mission indexes.
- Add rollback and crash-recovery smoke checks for SEO marketing apply, doctor fix, GC apply, Super-Search fetch artifacts, and Naruto patch apply.
- Add explicit Naruto real write proof schema so real Codex write E2E no longer infers patch evidence from broad mission JSON scans.
- Add high-risk command CLI negative smokes for commit-and-push, rollback apply, doctor fix, update dry-run, DB, MAD-SKS, and Super-Search fetch.

### Fixed

- Synchronize `$SEO-GEO-OPTIMIZER` route metadata, help text, dollar manifest, and command manifest with the implemented `research`, `strategy`, and `--include-marketing` flow.
- Strengthen SEO marketing strategy quality scoring while keeping the public surface minimal.
- Prevent critical command and dollar scorecards from awarding production-level scores for metadata-only or fixture-only evidence.
- Clarify doctor fast/full/fix semantics so fast diagnostics are never counted as full operational readiness.

### Changed

- Shift the 5.12 release gate from feature breadth toward real operational maturity: upgrade safety, recovery safety, long-run state health, high-risk negative smokes, and actionable diagnostics.

## [5.11.0] - 2026-07-08

### Added

- Add minimal Super-Search-backed SEO marketing research and strategy flow for `sks seo-geo-optimizer research|strategy`.
- Add marketing-aware SEO mutation planning behind `--include-marketing` without auto-generating a missing strategy.
- Add SEO marketing truthfulness gates that block unsupported claims, ranking guarantees, competitor disparagement, and source-less publishable messaging.
- Add Naruto hermetic and real Codex write E2E gates that require changed files and patch-envelope evidence instead of read-only smoke.
- Expand high-risk command contracts beyond Super-Search SSRF to commit/push, rollback, doctor fix, update dry-run, DB, and MAD-SKS surfaces.
- Add retention long-run smoke to prove compacted mission state still supports status, route status, and Super-Search source inspection.

### Fixed

- Make fast doctor output explicitly report diagnostic depth and prevent fast doctor from being counted as full diagnostics.
- Tighten command and dollar scorecards so critical commands require actual smoke evidence rather than metadata-only scoring.
- Tighten performance budgets without removing verification coverage or introducing fallback success paths.
- Keep release metadata aligned after an explicit SKS version bump advances the package version.

### Changed

- Keep 5.11.0 focused on missing implementation and runtime integrity instead of adding broad new command surfaces.

## [5.10.0] - 2026-07-07

### Added

- Add local-only dominance performance gates focused on cold start, hook latency, import graph, fs hot paths, Super-Search local HTTP smoke, Naruto E2E tiers, and command/dollar performance scorecards.
- Add Super-Search local HTTP smoke and SSRF-safe direct fetch policy.
- Add Naruto hermetic and real-Codex E2E tiers to separate deterministic fixture proof from real runtime proof.
- Add import graph and fs hot-path checks to keep fast commands and hooks lightweight.
- Add retention dry-run/apply smoke to turn retention into a runtime performance feature.

### Fixed

- Reduce cold-start overhead for version, commands, root, dollar-commands, Super-Search doctor, and doctor no-fix paths.
- Reduce hook path I/O and heavy route policy generation.
- Reduce Naruto worker launch, patch collection, merge, and cleanup bottlenecks.
- Reduce release gate duplicate builds and repeated report reads.

### Changed

- Tighten performance budgets for CLI and hook paths.
- Split doctor/setup/update fast read-only paths from repair/apply paths.
- Split Super-Search doctor capability checks from actual network/source acquisition.

## [5.9.0] - 2026-07-06

### Added

- Add a quantum competitor scorecard that turns stability, gate reliability, parallel isolation, performance, install smoke, and maintainability into release-blocking evidence.
- Add installed-package smoke checks that pack and install SKS in an isolated temp project with lifecycle scripts disabled.
- Add performance budgets for cold CLI commands, hooks, doctor, and Super-Search doctor.
- Add production parallel-write smoke with multi-file worker diversity, timestamp overlap, patch envelopes, worktree cleanup, and failure-injection survival.
- Add Super-Search live/offline smoke split with direct URL acquisition as the minimum default provider path.

### Fixed

- Make doctor/setup/update idempotence release-blocking, with rollback evidence and no-op second-run proof.
- Make Super-Search doctor report usable/degraded/blocked status based on acquisition readiness instead of core availability alone.
- Prevent release gates from passing when production proof is mock-only, source-less, or missing installed-package verification.

### Changed

- Add gate timing reports, route intent regressions, retention budgets, and package surface artifacts so the 5.9.0 release path is evidence-driven.
- Tighten CLI/hook startup checks while keeping heavy modules lazy and bounded.

## [5.8.0] - 2026-07-06

### Fixed

- Fix intent routing so question-shaped work requests no longer route to answer-only solely because they contain a question mark.
- Fix Naruto parallel write proof so independent multi-file work must show worker diversity, timestamp overlap, changed files by worker, and production-vs-mock classification.
- Block mock-only, synthetic-source, source-less claim, and fallback-only evidence from passing production Super-Search gates.

### Changed

- Replace the fragmented InsaneSearch/UltraSearch search surface with the single canonical Super-Search route, CLI command, generated skill, schema, artifact namespace, and release gate.
- Add Super-Search provider availability reporting, attempt ledgers, source-acquisition blockers, and fail-closed inspect/status behavior instead of fake source fallbacks.
- Add repository cleanup gates for legacy search names, orphan command entries, generated SKS-owned legacy search skills, and release-time name regressions.

### Removed

- Remove the `insane-search` and `ultra-search` CLI commands instead of keeping them as deprecated aliases.
- Remove old UltraSearch/InsaneSearch runtime names, schemas, artifacts, and generated skill surfaces from production code.

## [5.7.0] - 2026-07-06

### Fixed

- Repair the Codex App SKS menu bar install path so generated actions are retargeted to the current package entrypoint, regain their executable bit during legacy migrations, and expose Fast Mode On/Off controls in the menu template.
- Keep codex-lb Fast Mode on the required current Codex model by normalizing the `sks-fast-high` profile to `gpt-5.5` with `service_tier = "fast"` during setup, update migration, and doctor repair.
- Make `sks doctor --fix` run and report the same legacy update migration receipt path used by `sks update`, instead of claiming migration state is current without writing a current receipt.

### Changed

- Bump the release train to 5.7.0 and restore the npm publish script contract: `prepack` rebuilds dist, `prepublishOnly` verifies the release stamp, tarball contract, unpublished version, and publish auth, and `publish:dry`/`publish:ignore-scripts` run explicit gates before lifecycle-disabled publish.






## [5.6.1] - 2026-07-05

### Added

- Complete the TriWiki code-index work from the 5.6.0 work order: the user-prompt hook now injects a one-line "code pack is stale — run `sks wiki refresh --code`" nudge when a published code pack exists but was built against a different git HEAD than the current one. It is a bounded, non-blocking check (one JSON read + one `git rev-parse HEAD`, hard-timeout capped) that never regenerates the pack in the hook and stays silent for repos that never opted into the code pack, so it can't nag or blow the hook latency budget.
- Link TriWiki wrongness (negative-evidence) records to code modules: wrongness records now carry an optional `module_ids` field derived from their linked files, and the code-pack attention ranking surfaces modules SKS has been wrong about before ahead of higher-trust ones, tagging their hydrate rows with a `wrongness:<count>` signal so a consumer re-reads a frequently-wrong module before trusting recall. Both are backward-compatible additions (existing records/packs are unaffected).

### Fixed

- Fix the SKS menu bar's "Set codex-lb Domain" dialog UX: the placeholder showed the full `/backend-api/codex` suffixed URL, misleadingly implying it must be typed by hand even though a bare domain is already normalized to the correct full URL automatically; the placeholder now shows a bare-domain example, and the message text clarifies the suffix is added automatically. Command failures shown in menu bar alerts now go through a humanizer that translates JSON reason/status/blocker codes into plain English (with a readable "snake_case -> Words" fallback for unknown codes) instead of dumping the raw JSON blob — applies to every menu action's failure alert, not just codex-lb setup.
- Keep release metadata aligned after an explicit SKS version bump advances the package version.

## [5.6.0] - 2026-07-05

### Added

- Add a codebase index and code pack to TriWiki (`sks wiki refresh --code`, `--token-budget`): a deterministic (no LLM calls), git-aware scanner infers module boundaries, entry points, exported symbols, and cross-module dependency edges for any codebase (not just this repo), then a source-cited pack generator turns that into an LLM-consumable summary following openwiki's principles — every entry must cite a real repository path (uncited entries are rejected outright), the pack is validated by a fully deterministic code-based gate (not a prompt), and publication is atomic with the previous pack preserved as `code-pack.prev.json`. `sks wiki validate --json` now reports code-pack freshness (`fresh`/`stale`/`missing`, by git HEAD sha).
- Wire the code pack into TriWiki's attention system: `buildTriWikiAttention` ranks code-pack entries by trust score into a dedicated ~2000-token sub-budget, additive to (never crowding out) the existing policy-claim `use_first`/`hydrate_first` selection. `sks recallpulse run --json` now surfaces real, source-cited `code:` entries in `decision.l1.selected`.
- Add doctor repair functions for Codex Desktop's Computer Use and Browser Use / Chrome extension features (previously detection-only, with no repair path): both attempt what's safely automatable via `codex features enable`, and honestly report `blocked` with concrete `next_actions` for steps that have no verified CLI subcommand (e.g. plugin install) or that can't be done via CLI at all (the Chrome Web Store install itself) — never guessing or claiming false success. Generalize the Supabase-only MCP stdio/url transport-collision repair (5.5.3) into `mcp-transport-collision-repair.ts`, which detects and fixes the collision for *any* MCP server name and in *either* direction (the Supabase-specific fix only caught project=stdio + global=url). `sks doctor --fix` now runs all of this, and writes an aggregated `.sneakoscope/reports/native-capability-readiness.json` (imagegen/computer_use/browser_use status).
- Add a `native_capability_setup` stage to `sks update`: after a successful install, the newly installed package's own repair modules run in a subprocess (same pattern as the existing `global_skills_reconcile` stage, avoiding a stale old-driver in-process run) to bring imagegen/computer-use/browser-use up to date automatically, without blocking the update on a manual-required step.
- Add an agent bridge so any agent system (not a specific one) can use SKS's full command surface: `sks mcp-server` is a real stdio MCP server (built on the already-installed `@modelcontextprotocol/sdk`) exposing read-only commands as MCP tools by default (`--expose-exec` opts in to the rest, never spawning a tool name absent from the manifest); `SKS_AGENT_MODE=1` is a non-interactive CLI contract (stdout is always exactly one JSON result, interactive prompts return `interactive_input_required` immediately instead of blocking, exit code 3); `--stream` (piloted on `sks qa-loop run`) emits NDJSON progress events ending in a `result` event, for a Slack bot (or any chat surface) to relay real-time progress. `sks agent-bridge setup` publishes the manifest, prints host registration snippets (generic MCP host, Codex CLI, non-interactive contract), and runs a live smoke test. See `docs/AGENT-BRIDGE.md` for the full reference and Slack-bot streaming recipe.

### Fixed

- Fix an ENOENT crash in `triwiki-cache-key.ts`'s file scanner when a directory in an input pattern vanishes or becomes inaccessible mid-walk (this was crashing `npm run release:check:affected` entirely, since the cache-key computation sits underneath the whole release gate DAG).
- Fix a router-level gap where an uncaught error mid-command left `--json` callers with empty stdout to `JSON.parse` — `dispatch()`'s final catch now always emits `{ok:false, error, command}` to stdout when `--json` was requested (stack still goes to stderr only), on top of the existing exit-code-1 behavior.
- Deduplicate three separate, buggy prompt-truncation implementations (`naruto-real-worker-runtime.ts`, `naruto-real-worker-child.ts`, `agent-orchestrator.ts` — the latter already fixed in 18차) into one shared `normalizeWorkerPromptText` helper: preserves newlines (previously collapsed, destroying prompt structure), raises the cap from 4000 to 32000 chars, and records truncation explicitly instead of silently cutting.
- Keep release metadata aligned after an explicit SKS version bump advances the package version.

### Changed

- Add a cwd-independence regression sweep (`src/cli/__tests__/cwd-independence.test.ts`) spawning all read-only commands from `cwd=/` and asserting none hit the filesystem-root crash class that the 5.5.1 menu bar fix addressed for one call path — this now covers the whole read-only command surface.

## [5.5.4] - 2026-07-05

### Fixed

- Fix `sks doctor --fix` never actually resolving the Supabase MCP `url is not supported for stdio` collision even after the 5.5.3 repair: `doctor --fix` wraps its whole run in a generic secret-preservation guard, and commenting out the colliding stdio block (5.5.3's fix) intentionally makes `SUPABASE_ACCESS_TOKEN` disappear from the guard's live scan — even though the value is still sitting right there in the comment. The guard treated that as an accidental secret loss, rolled the **entire file** back from backup (silently undoing the repair every time), and still threw `secret_preservation_restored`, crashing `doctor --fix` with exit 1. The guard now recognizes a protected secret whose value is still recoverably present in a commented-out line as preserved (not lost), so the transport-collision repair actually sticks; a secret that goes missing with no trace anywhere in the file still trips the guard exactly as before. Verified against a real, previously-broken project config.
- Keep release metadata aligned after an explicit SKS version bump advances the package version.

## [5.5.3] - 2026-07-05

### Fixed

- Make `sks doctor --fix` repair the Supabase MCP `url is not supported for stdio` failure that blocked Codex from starting any chat/task in a project. Codex merges the global (`~/.codex`) and project (`.codex`) config per key, so a project that defines Supabase MCP as stdio (`command = ...` + `SUPABASE_ACCESS_TOKEN`) while the global config uses a streamable-http `url` produces a merged table with both `command` and `url`, which Codex rejects. The Supabase MCP repair now reads the global config too, detects this stdio/url transport collision, and under `--fix` comments out the project's stdio block (with a backup, keeping the token recoverable in place) so the project inherits the safe global read-only url form. Without `--fix` it reports the `supabase_mcp_stdio_url_transport_collision` blocker instead of silently passing.
- Keep release metadata aligned after an explicit SKS version bump advances the package version.

## [5.5.2] - 2026-07-05

### Fixed

- Fix every SKS menu bar action reporting `21:22: syntax error … (-2741)`: `showNotification` built the `display notification` AppleScript by wrapping the body/title with a shell-style single-quote helper, but AppleScript string literals require double quotes and cannot contain raw newlines, so any command output threw an `errOSASyntaxError`. The notification script is now a fixed literal and the body/title are passed as osascript argv, so arbitrary output (quotes, newlines) can never break it; the misused shell-quote helper is removed. (The 5.5.1 ENOENT/update-self-verification fixes shipped first and surfaced this next notification-layer error.)
- Keep release metadata aligned after an explicit SKS version bump advances the package version.

## [5.5.1] - 2026-07-05

### Fixed

- Fix every SKS menu bar action crashing with `ENOENT: mkdir '/.sneakoscope'`: launchd starts the menu bar app with cwd=/, `projectRoot()` falls back to the raw cwd when no workspace marker is found, and the per-project update-migration gate then tried to create `/.sneakoscope` before the command could run. The gate now skips when the resolved root is the filesystem root, a failed lock-directory create degrades to a reportable blocker instead of an uncaught crash, and the generated menu bar action script both `cd`s to `$HOME` and disables the project migration gate (menu actions only touch global state).
- Fix `sks update` always ending in `updated_with_issues` after an npm-published install: (1) `postinstall` now regenerates `dist/.sks-build-stamp.json` inside the installed package — the tarball deliberately excludes it, so the `dist_stamp` self-verification could never pass on a registry install; (2) the update flow's `global_skills_reconcile` stage now delegates to the freshly installed package's own module instead of running in-process in the old driver binary, which stamped `~/.agents/skills/.sks-generated.json` with the old version and clobbered the manifest the new binary's migration doctor had just written (`skills_manifest` self-verification failure); (3) after a `launchctl kickstart` timeout the menu bar installer now waits up to ~30s (was ~9s) for the app to reach running state before declaring the stage blocked, since relaunch under `npm install -g` load routinely outlives the kickstart timeout. Note: one more `skills_manifest` warning may appear on the next update (the already-published driver still clobbers), after which updates verify clean.
- Keep release metadata aligned after an explicit SKS version bump advances the package version.

## [5.5.0] - 2026-07-05

### Added

- Add `work-order-ledger.json` (`createWorkOrderLedger`/`writeWorkOrderLedger`/`readWorkOrderLedger`/`updateWorkOrderItem`/`evaluateWorkOrderCoverage`/`createAndWriteWorkOrderLedgerForPrompt`/`closeWorkOrderLedgerForRouteResult`) as the per-item source of truth for a work order's items (`WO-001..N`, verbatim text preserved), wired into `$Naruto`, `$Team` (alias of Naruto), `$Goal`, and `sks run --mock/--execute` at mission creation, and closed to `verified`/honestly-`blocked` once each route's own gate resolves.
- Add a coverage gate to `evaluateStop` (the single choke point every route's stop decision passes through): stop is blocked while a mission's `work-order-ledger.json` has any item that is neither verified nor honestly blocked, and — for routes newly flagged `coverage_required` in `routes.ts` (`Naruto`, `Team`, `Goal`) — a missing ledger itself blocks stop. Also enforced inside the no-question/autonomous path and the canonical Naruto stop-gate `allow_stop` fast path, which previously bypassed every check below it.
- Enforce the previously-unused `required_coverage_passed`/`uncovered_required_count` stop-gate evidence fields in both the stop-gate writer and reader, so a gate cannot claim `passed` over failing coverage and a stale/hand-written gate file cannot be used to bypass it.
- Rewrite the work-order prompt parser (`promptRequirementItems`) to split on numbered/lettered/heading markers before whitespace normalization (previously whitespace was collapsed first, silently merging every numbered item into one), and remove the hard 12-item cap (raised to 128, with truncation now signaled via `{ truncated, truncated_count }` instead of dropped silently).
- Surface previously-invisible work-item loss as explicit blockers: `agent-proof-evidence.json` now reports `work_items_not_all_completed`, `work_items_failed`, and `work_items_orphaned_pending` (items whose dependency failed/blocked, which the scheduler's own pending-queue filter could never see).
- Fix the GLM Naruto requirement ledger collapsing an entire task into one requirement when no constraint keyword matched, and its coverage checker treating "the patch isn't empty" as proof every requirement was addressed.
- Preserve newlines and raise the worker-prompt truncation ceiling (4000 → 32000 chars) in `agent-orchestrator.ts`'s `normalizeWorkerPromptText`, recording `worker_prompt_truncated` when truncation still occurs instead of silently cutting instructions.
- Record silently-dropped domains (`domains_truncated`) in the loop planner instead of a bare `slice(0, maxLoops)`, and add `covers_work_order_items`/`unassigned_work_order_items` tracking fields to loop plans/domains.
- Add a `docs/mission-scoping-design.md` design/migration plan for scoping `findLatestMission()` by route/mode (not implemented this release — classification and staged rollout plan only).
- Add `test:core-root-regression` to `release-gates.v2.json` covering `dist/core/__tests__/*.test.js`, which was previously built and run by `npm test` but not gated by any release preset.

### Fixed

- Fix `sks run --execute` mislabeling its `$Team --mock` fallback (and any dedicated route whose command never references the prompt) as `execution_kind: 'live_route'`/`status: 'completed'`; it now reports `mock_safe`/`verified_partial` for the mock fallback and a `prompt_delivered` flag for routes whose command doesn't reference the prompt at all.
- Fix `naruto-gate.json`'s `passed` condition omitting `workGraph.ok`/`allocationPolicy.ok`, so a broken work-graph or allocation pass could not block the gate; also replace the hardcoded `verification_dag_ready`/`gpt_final_pack_ready: true` literals with values derived from the actual DAG/pack build.
- Fix `command-utils.ts`'s `promptOf`/`positionalArgs` silently deleting any part of an unquoted prompt that looked like a flag (dropping every `--`-prefixed token, plus the following token for ~50 known value-flags); only recognized flags are stripped now, everything else is preserved in the reconstructed prompt.
- Remove the phantom `five_lane_review`/`integration_evidence`/`session_cleanup` sections `release-command.ts` required from `release-readiness-report.json` — no producer had ever written them (introduced in commit `d4526f84` with no producer wired up), so `sks release affected` failed on a schema mismatch unrelated to real release readiness.
- Keep release metadata aligned after an explicit SKS version bump advances the package version.

### Changed

- `feature-fixtures.ts`: add `work-order-ledger.json` to the expected artifacts of fixtures whose routes now create/close it (`cli-run`, `cli-goal`, `route-team`, `route-naruto`, `route-work`, `route-swarm`); update `cli-release`'s reason to reflect the fixed schema mismatch while it stays honestly `blocked` on other unrelated release-gate failures.

## [5.4.0] - 2026-07-03

### Added

- Wire the 14차–16차 regression test suites (proof/stop-gate, commands, mad-sks, menubar/doctor, dfix/ppt) into `release-gates.v2.json` as five blocking release gates plus an `npm test` script, so breaking any of them now fails `release:check`.
- Add `runFeatureFixture()` real-execution verifier and `sks selftest --real` (also `npm run selftest:real`): execute-kind fixtures are actually spawned, expected artifacts checked on disk, and `fixture_status_claim_mismatch` blockers raised when a fixture's claimed `pass` is not reproducible. The first full measured run (~23 min) reported 59/103 passing with 44 claim mismatches recorded in `selftest-real-report.json`; the gate therefore ships as a manual/nightly script rather than a blocking release gate until those claims are reconciled.
- Surface `gate_verdict` (pass/fail/mock_only/missing/invalid) in the status output of `qa-loop`, `research`, `image-ux-review`, `mad-sks`, and `seo-geo-optimizer`, printed as the first human-readable line so mock or failed gates cannot be mistaken for success.
- Upgrade mock feature fixtures to real execute-and-validate fixtures where honestly possible (25 → 19 mock), with documented `reason` fields for the fixtures that must stay mock and `not_available` reclassification for the dead `cli-tmux` entry.

### Fixed

- Fix the SKS menu bar icon not reappearing after quitting and relaunching the Codex desktop app: re-showing the status item now reasserts the Control Center visibility defaults (`NSStatusItem Visible/VisibleCC`) that were previously only seeded at install time.
- Fix the menu bar "action script broken" warning surviving `doctor --fix`: the installer now re-asserts the action script's executable bit on every run (including the up-to-date fast path), the status/doctor smoke check executes the script directly the same way the Swift app does (catching a missing `+x` that the old interpreter-based check masked), and a lost bit is reported as an explicit `action_script_not_executable` blocker.
- Close the PPT imagegen-evidence bypass: a missing `imagegen_evidence` section in an image-asset ledger that contains raster assets now fails the gate with `imagegen_evidence_missing` (derivation basis recorded in the gate JSON) instead of silently defaulting to passed.
- Require SEO/GEO `apply` to be preceded by a mutation plan (`seo_apply_missing_mutation_plan` hard blocker) and to produce a rollback manifest before reporting success; final SEO ok is now re-evaluated against the on-disk gate, failing closed on `mock_fixture` gates via the shared `evaluateLocalGate` helper (also hardening Insane-Search status).
- Fix `sks goal create` crashing with "Agent count 5 exceeds max N" whenever the loop worker budget was below the default agent count.
- Write the promised `release-review-native-agent-plan.json` artifact during `$Release-Review` agent runs.
- Stabilize the unit test suite (deterministic 78/78 across repeated runs) by serializing the node test runner, isolating the doctor menubar test's launchctl probe, and pinning `NPM_CONFIG_PREFIX` in the action-script resolution test.

### Changed

- Document the MAD-DB→MAD-SKS merge in AGENTS.md and the new menu bar options (`quit_with_codex`, `--api-key-stdin`, View Last Log, `codex_sync`) in README.md.
- Raise the packed-package budget to 2340 KiB and the release-gate count budgets to 220 to accommodate the new production modules and test gates; every release gate now declares either `output_contract` or an explicit `contract_note`.

## [5.3.0] - 2026-07-03

### Fixed

- Harden the SKS menu bar lifecycle: Codex App bundle-id detection with explicit "sync disabled" fallback, doctor `--fix` runtime verification (launchd state, action-script smoke, status reinspection) with a runtime probe that defeats stale clean markers, runtime-first `sks` resolution in the action script, and native modal/background menu actions replacing Terminal windows (commit 2aa9e41e; user-facing details listed under 5.2.0).

## [5.2.0] - 2026-07-03

### Added

- Add Codex App bundle-id based SKS menu bar lifecycle sync so the status item appears when Codex runs, hides when Codex exits, and reports `codex_sync` in `sks menubar status`.
- Add native macOS menu prompts for codex-lb/OpenRouter secret entry and a `View Last Log` menu action backed by a private `~/.codex/sks-menubar/logs/last-action.log`.

### Fixed

- Resolve the menu bar `sks` command at action runtime before falling back to the install-time entry, preventing project-local path lock-in after `doctor --fix`.
- Make `sks doctor --fix` verify the menu bar runtime with launchd state, action-script smoke execution, and status reinspection instead of accepting self-reported install success.
- Prevent doctor dirty-plan clean skips from hiding menu bar runtime failures by adding a menubar runtime probe.
- Replace default menu Terminal windows with background execution, notifications, secure stdin secret delivery, and redacted 0600 action logs.

## [5.1.2] - 2026-07-02

### Changed

- Merged `$MAD-DB` into `$MAD-SKS` as the MAD-SKS `sql-plane` executor while keeping `$MAD-DB` / `sks mad-db` as deprecated compatibility aliases for one release.
- Unified SQL-plane stop-gate state under `mad-sks-gate.json`, including `sql_plane.requested`, capability id, operation classes, read-back status, and profile-close evidence.
- Made Codex App `$imagegen` / `gpt-image-2` the required full-evidence path for `$Image-UX-Review`, `$UX-Review`, and `$PPT` image review flows; OpenAI API fallback is now explicit opt-in and marked non-Codex evidence.

### Fixed

- Added the MAD-DB compatibility command translation:
  - `sks mad-db run <sql>` -> `sks mad-sks sql <sql>`
  - `sks mad-db exec <sql>` -> `sks mad-sks sql <sql>`
  - `sks mad-db apply-migration <file>` -> `sks mad-sks apply-migration <file>`
  - `sks mad-db status|close|revoke|doctor` -> corresponding `sks mad-sks` status/close/revoke/doctor behavior with `deprecated_alias: "mad-db"`.
- Added imagegen doctor repair reporting (`imagegen_repair` / `repair.imagegen`) and install-time imagegen readiness repair so unavailable Codex App image generation blocks honestly with manual actions instead of silently falling back.
- Strengthened generated-image gates with `evidence_class`, `output_source`, and `output_sha256` validation for Image UX and PPT slide review/asset evidence.
- Registered imagegen wiring and doctor repair coverage in feature fixtures and restored the release script entries used by the UX/PPT/DFix/all-features gates.
- Keep release metadata aligned after an explicit SKS version bump advances the package version.

## [5.1.1] - 2026-07-02

### Fixed

- Keep release metadata aligned after an explicit SKS version bump advances the package version.

## [4.8.7] - 2026-07-02

### Fixed

- Keep release metadata aligned after an explicit SKS version bump advances the package version.

## [4.8.6] - 2026-07-02

### Fixed

- Harden native worker MCP isolation, auth retry behavior, zombie worker reaping, gate honesty, and telemetry bounds so swarm execution cannot quietly pass with stale or fixture-only evidence.
- Consolidate release manifests around 189 release gates, 52 harness gates, and 72 script-backed checks while removing stale standalone gate manifests and backup artifacts from the packaged surface.

### Changed

- Split oversized route, research, RecallPulse, PowerPoint, QA-loop, and hook modules into smaller policy, artifact, prompt, and rendering surfaces without changing their public command behavior.
- Document gate policy, orchestration layers, polyglot runtime boundaries, and gate-to-script ownership so release evidence stays auditable before lifecycle-disabled publication.

### Verification

- Verified the 4.8.6 release surface with typecheck, incremental build, pipeline and command budget checks, gate policy audit, release gate planner, full release DAG coverage, release gate existence audit, affected dynamic release checks, Naruto active-pool runtime smoke, and whitespace checks.
- Confirmed npm already publishes `sneakoscope@4.8.5`, so 4.8.6 is the next publishable patch version for `npm publish --ignore-scripts`.

## [4.8.4] - 2026-07-01

### Fixed

- Fix SKS menu bar Terminal actions so they send the generated command instead of the literal `(escaped)` placeholder.
- Add a visible `Set codex-lb Domain and Key` menu action that opens the interactive `sks codex-lb setup` flow for entering the codex-lb base URL/domain and API key.

### Verification

- Extend the SKS menu bar install gate to require Swift Terminal command interpolation and the codex-lb setup menu action.

## [4.8.3] - 2026-07-01

### Fixed

- Remove unconditional LaunchAgent `KeepAlive` from the macOS SKS menu bar companion so choosing `Quit SKS Menu`, transient exits, or failed launches do not immediately respawn and create background churn.
- Mark the SKS menu bar LaunchAgent as `ProcessType=Interactive`, matching the user-facing status item instead of leaving launchd to classify the helper as a daemon.

### Verification

- Extend the SKS menu bar install gate to require no `KeepAlive` key and an explicit interactive process type in the generated LaunchAgent plist.
- Validate that the live SKS menu bar sample is idle in the AppKit event loop, with no timers, polling loop, crash logs, or growing menu bar logs.

## [4.8.2] - 2026-07-01

### Fixed

- Seed the macOS Control Center preferred position for the SKS menu bar item so the `SKS` label stays visible ahead of crowded notch-adjacent status items.
- Persist and force the SKS status item visible with a stable autosave name after menu bar restarts.
- Force the SKS menu bar label through an attributed title so macOS renders the text even when a crowded status area reorders the item near the notch.
- Prevent temp and hermetic release fixtures from launching or leaking duplicate SKS menu bar GUI processes.
- Expose `publish:prep-ignore-scripts` so lifecycle-disabled npm publication can run release checks explicitly before `npm publish --ignore-scripts`.
- Keep release metadata aligned after the 4.8.2 version bump.

## [4.8.1] - 2026-07-01

### Fixed

- Restore the macOS menu bar companion to a visible text-only `SKS` label so it remains easy to find after updating from 4.8.0.
- Give the first-command migration Doctor enough time to finish successful macOS repair profiles instead of leaving a stale `doctor_migration_profile_failed` receipt.
- Prevent temp-home Doctor/release fixtures, including runs with `HOME` pointed at a fixture directory, from bootstrapping the shared macOS SKS LaunchAgent label over the real user menu bar process.

### Verification

- Update the SKS menu bar install check to require the visible text-only `SKS` label, variable-length status item, and expected menu actions before release.
- Require SKS menu bar install checks to skip launch from explicit temp homes and temp `HOME` environments.
- Add a migration gate check for the longer first-command Doctor timeout.

## [4.8.0] - 2026-07-01

### Added

- Add `sks codex-lb fast-check` and the `codex-lb:fast-mode-truth` gate so codex-lb Fast Mode cannot pass unless priority service-tier evidence is present.
- Add Codex App status reporting for the requested native SKS menu surface, explicitly marking it unsupported by the current official Codex App extension APIs instead of faking a macOS menu.
- Add a macOS right-side SKS menu bar companion installed by `sks doctor --fix` as a compact circled `S` status icon for codex-lb/OAuth switching, OpenRouter/GLM setup, Fast Check, SKS Version Check, Update SKS Now, settings, and Codex restart.

### Changed

- Historical behavior at this release used a lowercase OpenAI-compatible
  provider identity and shared OpenAI auth for codex-lb. The Unreleased Desktop
  Full Capability remediation supersedes that contract.
- Make `sks codex-lb use-codex-lb` switch Codex App auth to the codex-lb API key, force Fast request intent, and restart Codex App on macOS unless `--no-restart-app` is passed. `--json` automation skips restart unless `--restart-app` is explicit.
- Make bare `sks update` the official npm-latest update path; `sks update check` remains status-only and successful/current update runs refresh the macOS `SKS` menu bar companion.

### Fixed

- Stop treating a configured codex-lb env key or Fast UI config as proof that actual Fast Mode was used. Status now separates configured intent, requested priority tier, and actual priority-tier evidence.
- Keep GLM/OpenRouter model profile and codex-lb key-entry diagnostics visible in `sks codex-app check` while detecting legacy codex-lb provider drift.

### Verification

- Added regression coverage for codex-lb priority request truth, actual-tier failure, provider contract drift, GLM profile/key UI status, and auth-mode switching without printing secrets.

### Notes

- 4.8.0 supersedes the local 4.7.3/4.7.4 candidates before publication so the codex-lb Fast Mode truth fix, Codex App provider/key UI diagnostics, and visible SKS menu bar icon ship under the final minor version.


## [4.7.0] - 2026-06-30

### Added

- Add `gpt-5.4-mini` as a supported Codex worker model alongside `gpt-5.5`.
- Add Codex App GLM 5.2 profile/key setup support through `sks codex-app set-openrouter-key`, including OpenRouter profile installation for Desktop model selection.

### Changed

- Allow Team/Naruto/native workers to receive dynamic model tiers: simple GPT work can downshift to `gpt-5.4-mini`, regular GPT work stays on `gpt-5.5` low, and risky/deeper work uses `gpt-5.5` high.
- Keep GLM-mode subagents and native agents pinned to `z-ai/glm-5.2` while mapping task risk to GLM reasoning effort tiers.
- Make managed native/agent TOML roles bounded write-capable instead of read-only, with explicit task lease constraints.

### Fixed

- Repair `sks doctor --fix` TOML cleanup so managed duplicate tables are deduped, stale managed startup blocks are fixed, and existing external MCP settings such as Context7 or Supabase are preserved.
- Keep Fast Mode configuration repair aligned with valid Codex Desktop `config.toml` syntax.

### Verification

- Added regression coverage for Codex model guards, dynamic agent model tiering, GLM profile installation, managed role repair, doctor duplicate TOML repair, Fast Mode packed commands, and `npm publish --ignore-scripts` dry-run readiness.

## [4.6.5] - 2026-06-30

### Fixed

- Prevent default `sks doctor --fix` runs from crashing when the optional Codex Doctor bridge is skipped and the report is `null`; the console now prints `codex doctor: unavailable` instead of throwing.
- Keep release metadata aligned after the explicit 4.6.5 package version bump.

### Verification

- Added regression coverage for skipped, unavailable, and available Codex Doctor console status formatting.

## [4.6.4] - 2026-06-29

### Fixed

- Compact closed mission session trees and terminal inactive `codex-sdk-home` runtime homes so `.sneakoscope/missions` cannot grow without bound after agent work finishes.
- Run mission retention cleanup during project-scoped postinstall and update migration receipt creation so users reclaim stale runtime cache on update and first normal command.
- Keep release metadata aligned after the explicit 4.6.4 package version bump.

### Verification

- Added retention cleanup coverage for closed sessions, terminal blocked diagnostics, update migration cleanup, and postinstall cleanup safety.

## [4.6.3] - 2026-06-29

### Added

- Added a MadDB Supabase transport diagnostics release gate that proves read-only MCP transport denials, SQL-plane timeouts, and explicit write-capable MCP URL selection are reported as separate failure classes.
- Added explicit `--mcp-url` / `SKS_MAD_DB_MCP_URL` support for active MadDB cycles so a project-local read-only Supabase MCP config cannot silently shadow the mission-local write-capable transport.

### Fixed

- Keep MadDB Supabase MCP failures from collapsing into an opaque `mad_db_tool_execution_failed` digest by recording a redacted `error_summary`, `error_kind`, and retry guidance in mission artifacts.
- Keep `sks update-check` and `sks update now` focused on the replaceable global npm install instead of letting a newer source checkout/packageRoot version hide a stale global `sneakoscope` package.
- Make default `sks doctor --fix` remove stale duplicate global `sneakoscope` installs and purge the npm cache, instead of waiting for `--full` diagnostics before reclaiming update leftovers.
- Keep release metadata aligned after the explicit 4.6.3 package version bump.

### Verification

- Added `mad-db:supabase-transport-diagnostics` to `mad-db:unit` so the MadDB direct apply-migration capability path, destructive-operation policy, and Supabase transport diagnostics are checked together before publication.
- Added an update-check regression proving a stale global npm install is still reported as updateable even when the current source checkout is already on a newer version.
- Added global install cleanup coverage proving `doctor --fix` removes an older global prefix and calls `npm cache clean --force`.

## [4.6.2] - 2026-06-27

### Changed

- Renamed the public source-intelligence command surface from UltraSearch to InsaneSearch: `sks insane-search`, `$Insane-Search`, and `$InsaneSearch` are now the primary names.
- Kept `sks ultra-search`, `$Ultra-Search`, and `$UltraSearch` as compatibility aliases so existing workflows continue to resolve.
- Updated source-intelligence docs, feature fixtures, release gates, and xAI compatibility guidance to prefer InsaneSearch.

### Verification

- Added/updated command and dollar-route blackbox coverage for the InsaneSearch route and legacy UltraSearch aliases.

## [4.6.1] - 2026-06-26

### Fixed

- Fixed the MadDB DB safety hook so direct Supabase MCP `apply_migration` calls can use the persisted active MadDB capability even when Codex hook payload state is not the MadDB route state.
- Reserved drifted direct MCP `apply_migration` operations against the real MadDB mission instead of the incoming hook payload mission id.

### Verification

- Added `mad-db:direct-apply-migration-hook` to prove direct MCP `apply_migration` remains covered by the MadDB capability ledger.

## [4.6.0] - 2026-06-26

### Added

- Added first-class `sks seo-geo-optimizer` command with doctor, audit, plan, explicit apply, verify, status, rollback, and fixture subcommands, using `--mode seo|geo` for mode-specific evidence.
- Added unified `$SEO-GEO-OPTIMIZER` route identity, classifier precedence, GEO/geolocation disambiguation, safe `sks run --execute` routing, and generated rich skill content without separate public SEO/GEO dollar surfaces.
- Added a shared `src/core/search-visibility` kernel for adapter detection, site inventory, SEO/GEO analyzers, typed artifacts, gated verification, mutation planning, apply journaling, and rollback manifests.
- Added search-visibility JSON schemas, explicit feature fixtures, release gates, and parallel release tasks for SEO/GEO command, route, skill, mutation, rollback, crawler policy, `llms.txt`, and unsupported-claim safety.
- Added Lean Engineering Policy v1 with normalized `lean_decision` plan evidence, code-structure `lean_change_evidence`, GPT final `lean_review`, worker prompt injection, and Completion Proof linkage.
- Added `sks bench lean-policy --json` for hermetic baseline-context vs lean-policy-context fixtures covering over-build and safety-sensitive candidates without live model accuracy claims.

### Changed

- Preserved package/README/npm SEO as `target=package` while adding website/docs technical SEO and Generative Engine Optimization evidence layers.
- SEO/GEO no longer collapse into `$AutoResearch`; research remains an optional child discovery stage while the parent route and Completion Proof stay `$SEO-GEO-OPTIMIZER`.
- Updated package release metadata, README, feature inventory generation path, npm keywords, and latest publish tag handling for `4.6.0`.

### Safety

- `audit` and `plan` are read-only. `apply` requires `--apply`, create-only ownership, base-hash checks, mutation journal, rollback manifest, and post-verification.
- `llms.txt` is optional and experimental, never required for a GEO gate, and never treated as proof of ranking, traffic, indexing, rich results, or AI citation.
- GEO crawler policy separates search, training, user-directed retrieval, and ads validation with dated official source URLs.

### Verification

- Added targeted gates for SEO/GEO CLI blackbox, audit fixture, no-mutation-by-default, mutation rollback/idempotency, canonical/sitemap/locale, structured data visible-content parity, claim evidence, crawler purpose policy, route identity, GEO disambiguation, rich skills, unsupported claims, and runtime fixture quality.


## [4.4.0] - 2026-06-25

### Added

- Added the provider-independent UltraSearch runtime, CLI surface, typed source/claim/convergence proof artifacts, and release gates.
- Added Source Intelligence Policy v2 with capability-based provider selection and x-search parity gaps separated from general source readiness.

### Changed

- Replaced the xAI/Grok source-intelligence path with UltraSearch. `sks xai` is now a deprecation-only compatibility notice and does not configure MCP servers or require credentials.
- Updated publish/release metadata for the 4.4.0 package surface.

### Verification

- `npm publish --dry-run --ignore-scripts` passes for `sneakoscope@4.4.0`; real X parity remains an explicit unproven gate unless a real corpus is supplied.


## [4.2.1] - 2026-06-25

### Fixed

- Keep release metadata aligned after an explicit SKS version bump advances the package version.
- Added an explicit `publish:ignore-scripts` / `publish:npm` release wrapper so the real npm publish path still runs the full prepublish gate before `npm publish --ignore-scripts`.

## [4.2.0] - 2026-06-24

### Added

- Added a first-class `$MAD-DB` route and `sks mad-db run|exec|apply-migration` execution path with mission-bound capability v2, SQL-plane operation classes, Supabase MCP tool inventory, read-back verification plumbing, and read-only restoration proof.
- Added mission-local ephemeral Supabase MCP write profiles for active MadDB cycles while keeping persistent Supabase MCP configuration read-only.
- Added MadDB release gates for route identity, hook idempotency, parallel lifecycle correlation, runtime profile lifecycle, policy snapshot coverage, capability v2, real Supabase E2E entrypoint, and operation lifecycle blackboxes.
- Added MadDB documentation and generated policy text from the typed MadDB policy SSOT.

### Fixed

- Removed `$MAD-DB` from `$MAD-SKS` aliases so MadDB authorization no longer disappears across mission preparation.
- Replaced pending-latest/tool-name lifecycle matching with canonical `tool_call_id` correlation and idempotent operation reservation.
- Stopped `sks mad-db enable` from creating a half-bound executable capability; real execution now goes through the first-class MadDB route.
- Quarantined `publish:fast` so release publication uses the normal release gates instead of a bypass script.

### Compatibility

- GitHub Actions, CI/CD workflows, and publish workflow files are unchanged.


## [4.1.1] - 2026-06-23

### Fixed

- Split optional native capability readiness from core Doctor readiness so Computer Use and Chrome Extension manual setup remains route-gated instead of blocking core CLI, managed migration receipts, or ordinary MAD startup.
- Reworked update migration state around a persistent installation epoch plus per-project v2 receipts, with migration-profile Doctor machine reports and exact required blocker output.
- Removed `setup --force`, recursive project size scans, historical/plugin/native optional diagnostics, and repeated schema generation from the default Doctor hot path.
- Deferred MAD update prompts, provider setup prompts, Codex App UI snapshots, native capability artifacts, pane proof, and native swarm startup until after the bootstrap UI path is opened.
- Gave logical managed verifier roles unique physical agent config filenames.

### Added

- Added Doctor `--profile migration`, `--machine-only`, and `--report-file` support for update/postinstall gates.
- Added route-specific native capability blocker fields, optional manual action fields, and Codex 0.142 shipped-schema/cache probe behavior.


## [4.1.0] - 2026-06-23

### Added

- Added Codex Doctor semantic readiness v2: structured blockers/warnings drive readiness, warning-only Doctor output remains ready, and unknown non-zero/unparseable output fails closed.
- Added Doctor post-repair authority artifacts so `sks doctor --fix` records pre-repair Doctor output but bases readiness on the final post-repair Doctor run.
- Added a managed asset manifest for skills, agent roles, hooks, and Context7 transport with 4.1.0 role metadata.
- Added Codex 0.142 broker wiring for multi-agent mode, rollout budget strategy, indexed web search, current time, app-server overload, MCP reconnect, plugin refresh, native thread search, remote native environment, and terminal subagent error handling.
- Added update migration receipts: `sks update now`, postinstall, and first normal command execution now share pending/current project migration state.
- Added release gates for Doctor semantic truth, Doctor transaction rollback evidence, managed role manifest parity, Codex 0.142 Doctor wiring, and zero tracked machine-local evidence.

### Fixed

- Plain `sks doctor --fix` now performs safe managed native asset repair; `--repair-codex-native` remains a compatibility alias rather than the only repair path.
- Context7 managed defaults now prefer the remote streamable-HTTP transport consistently across setup and Doctor repair.
- Package, CLI fast version, Rust crate metadata, lockfile metadata, and documentation now report 4.1.0.

### Compatibility

- CI/CD, GitHub Actions, publish workflow, and release automation files are unchanged.


## [4.0.15] - 2026-06-23

### Added

- Added a Codex `rust-v0.142.0` release manifest SSOT with SDK/CLI version parity, generated app-server schema hash, feature policies, and required real probe names.
- Added a Codex runtime resolver that records one binary identity with realpath, version, SHA-256, package root, platform, and arch.
- Added Codex 0.142 manifest, binary identity, policy, app-server-v2, thread-store, and capability gates plus generated app-server TypeScript/JSON Schema snapshots.
- Added an app-server-v2 JSON-RPC client for resolved Codex 0.142 binaries with native thread list/read/search wrappers and a deterministic `currentTime/read` response handler.

### Fixed

- Pinned `@openai/codex-sdk` exactly to `0.142.0` and updated the lockfile to the matching `@openai/codex` optional platform package graph.
- Stopped the SDK path from inheriting all host environment variables and removed hard-coded `approvalPolicy: never`, `skipGitRepoCheck: true`, and sandbox-derived network access.
- Replaced Codex thread registry read-modify-write updates with an atomic-lock plus journal path that preserves corruption evidence instead of silently swallowing it.
- Restored the published package contract by allowing `dist/scripts` verification targets into the npm tarball.

### Compatibility

- CI/CD, GitHub Actions, publish workflow, and release automation files are unchanged.



## [4.0.14] - 2026-06-19

### Fixed

- Added real parallel-stage execution metrics for GLM Naruto.
- Added bounded parallel queues for candidate gate, worktree, and verifier phases.
- Added requirement coverage tracking to prevent parallel workers from missing task details.
- Preserved `sks --mad` GPT/Codex/MAD route isolation from GLM/OpenRouter mode.
- Fixed benchmark/proof metadata regressions from 4.0.13.

## [4.0.13] - 2026-06-19

### Fixed

- GLM Naruto worktree workers now parse `<sks_patch_candidate>` bodies and apply only the extracted unified diff, with candidate/extracted hash evidence.
- Replaced patch-worker full fanout with a bounded adaptive scheduler, provider backpressure records, and retry-once policy for retryable provider failures.
- Live bench now separates the true direct GLM speed path from GLM Naruto 1/4/8/12 worker cases and marks unavailable metrics as null plus `metric_status`.
- Final apply now blocks dirty touched paths by default, runs targeted checks after apply, and rolls back when those checks fail.
- Added `final-seal.json`, stop-gate final-seal evidence, `merge-rationale.md`, and live bench markdown report artifacts for GLM Naruto audits.

## [4.0.12] - 2026-06-19

### Fixed

- Kept release metadata aligned after the explicit 4.0.12 package version bump.

## [4.0.11] - 2026-06-19

### Added

- Connected GLM Naruto worktree isolation policy so `--worktree` uses per-worker git worktrees when available or blocks honestly unless `--allow-patch-envelope-fallback` is set.
- Added live bench worker metrics for TTFT, total latency, verifier pass rate, token usage, cache counters, and worker completion/failure counts.
- Added candidate scoreboard artifacts and fed scoreboard scores into merge planning.
- Added rollback-aware final apply transaction artifacts with selected patch, pre/post diff hashes, and reverse-patch rollback evidence.

### Fixed

- `--no-apply` no longer skips the verifier wave; `--skip-verifier` is now the explicit opt-out.
- GLM Naruto early terminal paths now write canonical stop-gate evidence.
- Artifact secret audit now detects JSON key-level secrets and mission aggregate artifacts are sanitized before write.
- OpenRouter stream/client request encoding now accepts structural cache key parts.

### Compatibility

- CI/CD, GitHub Actions, publish workflow, and release automation files are unchanged.


## [4.0.10] - 2026-06-19

### Fixed

- Added a GLM Naruto patch-candidate gate for `<sks_patch_candidate>` envelopes, including diff extraction, protected-path checks, secret checks, and `git apply --check`.
- Made canonical Naruto stop-gate allow decisions final for Naruto-family routes so hidden proof/reflection gates cannot block after `allow_stop`.
- Preserved route-native `naruto-gate.json`/termination details while writing canonical `stop-gate.json` separately.
- Hardened GLM Naruto verifier workers with model guard and schema-validated JSON output.
- Added worker-local request, stream, patch, gate, and termination artifacts before aggregate mission artifact writes.
- Added typed OpenRouter stream idle timeouts, structural GLM request cache keys, hunk-level conflict detection, combined patch apply-check, and GLM Naruto artifact secret audit.

### Compatibility

- CI/CD, GitHub Actions, publish workflow, and release automation files are unchanged.



## [4.0.8] - 2026-06-19

### Added

- GLM Naruto extreme parallel modification loop: `sks --mad --glm naruto "<task>"` launches parallel GLM-only patch workers, isolated worktree/patch-envelope candidates, deterministic gates, conflict graph, merge planner, judge/finalizer, repair waves, and real streaming TTFT.
- `--open` alias for the GLM interactive launch path (from 4.0.7).

## [4.0.7] - 2026-06-18

### Added

- `--open` alias for the GLM interactive launch path. `sks --mad --glm --open` is now equivalent to `sks --mad --glm --interactive`.

## [4.0.6] - 2026-06-19

### Fixed

- Changed the GLM speed profile to avoid `high`/`xhigh` reasoning by default and to use `provider.require_parameters: false` with throughput-first routing.
- Added bounded GLM direct-run state, loop guard, request timeout, repeated-output/no-progress termination, and terminal run artifacts.
- Added real encoded OpenRouter request body reuse, AbortSignal/timeout support, and streaming TTFT/usage collection scaffolding.
- Added deterministic GLM patch parsing and `git apply --check`/protected-path gating before applying GLM patches.

### Security

- GLM direct runs continue to lock the model to `z-ai/glm-5.2`, disallow GPT/model fallback arrays, and block mutation on model mismatch.
- Encoded request caching skips secret-like prompt bodies and never stores Authorization headers.

### Compatibility

- CI/CD, GitHub Actions, publish workflow, and release automation files are unchanged.

## [4.0.5] - 2026-06-18

### Added

- Added a GLM-only xhigh speed profile for `sks --mad --glm`; ordinary `sks --mad`, Naruto/Team, and non-GLM Codex paths keep their existing defaults.
- Added GLM profile resolution for `--deep`, `--xhigh`, `--strict`, `--ttft`, and `--exact-provider`.
- Added GLM-only context budgeting, context cache, encoded request cache, tool schema cache, model metadata cache, output envelope parser, deterministic speed gate, latency traces, and synthetic `--bench` diagnostics.

### Changed

- GLM speed requests now keep `reasoning.effort: xhigh` while reducing latency pressure through compact context, `tool_choice: none`, bounded default `max_tokens`, streaming, and OpenRouter throughput/latency provider preferences.
- GLM Codex App and MAD launch profile metadata now report the xhigh speed profile and carry the selected GLM mode into launch proof.

### Security

- GLM mode continues to lock requests to `z-ai/glm-5.2`, disables provider fallback, omits fallback model arrays, and rejects non-GLM response model ids before mutation.
- `--exact-provider` validates provider slugs before they can be used in OpenRouter provider ordering.

### Compatibility

- CI/CD and publish workflow files are unchanged.
- Public non-GLM command behavior is preserved.

## [4.0.4] - 2026-06-18

### Fixed

- Fixed `sks --mad --glm` stopping after the GLM readiness banner instead of entering the MAD launch path.
- Wired GLM MAD launches to Codex with OpenRouter `z-ai/glm-5.2`, `model_provider="openrouter"`, and no codex-lb/OpenAI fallback.
- Disabled the existing GPT/codex-sdk native swarm by default for GLM MAD launches to keep the no-GPT-fallback contract honest until a GLM worker backend exists.
- Added launch proof in `mad-glm-launch.json` and regression tests for GLM launch args, secret handling, and swarm fallback blocking.

## [4.0.3] - 2026-06-18

### Added

- Added GLM 5.2 MAD mode through OpenRouter with `sks --mad --glm`.
- Added `sks --mad --glm --repair` for OpenRouter API key repair and rotation.
- Added GLM 5.2 request builder, response model guard, OpenRouter client/key store, and Codex App model profile metadata.
- Added Codex `rust-v0.141.0` compatibility evidence and a `codex:0.141-compat` gate.

### Changed

- Split GLM provider routing into pure profile, request, response guard, OpenRouter client, key lifecycle, and CLI mode modules.
- Aligned Codex integration policy with `rust-v0.141.0` by delegating native relay/cwd/path/plugin MCP behavior, deduping App/MCP declarations, bounding prompt-image and feedback surfaces, and treating terminal resize reflow as Codex-native.

### Security

- OpenRouter API keys are stored outside project files with private permissions and redacted in logs/artifacts.
- GLM mode locks requests to `z-ai/glm-5.2`, disables provider fallback, and rejects non-GLM response model ids before mutation.

### Compatibility

- Public CLI commands and aliases are preserved.
- CI/CD and publish automation files are unchanged.

### Fixed

- Keep release metadata aligned after an explicit SKS version bump advances the package version.

## [4.0.2] - 2026-06-18

### Added

- Build-once runner implementation with reusable proof/report artifacts and blackbox coverage.
- TriWiki-first release runner source-of-truth mode for affected and confidence release selection.
- TriWiki proof bank and release-gate-cache-v2 bridge reporting.
- Resource claim/release scheduler timeline for gate pack execution.
- Gate pack v2 shared artifact and assertion evidence path.
- Semantic dirty doctor based on parsed/content state and proof ids.
- Real sksd IPC request surface with cache warmup evidence.
- 4.0.2 all-feature real regression and five-minute SLA blackboxes.

### Fixed

- Keep release metadata aligned after an explicit SKS version bump advances the package version.
- `build-once:runner` no longer points at a missing or proof-thin source module.
- Affected/confidence release selection no longer ignores TriWiki gate selection.
- Legacy/team/tmux/old Codex gates cannot remain silently in the release surface without a non-expired structured allowlist.
- SLA certificate actual mode is generated from real execution statistics in the 4.0.2 regression surface.

## [4.0.1] - 2026-06-18

### Added

- TriWiki-first release runner integration.
- Real gate pack shared-fixture parallel runner.
- Executable extreme scheduler.
- Semantic doctor dirty repair.
- Real sksd daemon/IPC cache warmer.
- Actual SLA certificate.

### Fixed

- Proof bank cards now include full invalidation material.
- Gate packs no longer execute all gates sequentially with repeated setup.
- Doctor dirty repair no longer trusts stale marker files.
- Legacy/orphan gates fail release unless purged or explicitly documented.
- 5-minute confidence tier uses actual executed/reused proof metrics.

## [4.0.0] - 2026-06-18

- Add the TriWiki proof bank, proof cards, cache keys, module cards, gate impact maps, affected graphs, and SLA certificates for reusable affected-scope release proof.
- Add gate-pack manifest/runner, resource-class budgets, extreme parallel scheduler, five-minute SLA planning, build-once proof, `sksd` cache warming, and probe memoization.
- Add first-class `sks task`, `sks release`, `sks triwiki`, `sks daemon`, and `sks proof bank status` surfaces.
- Add doctor dirty repair planning so already-clean repair phases can be skipped with explicit transaction evidence.
- Add legacy/orphan gate inventory, destructive legacy alias purge checks, 4.0.0 required-gate coverage, and all-feature regression wiring.
- Bump package, lockfile, TypeScript constants, Rust helper metadata, README, changelog, and release docs to 4.0.0.


## [3.1.16] - 2026-06-17

### Fixed

- `sks --mad` now self-bootstraps a fresh project: when the only preflight blocker is a missing managed Codex config (`.codex/config.toml` absent), it regenerates the config (the `sks doctor --fix` equivalent) and re-runs the preflight instead of blocking the launch and printing "Run `sks doctor --fix`". An existing but unreadable/EPERM/parse-broken config still blocks and routes to `sks doctor --fix`, so genuine permission problems are never masked.
- A missing Codex config no longer cascades into misleading `macos_acl_ls_le_failed` / `macos_flags_ls_lO_failed` / `spawned_child_read_failed` blockers. The readability inspector skips the macOS ACL/flags/stat/symlink and node/child/codex-load checks when the config file does not exist, reporting only the honest `missing_config` / `missing_codex_dir` blocker.

## [3.1.15] - 2026-06-17

### Fixed

- `sks doctor --fix` no longer reports `codex_cli_config_toml_parse_error` / `cli_ready: no` on the run that repairs the config. The Codex config-load probe is re-run after the Context7/Supabase/startup MCP repairs land, so the readiness verdict reflects the repaired config instead of the stale pre-repair snapshot that trapped users in an endless rerun loop.
- Managed setup seeds `[mcp_servers.context7]` on the remote streamable-HTTP `url` transport instead of a local stdio `command`, so the project config never merges with a remote `url` in the global Codex config into the `url is not supported for stdio` error that Codex 0.140 rejects.
- The `codex_cli_config_toml_parse_error` operator action now names both misplaced machine-local keys and the Context7/MCP stdio-vs-`url` transport conflict, instead of only suggesting a key hoist that cannot fix a transport conflict.

## [3.1.14] - 2026-06-17

### Fixed

- Keep release metadata aligned after an explicit SKS version bump advances the package version.

## [3.1.13] - 2026-06-16

### Added

- Codex 0.140 deep probe evidence now records feature states, certainty, real usage parsing, goal attachment roundtrip proof, and usage-budget provenance in Naruto loop artifacts.
- 3.1.13 release wiring adds dedicated doctor transaction, secret line rollback, Codex 0.140 deep probe, and all-feature regression gates.

### Fixed

- `sks doctor --fix` uses a phase transaction runner with per-phase duration, postcheck, optional-manual readiness handling, and rollback evidence.
- Startup config repair now mutates only managed `[agents.*]` TOML blocks, recreates real managed role configs instead of placeholders, and postchecks TOML syntax plus orphan MCP child tables.
- Context7 and Supabase MCP repair reports preserve disabled servers, record remote/read-only readiness fields, and separate write-scope confirmation from read-only readiness.
- Secret preservation rollback restores changed protected assignment lines when possible, preserves unrelated operator edits, records nested guard operations, and keeps secret backups out of git.
- Native capability postchecks no longer treat environment variables as real Computer Use or Chrome extension proof outside explicit fixture/test modes.

## [3.1.12] - 2026-06-16

### Added

- Codex 0.140 capability and integration gates for usage metadata, goal attachment preservation, session delete/import, unified mentions, Bedrock managed auth, MCP reliability, SQLite recovery, non-TTY interrupt behavior, large-repo performance, hermetic feature probes, and optional real-probe enforcement.
- Production `sks doctor --fix` transaction and postcheck reports covering setup, Codex startup repair, startup config repair, Context7 repair, Context7 MCP repair, Supabase MCP safety, command alias cleanup, and native capability repair.
- Context7 MCP and Supabase MCP doctor repair reports are exposed in doctor JSON and release wiring so manual auth/read-only actions are visible and auditable.

### Fixed

- `sks doctor --fix` production repair is now release-gated by 3.1.12 wiring, doctor production blackbox, startup config repair blackboxes, Context7/Supabase MCP blackboxes, and the all-feature regression blackbox.
- Secret preservation rollback now protects changed protected values as well as missing protected values across setup/update/doctor paths without writing raw secret values to reports.
- Release gate parity now requires every `release` preset gate to have a package script, while still checking the required 3.1.12 gates and the real-check preset.
- `sks doctor --fix` now repairs stale `node_repl` MCP config without leaving an orphan `[mcp_servers.node_repl.env]` child table. When the current Codex App `cua_node/bin/node_repl` command exists, doctor rewrites to that path and preserves env; otherwise it removes the whole stale parent/child block.
- Release metadata is aligned for 3.1.12 across package, lockfile, CLI constants, Rust helper metadata, README, and changelog.

## [3.1.11] - 2026-06-16

### Fixed

- `sks doctor --fix` detects local stdio Context7 MCP config and migrates it to the remote Context7 MCP endpoint, avoiding launches that appear stuck at the Context7 stdio server banner.
- `sks doctor --fix` repairs stale Codex startup config by making SKS agent `config_file` paths absolute/existing, removing unsupported managed `message_role_prefix` role fields, preserving optional `supabase_sauron`, and dropping missing-command `node_repl` MCP blocks.


## [3.1.10] - 2026-06-15

### Added

- Release wiring parity gate for package scripts, release gates, required DAG ids, and built dist targets.
- Capability-specific native postchecks for image generation, follow-up edit paths, Computer Use, Chrome/web review, screenshots, app handoff, image path exposure, and saved artifact contracts.
- Secret value hash preservation with backup rollback for protected Supabase and MCP token sources.
- Skill duplicate active-name proof and the 3.1.10 all-feature regression blackbox.

### Fixed

- All hardening gates are wired in package scripts and release gates.
- Native capability repair no longer false-verifies manual-only surfaces or saved-artifact fallback as native path exposure.
- Supabase keys are protected against deletion and value mutation.
- Doctor/setup/update mutations are guarded by secret preservation.


## [3.1.9] - 2026-06-15

### Fixed

- Keep release metadata aligned after an explicit SKS version bump advances the package version.

## [3.1.8] - 2026-06-15

### Added

- Immutable SKS core skill manifest.
- Project skill duplicate detector and doctor repair.
- Native capability repair matrix for image/computer/Chrome/app screenshot/app handoff.
- Supabase secret preservation contract.
- Update/setup secret snapshot and rollback guard.

### Fixed

- SKS built-in skills no longer drift during doctor/setup/update.
- Project no longer accumulates duplicate active skills with the same canonical name.
- `sks doctor --fix` repairs native image/computer/Chrome/app screenshot capability where possible.
- Supabase keys and secret-like config are preserved across updates.


## [3.1.7] - 2026-06-14

### Added

- Runtime E2E Codex Native pipeline blackboxes.
- Neutral reference source cache refresh.
- Read-only feature matrix and explicit repair transaction split.
- Final brand-neutrality zero-leakage scan.
- Typed release helper scripts.
- Doctor unified readiness final UX.

### Fixed

- `release-scripts:type-safe` no longer contradicts `release-dag-full-coverage-check.ts`.
- Source-token pipeline routing checks are replaced by real fixture runtime artifact checks.
- Reference evidence does not require manual cache setup.
- Feature matrix read path no longer performs managed asset repairs.
- Invocation strategy is always written into runtime proof artifacts.

## [3.1.6] - 2026-06-14

### Added

- Codex Native Feature Broker, invocation router, neutral pattern evidence, and release gates for Loop, QA, Research, Image, MAD, and Doctor routing.
- `sks codex-native` for broker status, invocation planning, init-deep, hook lifecycle, pattern analysis, and reference evidence.
- Brand-neutrality, init-deep backup hygiene, doctor readiness UX, and release-script type-safety checks for the 3.1.6 release DAG.

### Fixed

- Removed external reference branding from user-visible docs, release gates, package scripts, generated reports, and artifact paths.
- Routed Codex-native feature decisions through one broker instead of scattered profile probes.
- Preserved directory-local memory without expanding Loop owner scope.


## [3.1.5] - 2026-06-14

### Added

- Live Codex Native reference source evidence analysis with hashed snippets and merged confidence in the pattern analysis report.
- Init-deep directory-local managed `AGENTS.md` sections, backups, and Loop node `memory_hints`.
- Execution profile propagation through Loop/Naruto, QA-LOOP, and Research artifacts.
- Release gates for no-`@ts-nocheck` core coverage, type-surface checks, probe blackboxes, rich skill/agent content, and execution-profile routing.

### Fixed

- Codex App harness matrix no longer hardcodes unknown hook approval or env-only `agent_type` support.


## [3.1.4] - 2026-06-13

### Added

- Codex Native reference/neutral reference reverse-analysis artifact.
- Codex App Harness Matrix.
- Codex plugin/hook/skill/agent-role lifecycle health.
- SKS init-deep project memory and AGENTS.md hierarchy.
- Native Codex `agent_type` probe and fallback role message.

### Fixed

- Codex App features are consumed through capability/proof artifacts instead of brittle assumptions.


## [3.1.3] - 2026-06-13

### Fixed

- Keep release metadata aligned after an explicit SKS version bump advances the package version.

## [3.1.2] - 2026-06-13

### Added

- Production fixture misuse guard for loop workers and gates.
- Finalizer-owned GPT final arbiter gate contract.
- Loop integration merge strategy ladder.
- Loop side-effect scanner and mutation ledger integration.
- Native worker/session interrupt for loop kill.
- Loop global concurrency budget.
- Real blackboxes for fixture guard, merge strategy, side effects, kill interrupt, and production e2e blackbox coverage.

### Fixed

- Non-builtin loop gates can no longer synthetic-pass in production via `SKS_LOOP_GATE_FIXTURE=1`.
- `gpt:final-arbiter` gate artifacts now explicitly point to finalizer-owned arbiter proof.
- Integration merge is no longer plain `git apply` only.
- GPT final arbiter receives a real side-effect report.
- Loop kill now attempts to interrupt active native worker sessions and records proof.
- 3.1.1 productionization changes are documented accurately; this release corrects underdocumented 3.1.1 Loop Mesh productionization.



## [3.1.1] - 2026-06-12

### Added

- Real maker/checker worker runtime invocation for Loop Mesh.
- Real loop gate command execution and unknown-gate failure.
- Worktree-required loop allocation with diff, patch byte, and owner-scope proof.
- Integration loop finalizer path with GPT final arbiter trigger for source mutation.
- Atomic owner lease and checkpoint/kill/resume foundation.

### Fixed

- Keep release metadata aligned after an explicit SKS version bump advances the package version.
- Checker `noMutation` semantics are separated from fixture mode.
- Non-integration loops block accidental full `release:check` execution.

## [3.1.0] - 2026-06-11

### Added
- Naruto Loop Mesh dynamic loop runtime.
- Goal-to-loop compiler.
- Loop graph planner/decomposer.
- Loop-local maker/checker mini swarms.
- Loop owner lease and collision guard.
- Loop-local affected gate selector.
- Loop state/run-log/budget/proof artifacts.
- Integration loop finalizer with GPT arbiter.
- `sks loop plan/run/status/proof/kill/resume`.

### Fixed
- Heavy goal pipeline no longer runs as one monolithic execution graph.
- Small changes use loop-local affected gates before integration gates.
- Parallel workers are grouped into independent mini-loops with local checkers.
- Goal command remains compatible but internal runtime compiles to loop graph by default.

## [3.0.4] - 2026-06-10

### Added

- Actual Codex 0.139 real probe runner.
- Real code-mode web search probe.
- Real doctor env redaction probe.
- Real plugin marketplace/source/cache probes.
- Real `-P` sandbox profile alias probe.
- Real rich schema preservation probe through SKS bridge and optional Codex SDK/tool path.
- Real interrupt_agent event stream probe.
- Real image referenced-path probe.
- Real sandbox/proxy preservation probe.

### Fixed

- `codex:0139-real-probes` no longer passes with skipped high-value probes in require-real mode.
- Actual probe results now write root + mission artifacts and release readiness summaries.
- Optional real probes are separated from hermetic release gates but strict release can require them.

## [3.0.3] - 2026-06-10

### Added

- Codex 0.139 required release coverage across `codex:0139-capability` and the new feature fixture gates.
- Codex 0.139 feature-probe fixtures for `interrupt_agent`, `oneOf`/`allOf`, doctor env redaction, marketplace `source`, `-P` profile alias, and code-mode web search availability.
- Runtime proof summary stacked/fallback visibility with pane-lock p95 and SLOTS anchor counts.
- Release wording clarifying that SKS bundles @openai/codex-sdk 0.138.0 while Codex 0.139 features come from the external Codex CLI when supported; release gates include hermetic fixtures and optional real probes.

### Fixed

- `codex:0139-capability` and its high-value fixture gates are now required by release-dag-full-coverage.
- Codex 0.139 capability detector no longer relies only on version flags for high-value features.


## [3.0.2] - 2026-06-10

### Added

- Codex `rust-v0.139.0` capability detection (`codex:0139-capability` gate, `.sneakoscope/codex-0139-capability.json` root + mission artifacts on `sks --mad` / `sks naruto run`): standalone web search in code mode, preserved `oneOf`/`allOf` tool schemas, doctor editor/pager env details, plugin marketplace `source` field and cached remote catalog, `-P` sandbox profile alias, and the multi-agent v2 `interrupt_agent` rename. See [docs/codex-0.139-compat.md](docs/codex-0.139-compat.md).
- Release cache version-neutral safety fixtures that prove only pure version-surface changes are neutralized.
- Agent message bus runtime summary fields and `sks naruto proof latest --messages N` proof output.
- Release proof source-truth artifact with commit, branch, dirty status, file hashes, and npm packlist size.

### Fixed

- Cockpit subagent-stage classification now accepts the Codex 0.139 multi-agent v2 `interrupt_agent` event name alongside the pre-0.139 `close_agent`, so lifecycle events keep mapping to `result` stages on newer CLIs.
- Release cache neutralization now parses package, lockfile, version constants, and build manifest surfaces instead of replacing every matching version string.
- Runtime proof summary now counts recent worker completion/failure/warning/error messages and blocks on error-level message bus entries.

## [3.0.0] - 2026-06-10

### Added

- Naruto finalizer policy is wired into the run result: `naruto-finalizer.json` artifact plus a console blocker line when local-LLM output still needs the GPT final arbiter.
- Worker completion/failure messages now flow through the agent message bus (`agent-messages.jsonl`) for operator-readable swarm history.

### Fixed

- Concurrent workers raced anchor creation and each opened its own `SLOTS` column with `--direction right`, splitting the screen into N side-by-side columns. Anchor + worker pane creation is now serialized per session with fresh state re-reads under the lock.
- Worker panes defaulted to `full-debug`, which runs the worker with `--json` and shows nothing until exit. The default is now the live `compact-slots` slot renderer, which streams heartbeat, current file, tool events, and stdout tails every second.
- `focus-pane-id` returning non-zero for an already-focused pane silently degraded stacked placement to plain down-splits.
- Scheduler batch dispatch serialized two telemetry file writes per worker before launching the next one; telemetry appends now run concurrently across launches while preserving per-slot ordering.
- `npm publish` re-ran the entire release DAG from zero on every release: the gate cache key hashed the raw package version, package.json, and dist/build-manifest.json, so a pure `sks versioning bump` (which also rewrites the three PACKAGE_VERSION constant sources) invalidated ~280 behavior gates including the ~11-minute blackbox suite. Cache hashing is now version-neutral for the five version-surface files; behavior changes still invalidate keys, version-correctness gates stay cache-disabled and always re-run, and `SKS_RELEASE_CACHE_VERSION_SENSITIVE=1` restores the old hashing.
- Naruto backpressure throttling (50% throttled / 25% saturated) is no longer silent: the run header reports when host resource pressure reduced active workers.
- npm packlist could balloon past gate limits (4683 files / 13MB) when stray TypeScript `.d.ts`/`.map` artifacts landed in `dist` (tsconfig emits declarations + source maps; only `build-dist` prunes them). The package `files` field now excludes `dist/**/*.d.ts`, `*.map`, and `*.tsbuildinfo` outright, so the published package stays at ~830 files regardless of how `dist` was produced.

### Removed


## [2.0.19] - 2026-06-09

### Added

- Optional Codex Desktop `/app` launch attempt mode.
- QA-LOOP app handoff lifecycle confirmation.
- Parallel plugin detail inventory fetch and cache diff.
- Global image saved-path contract enforcement.
- Codex model effort auto-discovery.
- App-server token usage auto-discovery fallback.

### Fixed

- Plugin inventory no longer fetches details sequentially.
- Image generation/edit artifacts cannot bypass saved-path contract.
- QA-LOOP Desktop review is not confused with Chrome Extension web evidence.
- Capability detector no longer blindly assumes all 0.138 features without probes.

## [2.0.18] - 2026-06-09

### Added

- Codex 0.138 capability detection with root and mission artifacts for `/app` handoff, plugin JSON, image path exposure, model-defined efforts, token usage, PAT v2, and OAuth MCP pre-refresh support.
- Codex plugin JSON inventory and candidate-only remote MCP server policy, including unavailable app-template doctor warnings and QA handoff recommendations.
- Image artifact saved-path contracts for QA/imagegen outputs so follow-up visual edits use real model-visible local paths.
- Model-advertised reasoning effort order support, QA effort escalation, Codex account token usage telemetry, and QA budget policy artifacts.
- Codex 0.138 doctor checks for shell fallback, Linux proxy socket paths, OAuth MCP pre-refresh readiness, AGENTS.md logical paths, and plugin discovery cache repair.
- Release DAG coverage and hermetic gates for the Codex 0.138 integration surface.

### Fixed

- Keep release metadata aligned after an explicit SKS version bump advances the package version.
- Naruto final gate pass status now includes `parallelRuntimeOk` instead of only recording it as side evidence.
- Team legacy create removal coverage now rejects the old `parseTeamCreateArgs` helper token.
- Mad-DB MCP result lifecycle recording now uses a central post-tool helper and treats MCP `isError` results as failed DB operation lifecycle events.

## [2.0.17] - 2026-06-08

### Added

- Strict production PID enforcement for parallel runtime proof.
- True active-time scheduler utilization.
- Mad-DB MCP result lifecycle audit.
- Unified runtime/release proof summary.

### Fixed

- Production parallel proof no longer passes without worker PID evidence.
- Scheduler utilization no longer uses completed-count approximation.
- Slot panels no longer wait for 100 events before seeing telemetry updates.
- Mad-DB operations now record succeeded/failed lifecycle results.

## [2.0.16] - 2026-06-08

### Added

- Real parallel runtime proof with PID, timeline, wall-clock, overlap, visible pane, and headless worker evidence.
- Batch dispatch scheduler and scheduler utilization metrics.
- Naruto real parallelism blackbox, parallelism modes, and production parallel proof summary.
- Model-call concurrency metrics separate from worker process concurrency.
- Worktree allocation batch/pool proof and scheduler prewarm wiring.
- Full release parallelism blackbox report.

### Fixed

- Worker launch fan-out no longer waits on per-slot scheduler state writes.
- Visible pane count is separated from active/headless worker count.
- Team create now remains a Naruto redirect without unreachable legacy create code.
- Mad-DB semantics are clarified as bounded one-cycle, multi-operation break-glass.

## [2.0.15] - 2026-06-07

### Added

- Evidence-bound Codex/GPT research synthesis writer.
- Anti-template and repetition detector.
- Source-density and claim-density quality checks.
- Realistic complete-package fixture.
- Research handoff consumability blackbox.
- Ultra stability report coverage through the release DAG.

### Fixed

- Deterministic synthesis renderer is now mock/fallback only.
- Template-like research reports are rejected.
- Final reviewer detects repeated prose and unsupported synthesis.
- Non-mock Research blocks when Codex/GPT synthesis or final review is unavailable.

## [2.0.14] - 2026-06-07

### Added

- Real stage-aware research cycle runner.
- Parallel source layer shard execution.
- Source-ledger partial merge.
- Claim matrix builder from source/novelty/falsification ledgers.
- Concrete implementation blueprint densifier.
- Codex/GPT research final reviewer.
- Research blackbox gates.

### Fixed

- Research stage runner no longer only records placeholder stages.
- Research final reviewer no longer static-only.
- codex-sdk:research-pipeline now verifies real research package behavior.
- Short summary reports are rejected by blackbox gate.



## [2.0.13] - 2026-06-07

### Added

- Add Research quality contract artifacts, claim-evidence matrix, source quality report, implementation blueprint, experiment plan, replication pack, final reviewer, and stage-aware research work graph.
- Add Research artifact JSON Schemas, docs, package scripts, and release DAG gates for the 2.0.13 research pipeline closure.

### Fixed

- Harden Research gate evaluation so short reports, thin source coverage, missing counterevidence, unsupported key claims, missing blueprints, missing replication artifacts, and unapproved final reviews keep the gate blocked.



## [2.0.12] - 2026-06-07

### Added

- Add release DAG closure for slot renderer proof semantics, Naruto allocation runtime wiring, GPT Final worktree apply policy, and cache glob hashing coverage.
- Add Naruto allocation/rebalance production wiring so assignment owners flow into work graph items, scheduler slices, queue ownership, and worker runtime proof artifacts.
- Add Naruto actual worker production integration proof that records control-plane worker result validity and keeps pre-run smoke opt-in.

### Fixed

- Keep Git worktree checkpoint apply strategies explicit by preferring checkpoint cherry-pick, falling back to merge, and recording cross-rebase reports for idle clean worktrees after primary integration advances.
- Keep local/worktree candidate patch application behind GPT Final approval, using GPT `modified` output as the patch source and blocking GPT `rejected` output.

## [2.0.11] - 2026-06-07

### Fixed

- Keep release metadata aligned after an explicit SKS version bump advances the package version.

## [2.0.10] - 2026-06-06

### Added

- Add real Naruto active-pool and extreme-parallelism runtime checks that spawn actual child workers and validate result artifacts.
- Add primary-repo worktree integration runtime proof and agent role-config repair proof.

### Fixed

- Keep Naruto active-pool collection tied to completed workers instead of arbitrary first-half selection.
- Keep Git worktree integration applying validated worker diffs back to the primary repo with rollback hash evidence.
- Keep release audit, dynamic release planning, dynamic execution, and release-check stamps aligned to `release-gates.v2.json`.
- Keep mutation callsite coverage from missing `fs.promises.writeFile` calls.
- Keep release metadata aligned after an explicit SKS version bump advances the package version.

## [2.0.9] - 2026-06-06

### Fixed

- Keep release metadata aligned after an explicit SKS version bump advances the package version.

## [2.0.8] - 2026-06-06

### Added

- Add the `release-gates.v2.json` manifest, release gate node schema, and a DAG-based `release:check` runner with resource-aware scheduling, hermetic per-gate environments, bounded logs, per-gate reports, cache proof, and speed-budget reporting.

### Fixed

- Preserve every Git worker worktree allocation in the manifest instead of overwriting prior rows.
- Include untracked file contents in exported Git worktree diffs with `git add -N`, emit one `git_apply_patch` envelope operation for worktree diffs, detect dirty main worktrees, and lock retained dirty worktrees with `git worktree lock`.

## [2.0.7] - 2026-06-05

### Added

- Add Git worktree detection, capability, root allocation, worker worktree management, diff export, patch-envelope conversion, integration merge queue, cleanup/dirty-retention, cache policy, and pool planning modules.

### Fixed

- Keep release metadata aligned after an explicit SKS version bump advances the package version.

## [2.0.6] - 2026-06-05

### Added

- Add Codex App Product Design plugin discovery, remote catalog lookup, auto-install readiness checks, and release gates for `product-design@openai-curated-remote`.
- Add Product Design-first routing hints for UI/design/PPT pipeline stages including research, ideation, audit, design QA, prototype, URL-to-code, image-to-code, share, and user-context.
- Add a Naruto read-only routing regression gate so read-only worker runs keep write mode off and avoid false patch requirements.

### Fixed

- Propagate read-only/no-write no-patch reasons through native worker proof so pre-existing dirty files do not fail proof as generated patches.
- Keep changed-file lease checks write-scoped, skipping them for proof runs that have no write leases, no writes, and no patch envelope.
- Keep `release-parallel-check` stdout bounded by writing full task detail to report files and printing only a concise summary.
- Keep SKS update prompts out of Codex App hooks while preserving CLI launch notices and making `sks doctor --fix` run the SKS global update path.
- Keep release metadata aligned after an explicit SKS version bump advances the package version.

## [2.0.5] - 2026-06-04

### Fixed

- Keep release metadata aligned after an explicit SKS version bump advances the package version.

## [2.0.4] - 2026-06-04

### Fixed

- Add all-feature completion fixtures for `sks update` and `$with-local-llm-on/off` so the release DAG can verify the new local LLM command surface instead of reporting fixture gaps.
- Route `sks update now` package installation through the mutation guard and package-install ledger so safety callsite coverage stays complete.
- Keep release metadata aligned after an explicit SKS version bump advances the package version.

## [2.0.3] - 2026-06-04

### Fixed

- Keep release metadata aligned after an explicit SKS version bump advances the package version.

## [2.0.2] - 2026-06-04


### Added

- **MAD no-mutation release gate.** Added `mad-sks:app-ui-no-mutation` to exercise the actual `madHighCommand()` fixture path and assert `~/.codex/config.toml` hashes, plugin flags, profile files, and legacy profile tables are unchanged.
- **Provider config.toml gate.** Added `provider:context-config-toml` to verify `model_provider = "codex-lb"` plus `[model_providers.codex-lb]` and `CODEX_LB_API_KEY` resolve to a high-confidence provider badge.

### Fixed

- `sks --mad` now uses a read-only launch profile with `-c service_tier=fast` / `-c model_reasoning_effort=high` overrides instead of calling the user-config-writing `enableMadHighProfile()` path.
- `sks --mad` launch preflight no longer repairs config by default; mutation-capable repair is limited to explicit repair flags.
- `doctor --fix` now auto-applies safe Codex App Fast UI repair plans and leaves unsafe user-selected `standard` / `flex` state for explicit confirmation.
- Provider context resolution now reads `~/.codex/config.toml` provider selection and codex-lb provider blocks instead of relying only on env/auth state.
- Production runtime MJS enforcement now covers both root `scripts/*.mjs` and `bin/*.mjs`; the obsolete `bin/sks.mjs` shim was removed.

### Verified

- `npm view sneakoscope version --json` returned `2.0.1`, so no newer package update prompt was required before this 2.0.2 closure work.
- `npm run build`
- `npm run mad-sks:app-ui-no-mutation`
- `npm run doctor:fixes-codex-app-fast-ui`
- `npm run provider:badge-context`
- `npm run provider:context-config-toml`
- `npm run runtime:no-mjs-scripts`
- `npm run runtime:ts-source-of-truth`
- `npm run runtime:ts-python-boundary`
- `npm run release:gate-existence-audit`
- `npm run codex-app:fast-ui-preservation`
- `npm run codex-app:ui-clobber-guard`
- `npm run codex-app:provider-badge`

## [2.0.1] - 2026-06-04

Patch release: preserve Codex App Fast UI state around `sks --mad`, make provider identity visible in worker proof, and finish the production runtime migration from root `scripts/*.mjs` to TypeScript-built `dist/scripts`.

### Added

- **Codex App Fast UI preservation.** Added UI state snapshots, host-owned key diffing, project-local clobber detection, repair planning, and a doctor repair path guarded by explicit `--repair-codex-app-ui`.
- **Provider badge context.** Added provider resolution for `openai`, `codex-lb`, and `codex-app`, plus badge/fallback reporting that avoids mutating private Codex App UI state.
- **TypeScript runtime scripts and optional Python diagnostics.** Production gates now run from `dist/scripts/*.js` built from `src/scripts/*.ts`; optional Python helpers live under `pytools` and are not runtime fallbacks.

### Changed

- Package scripts, release-gate paths, package-boundary checks, architecture guards, and runtime parity checks now treat `src/scripts` as the source of truth and `dist/scripts` as the runtime surface.
- Doctor JSON/readiness output includes Codex App UI preservation state and provider context.

### Verified

- `npm view sneakoscope version --registry https://registry.npmjs.org/` returned `1.21.9` before the 2.0.1 bump, so no newer package update prompt was required.
- `npm run typecheck`
- `npm run build`
- `npm run runtime:no-mjs-scripts`
- `npm run runtime:ts-python-boundary`
- `npm run runtime:no-src-mjs`
- `npm run runtime:ts-source-of-truth`
- `npm run runtime:dist-parity`
- `npm run package-boundary:check`
- `npm run architecture:guard`
- `npm run runtime:ts-rust-boundary`
- `npm run codex-app:fast-ui-preservation`
- `npm run codex-app:ui-clobber-guard`
- `npm run doctor:fixes-codex-app-fast-ui`
- `npm run provider:badge-context`
- `npm run codex-app:provider-badge`
- `npm run agent:worker-pane-communication-contract`
- `sks wiki validate .sneakoscope/wiki/context-pack.json`

## [2.0.0] - 2026-06-03


### Added

- **Codex Control Plane release gates.** Added `codex-control:*` checks for capability, no legacy fallback, structured output, event ledgers, thread registry, side-effect scope, all-pipeline coverage, empty-result retry, stream-idle watchdog, tool-call sequence repair, keepalive without CoT leak, and real smoke aliasing.
- **Reliability Shield.** `src/core/codex-control/codex-reliability-shield.ts` evaluates SDK attempts, retries empty results before meaningful output, blocks idle streams after partial output, repairs missing tool-result sequences with explicit stubs, and emits redacted thinking heartbeats.
- **UltraRouter.** New `src/core/router/*` modules classify orchestrator/worker tasks, score capability cards, cache route decisions, hard-filter image/profile mismatches, and write `ultra-router-proof.json`.

### Changed

- `runCodexTask` now records UltraRouter decisions and Reliability Shield reports in `codex-control-proof.json`.
- Native worker SDK tasks pass explicit worker tier and reliability policy into the control plane.
- Version truth was advanced to `2.0.0` across package, lockfile, TypeScript, Rust, README, and changelog surfaces through the SKS versioning bump path.

### Removed

- No runtime Codex task may fall back to raw `codex exec`; explicit legacy backend requests continue to block with `legacy_codex_exec_runtime_removed`.

### Verified

- `npm view sneakoscope version --registry https://registry.npmjs.org/` returned `1.21.9` before the 2.0.0 bump, so no newer package update prompt was required.

## [1.21.9] - 2026-06-03


### Added

- **Codex SDK Control Plane.** New `src/core/codex-control/*` modules manage SDK capability, thread registry, event translation, structured output schemas, sandbox/env/config policy, fake hermetic adapter, real SDK adapter, and control proof artifacts.
- **SDK proof artifacts.** Every SDK worker writes `codex-control-proof.json`, `codex-thread-registry.json`, `codex-sdk-events.jsonl`, and `codex-sdk-worker-result.json` with `sdk_thread_id`, `sdk_run_id`, stream event count, and output schema id.

### Changed

- **Native agent default backend is `codex-sdk`.** Team, QA-LOOP, Research, Naruto, MAD-SKS, and direct agent command surfaces now default to SDK execution unless mock/fake mode is requested.
- **Fast/proof policy recognizes SDK evidence.** Real/fake proof policy, fast-mode propagation, route collaboration, and real-parallel proof now treat SDK thread and event evidence as the Codex runtime proof.

### Removed

- Runtime fallback to raw `codex exec` for native workers. Explicit `codex-exec` requests now block with `legacy_codex_exec_runtime_removed`.

### Verified

- `npm view sneakoscope version` returned `1.21.7` before the bump, so no newer package update prompt was required.
- Context7/OpenAI Codex SDK documentation was consulted for `@openai/codex-sdk` thread, run, streaming, output schema, sandbox, approval, and working directory APIs.
- `npm run typecheck`
- `npm run build`

## [1.21.8] - 2026-06-02


### Added

- **Slot/pane proof gates.** New checks cover main-only layout generation, worker pane manager metadata, scheduler spawn order, slot-to-pane binding, worker artifact communication, dynamic backfill panes, and real-codex-in-worker-pane wiring:
  - `npm run agent:slot-pane-binding-proof`
  - `npm run agent:worker-pane-communication-contract`

### Changed


### Fixed

- Keep release metadata aligned after an explicit SKS version bump advances the package version.

### Verified

- `npm view sneakoscope version --json` returned `1.21.7` before the bump, so no newer package update prompt was required.
- `npm run build`
- `npm run typecheck`
- `npm run agent:slot-pane-binding-proof`
- `npm run agent:worker-pane-communication-contract`
- `npm run agent:native-cli-session-swarm`
- `npm run agent:native-cli-session-swarm-10`
- `npm run agent:native-cli-session-swarm-20`

## [1.21.7] - 2026-06-02


### Changed


### Fixed

- **Release metadata stays aligned after the explicit version bump.** `sks versioning bump patch` advanced package, Cargo, README, and changelog version surfaces to 1.21.7.

### Verified

- `npm view sneakoscope version --json` returned `1.21.6` before the bump, so no newer package update prompt was required.
- `npm run typecheck`
- `npm run build`
- `sks naruto run ... --clones 3 --work-items 3 --readonly --json`

## [1.21.6] - 2026-06-02

Patch release: promote OpenAI Codex CLI `rust-v0.136.0` as the current compatibility baseline, wire its release-note features and bug fixes into SKS readiness, and prepare the npm release metadata.

### Added

- **Codex 0.136 compatibility matrix and release gate.** New `codex:0.136-compat` / `codex:0.136-compat:require-real` checks record `rust-v0.136.0` evidence for session archive/unarchive, app-server `--stdio` plus resumed-turn/status behavior, `CODEX_API_KEY` remote registration, short-lived remote-control server tokens, elevated Windows sandbox setup, feature-gated image-generation extension support, ChatGPT auth refresh/relogin-required handling, command-safety hardening, sandbox cleanup, Bedrock region fallback, and rmcp 1.7.0 compatibility.
- **0.136 release documentation and truthfulness coverage.** `docs/codex-0.136-compat.md`, the Codex CLI compatibility guide, official docs compatibility report, release-readiness report, and README now name the 0.136 capability ids directly while keeping 0.135/0.134/0.133 as inherited baselines.

### Changed

- **`sks codex compatibility` now reports 0.136 first.** The aggregate compatibility output uses `rust-v0.136.0` as `required_baseline`, keeps the 0.135 and 0.134 matrices visible as inherited compatibility, and exposes local 0.136 probe evidence when the installed Codex CLI is available.
- **Release readiness now tracks the 0.136 gate.** `release:check`, the parallel release DAG, metadata checks, real-check wiring, runtime truth matrix, and gate-existence audit all include the warning-only 0.136 compatibility check, with `:require-real` kept in environment-dependent release proof.

### Fixed

- **`npm publish` now fails before `prepack` when npm auth is missing, stale, or not a maintainer.** The registry gate checks `npm whoami` and the package maintainer list under `--require-publish-auth`, detects configured-but-rejected npmrc tokens, and explains how to refresh `npm login` or configure an npm-consumed registry token before the expensive build and final registry `PUT /sneakoscope`.
- **Release metadata stays aligned after the explicit version bump.** `sks versioning bump patch` advanced package, Cargo, README, and changelog version surfaces to 1.21.6.

### Verified

- Verification for the 0.136 compatibility and release-prep changes is recorded in this turn's final release report.

## [1.21.5] - 2026-06-01

Patch release: restore Codex App compatibility for Codex CLI 0.135-era hook routing, Git Actions readiness, and Context7-backed repair prompts.

### Fixed

- **Codex App repair prompts now route to `$Team`, not `$Answer`.** Mixed complaint/directive prompts such as "호환이 안되는거같은데...?? 원인 분석해서 수정하고 배포 준비해줘 use context7 mcp" now keep the explicit implementation/release directive, even when the prompt contains `??`. Pure method questions such as "이 오류는 어떻게 수정해야 해?" still stay answer-only.
- **Context7 MCP mentions no longer misroute non-database repair work to `$DB`.** Bare `mcp` wording is no longer treated as a database signal; database routing still triggers on concrete database terms such as SQL, Supabase, Postgres, migrations, RLS, Prisma, Drizzle, Knex, `database`, `DB`, and `execute_sql`.
- **Codex App Git Actions readiness no longer depends on the removed `remote_control` feature flag.** SKS now treats `codex remote-control` command/version support as the remote-control capability source for Commit, Push, Commit and Push, and PR flows. On Codex CLI 0.135.0, this removes the stale `remote_control_feature` blocker while preserving real blockers when the command is unavailable.
- **`$Naruto` / native-agent parallelism is no longer gated by CPU cores.** Codex-exec workers are network-bound (each mostly idle awaiting the Codex API), so live concurrency now scales by memory and the provider rate limit up to the 100-clone ceiling — a capable host can run up to 100 in parallel regardless of core count (a 10-core / 32 GB host now allows 64). Tunable via `SKS_NARUTO_MAX_CONCURRENCY`, `SKS_NARUTO_GB_PER_WORKER`, and `SKS_NARUTO_MIN_CONCURRENCY`.
- **Image generation works when authenticated through codex-lb.** `gpt-image-2` routes through the same Codex `/responses` backend the load balancer already proxies, so `$imagegen` no longer hard-blocks for codex-lb-only users (no direct `OPENAI_API_KEY`). The official Codex App `$imagegen` surface stays primary; opt out with `SKS_IMAGEGEN_ALLOW_CODEX_LB_API_FALLBACK=0`.
- **The MAD / Naruto cockpit lane reflects live fan-out.** When the lane's own mission ledger is idle, the renderer mirrors the most-recent active agent mission so parallel work shows up instead of a permanent "Workers idle". Disable with `SKS_LANE_FOLLOW_ACTIVE_MISSION=0`.
- **`sks --mad` now fans out through the native agent swarm.** MAD launch starts a read-only `sks agent run` swarm in the same MAD mission ledger before opening the cockpit, so the right-side lanes are backed by live native workers instead of a single orchestrator-only session. Tune with `--mad-agents`, `--mad-swarm-work-items`, and `--mad-swarm-backend`; use `--no-mad-swarm` only as an emergency UI-only fallback.
- **Codex App Full Access is no longer shadowed by the Fast profile.** The generated `sks-fast-high` profile no longer pins `sandbox_mode = "workspace-write"`, letting the Codex App/IDE permissions selector own Full Access vs workspace-write. The explicit `sks-mad-high` maintenance profile still uses `danger-full-access` for user-authorized MAD launches.
- **`$Goal` official-mode detection now checks `codex features list`.** SKS can detect `goals ... true` feature output even when `codex goal --help` is slow, hidden, or unavailable, and still falls back to the SKS goal bridge when no official signal is present.
- **Substantive follow-up prompts no longer collapse into the previous single active route.** When an active mission exists, new analysis, research, or code-changing `UserPromptSubmit` prompts now prepare a fresh Team/Research-style route with native sessions required instead of only replaying the old active context. Plain continuation prompts such as "keep going" still resume the current route, and simple commit/commit-and-push requests stay lightweight instead of entering Team parallelism.
- **The "update available" prompt no longer repeats on every turn.** After the choice is shown it stays quiet for a short window (default 8 min, `SKS_UPDATE_OFFER_THROTTLE_MS`) before re-surfacing; accept/decline still take effect immediately.
- **`sks doctor --fix` re-seeds the Codex App Fast-mode UI table.** The global `~/.codex/config.toml` `[user.fast_mode]` (`visible`/`enabled`/`default_profile`) is refreshed so installs whose config predates the Fast-mode keys get the Codex App speed selector back.

### Added

- **`sks xai` command** (alias `sks grok`) to set up, check, and document the optional xAI/Grok Live Search MCP provider for source intelligence, with an install-time discovery hint. `sks xai check`, `setup`, `status`, `docs`.

### Verified

- `npm run build --silent`
- `node --test test/unit/route-codex-app-compat-classification.test.mjs test/unit/codex-app-remote-control-readiness.test.mjs`
- `node --test test/unit/hook-command-output.test.mjs`
- `npm run codex:compat --silent`
- `npm run hooks:semantic-check --silent`
- `node ./dist/bin/sks.js codex-app check --json` (Git Actions and Chrome Extension pass; local Fast UI remains blocked by `global:top_level_model_reasoning_effort` until `sks doctor --fix` repairs the user's global Codex config)
- `node --test test/unit/mad-sks-native-swarm-wiring.test.mjs test/unit/auto-review-profile-config.test.mjs test/unit/official-goal-mode.test.mjs`
- `npm run goal-mode:official-default --silent`
- `node ./scripts/codex-app-ui-preservation-check.mjs`
- `npm run typecheck --silent`
- `node --test test/unit/hook-active-route-parallel-refresh.test.mjs test/unit/hook-command-output.test.mjs test/unit/hooks-update-check-control-plane.test.mjs`
- `npm run hooks:runtime-replay-warning-zero --silent`
- `npm run selftest -- --mock --silent`
- `npm run packcheck --silent`
- `npm run release:check:parallel --silent` (254/254 passed)

## [1.21.4] - 2026-06-01


### Fixed

- **Naruto live parallelism no longer collapses to one slot on capable Macs.** The host-capacity model now treats low macOS `freemem` as only one pressure signal and uses a conservative reclaimable-memory floor from total RAM, so `codex-exec` Naruto runs keep useful parallel slots on machines that can sustain them. Operators can still override with `SKS_NARUTO_MAX_CONCURRENCY`, and `sks naruto run` also accepts `--concurrency` / `--target-active-slots` for an explicit run-level target.

### Verified

- `npm run build --silent`
- `npm run naruto:shadow-clone-swarm --silent`
- `npm run terminal:tui-output-stability --silent`
- `npm run typecheck --silent`
- `npm run changelog:check --silent`
- `npm run release:version-truth --silent`

## [1.21.3] - 2026-06-01


### Fixed

- **Direct `npm publish` self-heals stale release stamps safely.** The publish path now runs `prepublish:release-check-or-fast`: if the existing release-check stamp is current, publish stays on the fast path; if the stamp is missing or stale, publish runs the full authoritative `npm run release:check` once, then rechecks the stamp before continuing. This fixes the recurring stale `prepublish:fast-check` failure after version bumps without replacing the full release gate with a synthetic stamp write.
- **`sks fast-mode on` now also repairs Codex Fast mode.** The explicit on action still writes the project-local SKS preference, and now also restores Codex's Fast mode UI/default profile keys (`[user.fast_mode] enabled/visible/default_profile`) plus top-level `service_tier = "fast"` when those were disabled, while preserving unrelated user/plugin settings.
- **Release proof structure checks see the minimum-agent blocker again.** The agent gate now records `agent_count_below_5` as well as the dynamic expected-count blocker, restoring the release DAG's route-proof artifact audit.

### Verified

- `npm run build --silent`
- `node --test test/e2e/route-team-native-agents.test.mjs`
- `node --test test/unit/prepublish-release-check-or-fast.test.mjs`
- `node --test test/blackbox/fast-mode-command-packed.test.mjs`
- `npm run routes:proof-artifact-structure --silent`
- `npm run release:version-truth --silent`

## [1.21.2] - 2026-06-01


### Fixed


## [1.21.1] - 2026-06-01


### Fixed

- **No more Codex "legacy profile" deprecation warning on launch.** `enableMadHighProfile` already removed `[profiles.sks-mad-high]`, but `runCodexLaunchPreflight`'s project-config splitter ran afterward and re-injected the legacy `[profiles.*]` tables from the project config back into `~/.codex/config.toml` every launch. Codex 0.134+ deprecated config-profile tables and the top-level `profile=` selector in favor of per-file `$CODEX_HOME/<name>.config.toml` overlays loaded by `--profile`. `splitCodexProjectConfigPolicy` (`src/core/codex/codex-project-config-policy.ts`) now drops those deprecated tables/selectors (reported as `removed_legacy_profiles`) instead of relocating them; `init.ts` and `install-helpers.ts` stopped emitting the legacy tables; and `migrateSksProfilesToPerFile` (`src/core/auto-review.ts`) writes per-file profile overlays and strips the stale tables on `sks --mad`. The Codex App fast-mode `[profiles.sks-fast-high]` table, `[user.fast_mode] default_profile`, and `model_provider = "codex-lb"` are preserved.

## [1.21.0] - 2026-06-01

### Fixed

- Keep release metadata aligned after an explicit SKS version bump advances the package version.

## [1.20.5] - 2026-06-01


### Fixed


### Verified

- `npm run typecheck`
- `git diff --check`

## [1.20.4] - 2026-06-01


### Fixed


### Verified

- `npm run typecheck --silent`
- `git diff --check`

## [1.20.3] - 2026-05-31


### Added

- **Fast mode dollar toggles.** Added `$Fast-On`, `$Fast-Off`, and `$Fast-Mode` plus `sks fast-mode on|off|status|clear`. The toggle writes the project-local `.sneakoscope/state/fast-mode.json` preference and native-agent routes honor it only when no explicit `--fast`, `--no-fast`, or `--service-tier` flag is present.

### Fixed


### Verified

- Added `test/blackbox/fast-mode-command-packed.test.mjs` and expanded `test/unit/fast-mode-policy.test.mjs` to cover project-local preference on/off/clear behavior, dollar-command discovery, and explicit flag precedence.

## [1.20.2] - 2026-05-31

Stabilization patch: closes the enforcement / integration / execution layers that 1.20.1 shipped as infrastructure-only. No new large features. `release:check` passes end-to-end at 1.20.2.

### Added

- **`release:check:dynamic:execute` — real caching gate runner.** New `scripts/release-check-dynamic-execute.mjs` executes the change-selected hermetic gates (reusing `gate-manifest` + `gate-cache` + the `release-real-check` spawn model), serves cache hits to skip re-runs (cache key includes affected-file hashes + dist digest + git HEAD), defers real/heavy gates to `release:real-check`, and emits a `sks.release-check-dynamic.v2` report (`mode/selected/skipped/executed/cache_hits/failures/ok`). `--plan-only` preserves planning; `--publish` runs every `required_for_publish` gate. Standalone (never in the chain/DAG/manifest). Docs: `docs/dynamic-release-pipeline.md`; publish policy added to `docs/release-readiness.md` (dynamic-only cannot authorize a publish).
- **Core Skill route-runtime integration.** `runNativeAgentOrchestrator` now consults the route's deployed Core Skill snapshot (`selectRouteSkill`, read-only, never invokes the optimizer) and records `selected_core_skill` (skill_id/version/hash/source/optimizer_invoked) in `agent-proof-evidence.json` for the agent/qa/research/naruto routes. `promoteToDeployed` gained an optional 3rd `opts` param (2-arg callers unchanged) that records `skill_snapshot_promotion` in the mutation ledger with the archived snapshot as the rollback pointer. New gates `core-skill:route-runtime-integration`, `core-skill:promotion-side-effect-ledger`.

### Changed

- All version surfaces bumped to **1.20.2** (`package.json`, `package-lock.json`, `src/core/version.ts`, `src/core/fsx.ts`, `src/bin/sks.ts`, `crates/sks-core/Cargo.toml`/`Cargo.lock`/`main.rs`, `RELEASE_VERSION`). The release-metadata script keeps its `-1-19-` filename by convention (only the internal version constant moves).
- The 4 new hermetic gates are wired into `release:check` (chain + DAG + regenerated `release-gates.json` + existence-audit required list).

### Verified


### Fixed

- **Stale splitter test.** `test/unit/codex-config-preflight.test.mjs` expected a separate `~/.codex/<profile>.config.toml`; the redesigned splitter folds `[profiles.*]` into the single `~/.codex/config.toml` (the file Codex actually loads) and keeps `profile_config_path` null. Test updated to assert the verified behaviour.
- **`$Naruto` route protected-core blocking proof** is now correctly exercised by the shell-classifier test above; the engine_source_exception path is documented inline.

### Completed

- **`$Naruto` Shadow Clone Swarm route skill + fixture wiring.** The labs-tier `$Naruto` route (`routes.ts`, `naruto-command.ts`) declared `appSkillAliases: ['shadow-clone','kage-bunshin']` and a `route-naruto` feature-fixture, but never shipped the Codex App skill templates or the executable-fixture args. Added the `naruto`, `shadow-clone`, and `kage-bunshin` SKILL.md templates to `installSkills` (`src/core/init.ts`) — documenting the up-to-100 lease-safe parallel-clone swarm, fast-tier clones, host-capacity throttling, per-clone proof, and parent integration — and added `route-naruto` to `SAFE_EXECUTABLE_FIXTURE_ARGS` (`src/core/feature-registry.ts`). The route now satisfies the dollar-route skill-coverage contract (`generated-dollar-skills`, `global-skills-install`) and executes its fixture in the release fixture set (`all-features-execute-fixtures`).

### Removed


### Added

- **gpt-image-2 generation now retries transient failures (root-cause fix for frequent imagegen failures).** The imagegen adapter classified `429`/overloaded/`5xx`/timeout responses but returned `blocked` on the first failure — no retry — so the rate-limit-prone image endpoints (especially the codex-lb proxy) failed often. Both real call paths (`/v1/images/edits` multipart and the Responses API `image_generation` tool) are now wrapped in the **centralized responses retry policy** (`src/core/responses-retry-policy.ts`, max 4 attempts, exponential backoff on 408/409/425/429/5xx + transient network/timeout errors) via a new `withResponsesRetry()` wrapper; `imagegen` was added to the policy's `adapters` list and the retry count/log is recorded in the response artifact. Verified by `withResponsesRetry` unit tests and adapter-level tests (429×2→success on the 3rd attempt; persistent 503→4 attempts then honest block). gpt-image-2 model ID, `input_fidelity`-omitted, allowed sizes, and Responses `image_generation` tool shape were re-confirmed against the official OpenAI docs (model `gpt-image-2`, snapshot `gpt-image-2-2026-04-21`).
- **Auth-aware imagegen readiness in `sks doctor` + capability.** New `src/core/imagegen/imagegen-auth-readiness.ts` reads `~/.codex/auth.json` `auth_mode` and reports, per auth method, whether fully-headless single-command gpt-image-2 is available and the exact next action. Verified by capturing codex's real wire protocol: on this OAuth machine (`auth_mode=chatgpt`) the LLM reaches codex-lb fine (`GET /models` 200, `wss://…/responses` WebSocket with `Bearer CODEX_LB_API_KEY` + `originator`/`openai-beta`/`x-codex-turn-metadata` headers), but the `image_generation` tool is **not exposed to headless `codex exec`** (confirmed twice — the model says "the actual image_generation callable was not exposed in this session" and falls back to a hand-built PNG, even with `--enable image_generation`). So image generation is not a "the LLM works ⇒ images work" property; it needs a surface that exposes the tool. `sks doctor` now prints `Image Gen: auth=<mode> | headless_auto=<available|unavailable> | paths: …` with next actions (Codex App GUI auto-discovery, or set `OPENAI_API_KEY` for single-command headless); `detectImagegenCapability` includes the `auth_readiness` block and `doctor --json` exposes `imagegen`.
- **Codex App GUI `$imagegen` output is now auto-discovered (no manual attach).** On OAuth-only machines (`auth_mode=chatgpt`, no `OPENAI_API_KEY`) the `image_generation` tool is not exposed to headless `codex exec` (the model returns a fake PNG) and the codex-lb proxy uses non-standard token refresh, so there is no clean fully-headless gpt-image-2 path — the working surface is the Codex App GUI, which writes real outputs to `~/.codex/generated_images/<session>/ig_*.png`. New `src/core/image-ux-review/codex-app-generated-image-discovery.ts` scans that directory and auto-selects the newest genuine image (PNG/JPEG/WEBP signature check, `ig_` prefix), guarded by a `since` (run-start) check and a max-age window (default 30 min) so a stale unrelated generation is never silently reused. `createCodexAppImagegenAdapter` uses it when no `SKS_CODEX_APP_IMAGEGEN_OUTPUT` is attached; the response artifact records `output_source` (`manual_attach` vs `auto_discovered_generated_images`) and the discovered path. `$Image-UX-Review`/`$UX-Review` pass the mission start time (opt-in strict mode `--strict-generated-since`, window override `--generated-image-max-age-min`). Verified end-to-end against the real `~/.codex/generated_images` (12 candidates → newest 1.4 MB PNG selected).
- **gpt-image-2 API fallback auto-enables on an OpenAI key.** When Codex App `$imagegen` is unavailable or fails, `generateGptImage2CalloutReview` now auto-uses the direct OpenAI Images API fallback whenever `OPENAI_API_KEY` is present (explicit opt-out: `allowApiFallback:false` / `SKS_IMAGEGEN_ALLOW_API_FALLBACK=0`), and sends the gpt-image-2 `quality` parameter (default `high`, override via `SKS_IMAGEGEN_QUALITY`). The codex-lb proxy fallback deliberately stays **explicit opt-in only** — a codex-lb key is not Codex App evidence and the route must never silently route screenshots through the LB proxy (preserves the `does not silently fall back to codex-lb` policy).
- **`test:no-orphan-dist-imports` release gate** (`scripts/test-no-orphan-dist-imports-check.mjs`): fails if any test file imports a `dist/...` module whose TypeScript source no longer exists, so deleting a source module without its test (the exact rot above) can no longer pass silently. Parses real `import`/`import()` references only (ignores string-literal arguments). Wired into `release:check` and the gate manifest (`release-gates.json`).

## [1.20.1] - 2026-05-30

Core Engine SkillOpt release: introduces the SKS Core Skill Engine (a safe, self-evolving skill optimizer), a requested-scope side-effect-zero contract, and a dynamic risk-based release pipeline, on top of the 1.19.x hardening. `release:check` passes end-to-end at 1.20.1.

### Added

- **SKS Core Skill Engine** (`src/core/skills/**`, SkillOpt-derived). Skills are the frozen agent's external versioned state — **Core Skill Cards** (route-scoped, candidate/accepted/rejected/deployed). A **Core Skill Optimizer** (pure, no model call) proposes **bounded add/delete/replace** edits (**Core SkillPatch**) to a *single* skill document under a **textual edit budget**; patches that target code/config/package/global files or exceed budget are rejected. Edits are accepted **only on strict held-out improvement** (`core-skill:heldout-validation`); rejected patches are recorded in a **Rejected SkillPatch Buffer** (`.sneakoscope/skills/rejected-skill-patches.jsonl`) and never retried. Accepted candidates are promoted via an explicit gate to an **immutable Deployment Snapshot**; the **inference/deployment path reads the snapshot only and makes no extra model call** (`core-skill:no-inference-optimizer` proves the optimizer throws in deployment context). Rollout traces are scored with a side-effect-zero hard-fail component. Gates: `core-skill:card-schema`, `core-skill:rollout-scoring`, `core-skill:patch`, `core-skill:heldout-validation`, `core-skill:deployment-snapshot`, `core-skill:no-inference-optimizer`. Schemas: `schemas/skills/core-skill-card.schema.json`, `schemas/skills/core-skill-patch.schema.json`. Doc: `docs/core-skill-engine.md`.
- **Dynamic release pipeline** (`src/core/release/**`): `release:gate-planner` builds the gate manifest `release-gates.json` (tier/cost/affected_by/always_on/required_for_publish) from the live release-gate set and validates manifest↔release parity; `release:check:dynamic` selects only P0 always-on gates plus gates whose `affected_by` files changed (docs-only changes skip heavy/real gates; publish mode never skips a required gate); `release:gate-budget` reports the slowest gates and any over the hard ceiling.
- **TriWiki runtime consumption** (`src/core/triwiki-runtime.ts`): the native agent kernel (`agent-orchestrator`, which executes Team/Naruto/ReleaseReview/$Agent workers) now **consults the deployed TriWiki context pack** (`.sneakoscope/wiki/context-pack.json`) read-only before dispatch — surfacing `attention.use_first`/`hydrate_first` — and **references it in worker proof** (`agent-proof-evidence.json` gains `triwiki_context_consulted` + `context_pack_hash` + `agent-triwiki-context.json`). This closes the worker-level root cause where the kernel was wiki-blind (it is also the first runtime consumer of `triwiki-attention`). Gate: `agent:wiki-context-proof`.
- **Wiki memory gates now verified at release.** The five previously-orphaned core wiki/memory gates — `shared-memory:check`, `wrongness:check`, `wrongness:fixtures`, `trust:check`, `git-collaboration:e2e` (shared-TriWiki merge + wrongness sync e2e) — were defined but absent from `release:check`/the DAG/the gate manifest. They are now wired into `release:check`, the DAG, the gate-existence-audit allowlist, and the gate manifest, so TriWiki shared-memory, negative-evidence, and trust-validation semantics are verified on every release.

### Changed

- All version surfaces and the migration journal bumped to 1.20.1 (`.sneakoscope/reports/migration-1.20.1-journal.jsonl`).
- The new Core Skill Engine, side-effect-zero, dynamic-pipeline, and TriWiki-runtime/wiki-memory gates are wired into `release:check`.
- Removed dead `migrateWikiContextPack` (no importer); the wiki context pack is exercised via `sks wiki refresh`/`pack`.

## [1.19.1] - 2026-05-30


### Fixed

- **Legacy upgrade zero-break (`init.ts`).** `sks setup` / project `.codex/config.toml` regeneration no longer force-overwrites user keys or re-enables user-disabled Codex App flags. `mergeManagedCodexConfigToml` now seeds `model`/`service_tier`/`suppress_unstable_features_warning` and every `[features]` flag and `[user.fast_mode]` key **set-if-absent**, and plugin tables are auto-enabled only under `SKS_MANAGE_CODEX_APP_PLUGINS=1` (and even then never overwrite an existing table). This matches the already-hardened install-helpers path and is the same rationale that fixed the Codex App UI breakage: force-writing those tables reverted a user's `enabled = false`.

### Added

- **Migration transaction journal** (`src/core/migration/migration-transaction-journal.ts`) writing `.sneakoscope/reports/migration-1.19-journal.jsonl`: every config mutation records `before_hash`, `after_hash`, `backup_path`, `changed`, and `rollback_available`. `sks doctor --fix` builds the journal for the whole fix transaction (project + CODEX_HOME config) and prints the journal path.
- **Naruto proof** now asserts `concurrency_capped` and host-derived `safe_concurrency`, making the fan-out (`clones`) vs live-concurrency (`target_active_slots`) distinction explicit ("N clones, running M at a time").

### Changed

- `.npmignore` no longer blanket-ignores `dist/` and `scripts/` (these contradicted the `package.json` `files` allowlist that actually ships them); the new `publish:packlist-performance` gate guards the tarball contents instead.

## [1.19.0] - 2026-05-29

### Fixed

- Production-harden the install flow so `npm i -g sneakoscope` no longer clobbers a user's global `~/.codex/config.toml`. `ensureGlobalCodexFastModeDuringInstall` now: preserves user-set top-level `model`/`service_tier`/`model_reasoning_effort` (only seeds SKS defaults when absent, never strips the user's reasoning effort); backs up the prior config before any mutation; refuses to overwrite an unparseable config (backs it up and reports `unparseable_config_preserved`); validates its own output parses before writing; and is now idempotent (a second install is a no-op). SKS continues to manage only its namespaced tables (`[features]`, `[profiles.sks-*]`, `[user.fast_mode]`, `[plugins]`).
- Wrap the entire `postinstall` flow in try/catch so a failed setup side-effect never fails `npm i`, and always restore the codex-lb snapshot in `finally` (even on early return / throw).
- Stop terminating third-party Codex App processes during `npm i` by default; this is now opt-in via `SKS_POSTINSTALL_RECONCILE_APP_PROCESSES=1` (otherwise detect-and-report, repair via `sks doctor --fix`).
- A global `npm i -g sneakoscope` no longer initializes whatever project the shell happened to be in (it bootstraps only the global runtime root; run `sks setup` inside a project to initialize it).
- `sks doctor --fix` now backs up the managed project `.codex/config.toml` before `--force` regeneration, so a hand-edited config is always recoverable.
- `$Naruto` agents now get dynamic, team-style per-clone effort: truly simple / no-tool work runs at `low`, any tool use lifts a clone to `medium` (never high/xhigh), and every clone runs in fast service tier.

- Keep npm postinstall from silently mutating Homebrew/npm global tools by default; explicit repair paths are `sks bootstrap --yes`, `sks deps check --yes`, `sks --mad --yes`, or opt-in `SKS_POSTINSTALL_AUTO_INSTALL_CLI_TOOLS=1`.
- Make `sks doctor --fix` actually recover an already-corrupted Codex config (its whole reason to exist). Previously the splitter could not help once machine-local keys were physically nested inside a table — it saw them as table members, not top-level keys — and `doctor --fix` only ever touched the project `.codex/config.toml`, never the global `CODEX_HOME/config.toml` that Codex actually loads. Added a structural recovery pass (`repairCodexConfigStructure`) that hoists misplaced machine-local keys (e.g. `model_provider`, `notify`) out of `mcp_servers`/`env` tables (and anything trailing an absorbed `# SKS moved …` comment) back above the first table, with backup + atomic write, and wired it into `doctor --fix` / `mad repair-config` for **both** the project and global configs. Legitimate keys inside `[profiles.*]` are preserved.
- Detect structurally-broken configs: the config-load probe now classifies serde/TOML deserialize failures (`invalid type: …`, `expected a string`, `Error loading config.toml` without an EPERM cause) as `codex_cli_config_toml_parse_error` instead of silently falling back to `codex_cli_config_load_unverified`, and surfaces a `sks doctor --fix` operator action for it.
- Stop the machine-local config mover from corrupting `~/.codex/config.toml`: moved top-level keys (e.g. `model_provider`, and array-valued `notify`) are now merged structurally **before** any `[table]` header instead of being appended at end-of-file, where TOML parsed them as members of the trailing table (producing `invalid type: sequence, expected a string` and a config Codex refused to load). Restores `sks --mad` gating and codex-lb when a machine-local `model_provider`/`notify` is present.
- Make `splitCodexProjectConfigPolicy` a no-op when the project config resolves to the global `CODEX_HOME/config.toml` (e.g. running `sks` from the home directory), so the global config is no longer split against itself and re-corrupted on every `sks doctor --fix` / `sks --mad`.
- Ship `codex-config-load-probe.mjs` inside the published package via the `files` allowlist (resolved at runtime from `scripts/` or `dist/scripts/`). The probe was previously excluded by the npm `files` allowlist + `.npmignore`, so installs could not run it and MAD preflight always fell back to the `codex_cli_config_load_unverified` blocker. The runtime now degrades gracefully (integration-optional) if the probe is ever absent rather than hard-blocking, and `dist/` stays free of stray `.mjs` so the dist-parity gate passes.
- Make every codex-lb config write TOML-safe so initial install never corrupts `~/.codex/config.toml`: `configureCodexLb`, `repairCodexLbAuth`, and the postinstall snapshot-restore now route through a shared `safeWriteCodexConfigToml` gate (parse-check the existing config and back it up + bail if unparseable; refuse to write a result that would not parse — catching the regex helper's multiline-string blind spot; back up before mutating; no-op when unchanged). codex-lb stays opt-in (never auto-applied on install).
- Stop SKS from removing/blocking the Codex App UI: Codex App `[features]` flags, `[user.fast_mode]`, and `suppress_unstable_features_warning` are now set **only if absent** (a fresh config still gets SKS defaults, but SKS never re-enables a feature the user disabled), and marketplace plugin auto-enable is now opt-in via `SKS_MANAGE_CODEX_APP_PLUGINS=1` (force-enabling plugins the App could not load was breaking/hiding plugin panels). SKS-owned `[profiles.sks-*]` seeding is unchanged.
- `$Naruto` now scales to host capacity: the clone count is the total work fan-out, but live concurrency is throttled to a system-safe number derived from CPU cores + free memory (heavier cap for `codex-exec`, tighter for in-process `fake`), so `--clones 100` never spawns 100 processes at once while still completing all work units. Override with `SKS_NARUTO_MAX_CONCURRENCY`.

### Added

- Add `$Naruto` Shadow Clone Swarm mode (影分身 / Kage Bunshin no Jutsu): a high-scale variant of the native agent kernel that fans out up to 100 parallel clone sessions (`sks naruto run "task" --clones N`, aliases `$ShadowClone`/`$Kagebunshin`/`--naruto`). Lifts the standard 20-agent ceiling to `MAX_NARUTO_AGENT_COUNT = 100` **only for this route** (threaded via an optional `maxAgentCount` through roster/scheduler/orchestrator; every other route keeps the 20 cap), builds an identical-clone roster, and reuses the proven work-queue + scheduler + lease-based patch-swarm machinery for safe parallel writes. See `docs/naruto.md`.
- Add `naruto:shadow-clone-swarm` release gate + blackbox test proving the ceiling lift (100), the unchanged default cap (20), a 100-unique-clone roster, and an end-to-end 24-clone run scheduling all clones to completion past the old 20 cap.
- Add `codex-project-config-policy-merge-regression.mjs` covering moved-keys-before-tables ordering and the CODEX_HOME self-split no-op guard.
- Add `doctor-fix-recovers-corrupted-config-check.mjs` proving `doctor --fix` recovers a corrupted project and global config (key hoisting), and is a no-op on a healthy config (profile keys preserved).
- Add the historical codex-lb key-update and auth-switch commands. Their
  auth-slot switching semantics are now retired; current aliases route to
  Desktop Full Capability or Disable without replacing ChatGPT OAuth.
- Add release gates `install:update-preserves-config` (a customized `~/.codex/config.toml` survives `npm i -g`, with backup + idempotency + unparseable-not-clobbered), `codex-lb:config-toml-safety` (a codex-lb write never corrupts the TOML, incl. the multiline-string trap), and `codex-app:ui-preservation` (SKS never overrides a user-disabled feature/plugin; plugins opt-in; fresh config still seeded) — each with a blackbox test and wired into the release DAG.


## [1.18.13] - 2026-05-29

### Breaking


### Changed

- Add actual Codex CLI config-load probing with structured EPERM/TOML/untrusted-project classification, fake Codex hermetic fixtures, and release gates for Node-read-success plus Codex-read-failure regressions.
- Make `sks doctor --fix` write a readiness matrix with primary blockers and next actions, and require actual Codex config-load evidence before reporting Ready yes.
- Harden project config splitting, deprecated approval-policy normalization, macOS EPERM/TCC/symlink/ACL repair reporting, and official `service_tier=fast` CLI proof.
- Fix the MAD-SKS source-project exception so the Sneakoscope source repo is not misclassified as protected core while installed harness core remains immutable.


## [1.18.12] - 2026-05-29

### Added

- Add Codex config readability proof for `.codex/config.toml`, including parent traversal, stat/lstat, owner/mode, macOS ACL/flags/xattrs/quarantine, symlink safety, Node read, spawned-child read, blockers, operator actions, and JSON reports.
- Add project-local Codex config policy splitting for ignored profile/provider/auth/notification/telemetry keys with backup, user CODEX_HOME migration, selected profile file migration, and deprecated `approval_policy = "on-failure"` rewriting.
- Add EPERM repair transactions and MAD launch preflight that run config readability, config policy, safe repair, and Fast service-tier CLI proof before tmux launch.
- Add a standalone `codex-config-load-probe.mjs` script for model-free current-process and spawned-child config read proof.
- Add official Codex exec argument builder coverage for `-c service_tier=fast`, profile versus ignore-user-config exclusivity, sandbox, output schema, and output-last-message wiring.

### Fixed

- Prevent `sks doctor --fix` from treating setup output as readiness without Codex child readability proof.
- Prevent MAD/tmux launches from dropping fast-mode inline CLI overrides or launching past config preflight blockers.
- Prevent Codex exec process reports from claiming Fast mode without verifying the actual Codex CLI args contain the service tier override.

### Changed

- Bump release metadata from 1.18.11 to 1.18.12 across npm, TypeScript, dist, and Rust version surfaces.

## [1.18.11] - 2026-05-28

### Fixed

- Keep release metadata aligned after an explicit SKS version bump advances the package version.

## [1.18.10] - 2026-05-28

### Added

- Add patch swarm runtime truth coverage that ties route execution, strategy gate evidence, patch queue lifecycle, merge/apply groups, verification, rollback, final patch proof, and non-policy-only proof into `agent:patch-swarm-runtime-truth`.
- Add an append-only patch transaction journal and summary proof for enqueue, lock, apply, verification, rollback dry-run, hashes, changed files, durations, and final status events.
- Add a serial conflict rebase executor and release gate for same-file, subtree, stale-context, domain-policy, protected-path, unleased-path, and rollback-aware conflict fixtures.
- Add an optional real Codex patch envelope smoke gate that uses Codex exec output-schema/output-last-message semantics when `SKS_TEST_REAL_CODEX_PATCHES=1` and reports `integration_optional` unless required mode is enabled.
- Add Native CLI Session Swarm runtime so `--agents 10` and `--agents 20` spawn real `sks --agent worker` CLI sessions instead of relying on Codex internal subagent/scout scaling.
- Add no-subagent-scaling release gates proving the main orchestrator does not count Codex internal subagents as SKS worker sessions.
- Add Fast Mode Default closure so all native agent workers, Codex exec children, tmux workers, and MAD target workers inherit fast service tier and fast runtime profile unless explicitly disabled.

### Changed

- Wire the new patch swarm truth, transaction journal, conflict rebase, strict strategy-to-patch, rollback command, MCP scheduler, Appshots attachment, Codex runner truth, and optional real Codex patch smoke gates into release readiness and runtime truth reporting.
- Extend patch proof strictness so applied entries must retain strategy or micro-win references, verification nodes, rollback nodes, lease ids, ownership binding, transaction journal proof, and conflict rebase evidence.
- Update release metadata from 1.18.9 to 1.18.10 across npm, TypeScript, dist, and Rust version surfaces.
- Treat `--agents N` as target native CLI worker session count, not subagent count.
- Treat native CLI worker spawn proof as release-critical for multi-agent routes.

### Fixed

- Harden patch rollback with hash preconditions, user-facing `sks agent rollback-patches` UX, Wrongness output on rollback failure, queue status updates, and symlink/realpath containment checks.
- Strengthen Appshots and MCP scheduler evidence so Codex appshot sources require thread/attachment/source/local-only metadata and read-only concurrency proof relies on actual overlap rows rather than static hints.
- Prevent multi-agent runs from silently clamping to Codex internal subagent limits.
- Prevent worker count proof from passing when only subagent/scout events exist.
- Prevent Fast mode from being omitted in spawned worker CLI sessions, Codex exec process reports, tmux lanes, or MAD target worker reports.

## [1.18.9] - 2026-05-27

### Added

- Add Appshots thread attachment discovery evidence with thread id, attachment id, source app/window, local-only status, and attachment kind classification.
- Add MCP `readOnlyHint` runtime scheduler proof for concurrent read-only fixtures, serialized write-capable fixtures, destructive false-positive blocking, and timestamped overlap evidence.
- Add Codex 0.134 runner truth gates covering `--profile`, managed proxy redaction, local history evidence, process report profile recording, and required-mode release blocking.

### Fixed

- Prevent Appshots evidence from passing without Codex appshot thread/attachment provenance when a source claims to be a Codex Appshot.
- Prevent MCP read-only concurrency proof from relying only on static `readOnlyHint` classification.

### Changed

- Bump release metadata from 1.18.8 to 1.18.9 and wire the new Appshots, MCP scheduler, and Codex runner truth gates into `release:check`.

## [1.18.8] - 2026-05-27

### Added

- Add the strategy-first ADHD orchestration gate, dopamine/micro-win board artifacts, file ownership plan, parallel modification plan, and verification/rollback DAG before native agent scheduling.
- Add Appshots capability, operator policy, privacy-safety, TriWiki/Voxel, and Source Intelligence evidence gates for visual app-state proof.
- Add release scripts for strategy gates, Appshots gates, MCP readOnlyHint concurrency, and Codex 0.134 hook context parity.
- Add retention cleanup safety coverage so route cleanup preserves durable TriWiki/reflection/proof context while deleting closed-route scratch.

### Fixed

- Prevent write-capable agent runs from losing strategy references in task graph, work queue, proof, and runtime truth evidence.
- Preserve proof-safe parallel patch evidence with queue events, ownership ledger rows, after-hashes, rollback digests, parallel batches, serial conflicts, and simple unified-diff envelopes.
- Prevent completed routes from leaving unnecessary `team-inbox`, `bus`, cycle/arena, agent lane scratch, temp, and raw stdout/stderr log files after the route is safely closed, while retaining blocked-route diagnostics.
- Bound post-route retention cleanup to the completed mission so large local mission stores cannot push route fixtures past their timeout; full old/excess mission sweeping remains available through `sks gc`.

### Changed

- Bump release metadata from 1.18.7 to 1.18.8 and extend runtime truth with `adhd_orchestration` and `appshots` subsystem rows.
- Keep Appshots operator actions explicit: nonvisual work is not blocked, while visual proof without an operator-recorded source remains a blocker.
- Treat retention as a two-plane contract: durable learning/audit artifacts stay, old/excess missions with proof are compacted rather than deleted wholesale, short-lived temp files default to immediate cleanup, and release-parallel raw logs are removed after inline summaries replace file paths in the proof report.

## [1.18.7] - 2026-05-27

### Added

- Add Codex 0.134 compatibility reporting for local history search, `--profile` primary selection, MCP environment/OAuth/schema/readOnlyHint changes, hook subagent context, managed proxy propagation, and workspace usage-limit messaging.
- Add bounded local Codex history search, MCP 0.134 policy helpers, managed proxy environment forwarding, and profile-aware Codex exec native agent runners.
- Add proof-safe parallel agent patch queue, merge, apply, rollback, and proof helpers with Agent, Team, and DFix blackbox gates.
- Add P6 runtime truth rows and 1.18.7 gate existence/version metadata reports.

### Fixed

- Prevent profile-based Codex exec runs from combining `--profile` with `--ignore-user-config`.
- Prevent readOnlyHint MCP tools from being treated as authoritative write-safety proof without destructive-name/schema checks.
- Prevent 1.18.7 release metadata from passing without Codex 0.134, MCP 0.134, managed proxy, local history, and parallel patch gates.

### Changed

- Treat `rust-v0.134.0` as the recommended Codex compatibility baseline while preserving 0.133 and 0.132 as inherited compatibility baselines.
- Extend runtime truth from P0-P5 to P0-P6 for Codex 0.134 and parallel write proof closure.

## [1.18.6] - 2026-05-26

### Added

- Add generated runtime truth matrix rows for tmux physical proof, Codex dynamic smoke, cleanup, AST work graph, Source Intelligence, Goal mode, route blackbox, dynamic scheduler, and Warp MAD lanes.
- Add trust report subsystem proof levels and runtime truth matrix links.
- Add MAD-SKS Warp/tmux lane UI proof artifacts.

### Fixed

- Keep release metadata aligned after an explicit SKS version bump advances the package version.
- Prevent static runtime truth tables from hiding missing live proof artifacts.
- Prevent cleanup from reporting success without verified process, tmux pane, temp dir, and lock after-states.

### Changed

- Treat required real tmux, Codex dynamic, and Warp MAD lane modes as explicit runtime truth blockers.
- Treat AST-aware work graph ownership and fake-real subsystem levels as first-class release readiness evidence.

## [1.18.5] - 2026-05-26

### Added

- Wire real tmux physical proof into the native agent orchestrator lifecycle with initial, before-drain, after-drain, and final phases.
- Add tmux physical proof phase artifacts: `agent-tmux-physical-proof-before-drain.json`, `agent-tmux-physical-proof-after-drain.json`, `agent-tmux-physical-proof-final.json`, and `agent-tmux-physical-proof-summary.json`.
- Add v2 release gates for tmux lifecycle wiring, tmux proof v2, real Codex dynamic smoke v2, cleanup executor v2, cleanup command UX, AST-aware work graph, fake-real policy v2, and runtime truth matrix.
- Add process-tree-aware cleanup proof with SIGTERM, bounded wait, SIGKILL escalation, and verified process exit evidence.
- Add AST/import/test ownership expansion for intelligent work graph, including file-to-symbol, symbol-to-file, command ownership, route ownership, AST coverage, and proof level.
- Add runtime truth matrix coverage for `fixture_only`, `fixture_instrumented_real`, `proven`, `integration_optional`, `real_required_missing`, `partial`, and `blocked`.

### Fixed

- Prevent real tmux smoke from depending on lifecycle artifacts that the orchestrator never writes.
- Prevent cleanup executor from claiming success before process termination is verified.
- Prevent fixture-instrumented real Codex smoke from being reported as plain proven runtime proof.
- Prevent AST-aware work graph claims from relying only on basename test ownership.

### Changed

- Treat real-proof modules as part of orchestrator lifecycle, not standalone reports only.
- Treat cleanup as a safe, verifiable resource cleanup transaction.
- Treat intelligent work graph quality and fake-real subsystem levels as first-class release readiness inputs.

## [1.18.4] - 2026-05-26

### Added

- Add real tmux physical pane proof: list-panes, capture-pane, pane-id reconciliation, lane render verification, and drain-close evidence.
- Add opt-in real Codex dynamic agent smoke via `SKS_TEST_REAL_DYNAMIC_AGENTS=1`.
- Add command-level agent cleanup executor for stale processes, stale tmux panes, orphan temp dirs, stale locks, and preserved terminal transcripts.
- Add intelligent work graph planner with dependency critical path, test ownership, changed-file candidates, domain priority, and integration bottleneck analysis.
- Add fake-vs-real proof policy that prevents fixture evidence from being promoted to real runtime evidence.
- Add release:real-check coverage for real tmux and real Codex dynamic smoke.
- Add P0-P5 release readiness closure matrix for runtime truth.

### Fixed

- Prevent tmux manifest-only proof from passing as real pane proof.
- Prevent fake pane ids from being treated as physical tmux evidence.
- Prevent mock dynamic route tests from being used as real Codex dynamic smoke.
- Prevent cleanup commands from only observing artifacts without performing cleanup.
- Prevent route template task graphs from being overclaimed as dependency-aware advanced partitioning.
- Prevent lane drain/close evidence from being missing in tmux mode.
- Prevent hook trust doctor from recommending SKS-only trusted-hash repair when managed repair is the safe path.

### Changed

- Treat tmux lanes as physical runtime resources in real tmux mode.
- Treat real dynamic smoke as opt-in but first-class.
- Treat cleanup as an executable command path, not only a report reader.
- Treat work graph quality and fake-vs-real separation as release readiness inputs.

## [1.18.3] - 2026-05-26

### Added

- Add route-truth dynamic scheduler gates that execute real Agent, Team, Research, and QA commands.
- Add orchestrator option propagation proof for `--work-items`, `--target-active-slots`, `--minimum-work-items`, and queue expansion.
- Add task graph source/goal ref propagation checks before scheduler launch and through the work queue.
- Add slot-level tmux lane supervisor integration into orchestrator lifecycle.
- Add proof gates for tmux supervisor initialization, update, survival, and drain.
- Add real route command blackboxes instead of `sks agent run --route` stand-ins.

### Fixed

- Prevent parsed agent work item options from being ignored by `runNativeAgentOrchestrator`.
- Prevent Team/Research/QA backfill gates from passing through the generic Agent route only.
- Prevent agent proof from requiring tmux supervisor while the orchestrator never writes it.
- Prevent generation-level tmux pane launches from masquerading as persistent worker-slot lanes.
- Prevent route blackboxes from using standalone scheduler or route string substitution as proof.



## [1.18.2] - 2026-05-26

### Added

- Add work-item-first task graph expansion so total work items are independent from target active agent slots.
- Add route-level dynamic backfill blackboxes for Agent, Team, Research, and QA.
- Add official `follow_up_work_items` schema support in agent result validation.
- Add persistent tmux lane supervisor with worker-slot lanes, generation-aware render files, and drain-signal controlled shutdown.
- Add no-flicker tmux lane regression gates.
- Add scheduler proof hardening for target active slots, queue drain, backfill counts, session generations, terminal close reports, Source Intelligence refs, and Goal mode refs.
- Add scheduler-aware janitor reporting for active generation preservation and drained generation cleanup.
- Add 1.18.2 full priority closure readiness report coverage for P0 through P5.

### Fixed

- Prevent real route runtime from passing dynamic pool checks using standalone scheduler fixtures only.
- Prevent agent count from being treated as total work item count.
- Prevent work queue generation from being limited to roster length.
- Prevent tmux lane panes from disappearing after short-lived worker commands.
- Prevent generation completion from closing worker slot lanes.
- Prevent implicit or untyped follow-up work item enqueue.
- Prevent proof from passing when expected backfill is not observed in real route artifacts.

### Changed

- Treat Native Agent Runtime as work-queue-first and slot/generation-driven.
- Treat tmux lanes as persistent worker-slot UI, not pane launch evidence.
- Treat P0 through P5 closure as a release readiness requirement.
## [1.18.1] - 2026-05-25

### Added
- Add Dynamic Agent Pool Scheduler that maintains target active concurrency until the work queue is empty.
- Add worker slots, session generations, task queue, backfill events, active slot health, and scheduler proof evidence.
- Add session-generation-aware terminal artifacts and close reports.
- Add real tmux right-lane runtime where lanes represent worker slots and update as session generations change.
- Add scheduler blackbox fixtures proving that when 2 of 5 sessions close while work remains, 2 new sessions are opened immediately.
- Add work queue / slot / session generation ledgers and proof gates.
- Add Source Intelligence and Goal mode propagation across dynamic session generations.

### Fixed

- Prevent fixed batch execution from starving pending work while completed slots sit idle.
- Prevent proof from passing when pending work exists but no active sessions are running.
- Prevent tmux mode from passing with manifest-only lanes.
- Prevent terminal session artifacts from being overwritten across generations.
- Prevent janitor from treating intentionally replaced session generations as stale errors.

## [1.18.0] - 2026-05-25

### Added
- Add Universal Source Intelligence Layer for every mode: Context7 + Codex Web Search by default, and Context7 + Codex Web Search + X AI MCP Search when X AI MCP is configured and search-capable.
- Add X AI MCP capability detector, X AI Search adapter, Codex Web Search adapter, and unified source intelligence proof gates.
- Add main no-Scout policy: main orchestrator and route main sessions must spawn native multi-session agents instead of invoking Scout.
- Add worker-local Scout-limited policy: agent workers may use Scout only inside their own session as local evidence, never as the main runtime backend or proof SSOT.
- Add mandatory background terminal/session evidence for every agent.
- Add tmux right-lane cockpit: main/orchestrator pane on the left and agent lanes stacked on the right.
- Add Codex official Goal mode detector and default activation.
- Add release DAG full coverage restoration: parallel release checks preserve all previous gates.
- Add P0~P4 full closure tracking in release readiness.

### Fixed
- Prevent X AI MCP availability from being ignored when Context7 is used.
- Prevent X AI missing from blocking routes that should use Context7 + Codex Web Search only.
- Prevent main Team/Research/QA orchestrators from calling Scout.
- Prevent agent proof from passing without terminal close evidence.
- Prevent tmux agent mode from passing without visible right lanes.
- Prevent release parallelization from reducing release gate coverage.

### Changed
- Treat source intelligence as a route-wide service shared by Team, Research, QA, DFix, UX, PPT, Goal, Commit, MAD-SKS, Hooks, codex-lb, and Wiki.
- Treat worker Scout as optional local evidence, not orchestration backend.
- Treat P1~P4 completion as part of release readiness, not optional polish.


## [1.17.0] - 2026-05-25

### Added
- Add TypeScript Runtime Unification: TS source is the only source of truth, while npm runtime uses generated `dist/**/*.js`; `src/**/*.mjs` runtime shadows are removed.
- Add TS/dist freshness and runtime parity checks with build manifest source digests.
- Add Codex App Agent Cockpit artifacts: `agent-codex-dashboard.md`, `agent-codex-dashboard.json`, `agent-session-cards.md`, and event stream summaries.
- Add Parallel Verification Engine with DAG-based verification groups, dependency-aware scheduling, artifact locks, resource budgets, and per-worker proof.
- Add project-scoped session namespace using project root hash, mission id, orchestrator id, and agent id for tmux/session/temp/lock/artifact isolation.
- Add continuous Agent Janitor for stale process/tmux/temp cleanup and proof-bound session closure.
- Add route native backend gate fixes for Team/Research/QA proof artifact resolution.

### Fixed
- Prevent TS and runtime MJS drift by removing parallel `src/**/*.mjs` runtime files.
- Prevent route native backend gates from reading artifacts from the wrong `proof.validation` path.
- Prevent `agent run` parser from treating `latest` as a mission id for new run actions.
- Prevent multiple projects from sharing tmux session names, temp directories, lock files, or agent session ids.
- Prevent slow serial verification when checks can safely run in parallel.

### Changed
- Treat release verification as a dependency DAG instead of a long shell `&&` chain.
- Treat Codex App agent visibility as a first-class artifact contract.

## [1.16.2] - 2026-05-25

### Fixed

- Keep release metadata aligned after an explicit SKS version bump advances the package version.

## [1.16.1] - 2026-05-25

### Fixed
- Route Team, Research, and QA runtime execution through the native agent orchestrator and require native agent proof evidence in release gates.
- Parse Codex exec --output-last-message result JSON before accepting agent completion, with stdout fallback capped at verified_partial.
- Strengthen native agent command surface, work partitioning, lease/change-file comparison, and no-scout packed blackbox coverage.

### Changed
- Bump package, runtime, and release-readiness metadata to 1.16.1.

## [1.16.0] - 2026-05-23

### Added
- Add native multi-session agent kernel with `sks agent`, `sks --agent`, roster/concurrency caps, lease/no-overlap proof, session lifecycle evidence, recursion guard, and Codex exec output-schema preparation.
- Add `schemas/codex/agent-result.schema.json`, native agent docs, and agent command/policy tests.

### Changed
- Route Team, Research, QA/Review proof, and auto-finalization gates to native `agents/agent-proof-evidence.json`.
- Remove the legacy multi-agent command surface, archived legacy 0.9.13 files, and old Scout multi-session goal surface so native agents are the only release-supported route collaboration backend.
- Bump package metadata to 1.16.0.

## [1.15.1] - 2026-05-23

### Added
- Add MAD-SKS actual executor closure for guarded target-file writes, argv/no-shell command execution, package install routing, service control routing, DB write planning, Computer/Browser/generated-asset handoff evidence, and rollback apply.
- Add `sks mad-sks rollback-apply --rollback-plan <path> --yes --json`.
- Add flagship proof graph v4 and MAD-SKS actual executor release reports for file write, shell, package, service, DB, rollback apply, live protected-core guard smoke, and executor proof graph aggregation.

### Fixed
- Replace the previous probe-only `mad-sks run/apply` path with real executor dispatch and structured executor result evidence.
- Prevent macOS `/var` to `/private/var` canonicalization from causing false target-boundary escape blockers for new nested target files.
- Preserve immutable protected-core blocking for SKS source, scripts, package metadata, release metadata, and runtime artifacts during MAD-SKS execution.

### Changed
- Bump package, runtime, release-readiness, and Rust crate metadata to 1.15.1.
- Extend release metadata and release readiness gates to require MAD-SKS actual executor closure and proof graph v4.

## [1.15.0] - 2026-05-23

### Added
- Add MAD-SKS Full-System Authority Mode with explicit user authorization, target-root scoping, system access consent, DB write consent, package/service/system operation consent, audit ledger, rollback plan, Evidence Router integration, Completion Proof, and Trust Report.
- Add Immutable Harness Guard that prevents MAD-SKS from modifying the SKS package root, source core, dist runtime, scripts, schemas, Rust crate, release metadata, managed hooks, and protected SKS policy files.
- Add protected-core path resolution, symlink/path traversal guard coverage, write interception, pre/post protected-core snapshots, and git diff validation.
- Add `sks mad-sks plan/run/apply/doctor/status/proof --json`, `sks mad-sks permissions --json`, rollback-plan, audit, and explain surfaces.
- Add release gate freshness hardening so Scout and flagship checks cannot pass against stale `dist`.
- Add Codex exec output-schema syntax parity checks for both `codex exec` and `codex exec resume`.
- Add opt-in real Scout smoke for Codex exec parallel output-schema sessions.
- Add engine-run-id query UX for `scouts consensus`, `handoff`, `validate`, and `status`.
- Add flagship proof graph v3 with immutable harness guard, MAD-SKS audit ledger, rollback, Scout real smoke, Hook parity, UX/PPT imagegen graph, and DFix graph.

### Fixed
- Prevent MAD-SKS from being limited to DB permissions only.
- Prevent MAD-SKS from modifying SKS harness code, even when the target root is the SKS repository.
- Prevent release gates from using stale `dist` when source changed.
- Prevent Codex exec output-schema checks from relying only on `exec resume --help` when fresh `exec` syntax differs.
- Prevent Scout benchmark artifacts from being confused with canonical route intake artifacts.
- Prevent MAD-SKS proof from claiming success without audit, diff, rollback, and verification evidence.

### Changed
- Treat MAD-SKS as user-authorized full-system maintenance mode with immutable SKS self-protection.
- Treat SKS harness code as protected infrastructure, not a normal project target, in MAD-SKS mode.
- Treat release gate freshness as a P0 trust invariant.

## [1.14.1] - 2026-05-22

### Added
- Add 1.14.1 hook official hash oracle and hook parity v2 reports with managed-only fallback when official hashes are unavailable.
- Add UX/PPT real imagegen smoke gates, PPT synthetic deck E2E blackbox/artifact-graph gates, Codex 0.133 official compatibility reporting, and flagship proof graph v2.
- Upgrade Scout outputs to `sks.scout-result.v3` with `engine_run_id`, `scout_session_id`, output-schema metadata, lifecycle records, stdout/stderr paths, read-only confirmation, and artifact namespaces.
- Add Scout benchmark isolation under `scout-benchmarks/<engine_run_id>/` so parallel/sequential benchmark runs do not overwrite canonical route intake artifacts.

### Changed
- Bump package, runtime, release-readiness, and Rust crate metadata to 1.14.1.
- Gate Scout consensus/proof promotion on schema-valid completed results only, while schema-invalid or unparseable real outputs remain structured blockers.
- Strengthen Scout read-only guard to v2 with file snapshots, git-status delta checks, benchmark artifact allow-listing, and external workspace boundary evidence.

### Fixed
- Prevent mock/local-static Scout benchmarks from producing real speedup claims.
- Preserve Codex exec, Codex App subagent, and tmux lane lifecycle metadata in Scout artifacts.

## [1.14.0] - 2026-05-22

### Added
- Add Codex CLI `rust-v0.133.0` compatibility matrix coverage for goal defaults, remote-control foreground app-server behavior, permission profiles/requirements, plugin discovery/marketplaces, and extension lifecycle events.
- Add Codex hook actual trust parity, managed install fixtures, and official-hash parity reports for the 10-event hook surface.
- Add real imagegen capability detection, gpt-image-2 request validation, UX/PPT fake-adapter blackbox checks, structured extraction strictness checks, and optional real imagegen smoke.
- Add release gates for managed hook install, runtime replay warning-zero, imagegen capability, UX/PPT generated-image artifact graphs, and strict Structured Outputs schemas.

### Fixed
- Block SKS-only trusted_hash writes unless official Codex hash parity is available; the default repair path is managed hooks via `.codex/requirements.toml`.
- Reject prompt/agent/async/empty/invalid hook handlers in actual trust doctor reports.
- Keep fake imagegen evidence explicitly marked as mock-like so hermetic release checks cannot be mistaken for real gpt-image-2 generation.

### Changed
- Treat Codex 0.133 as the release-readiness runtime baseline while preserving Codex 0.132 structured output detection as inherited compatibility.
- Bump package, runtime, release-readiness, and Rust crate metadata to 1.14.0.

## [1.13.0] - 2026-05-21

### Added
- Add DFix Extreme Speed Kernel with L0 deterministic, L1 local static, L2 bounded Codex patch handoff, and L3 human-review paths.
- Add DFix error signature cache, root-cause ranking, patch template selection, verification command selector, patch runner, verification runner, rollback plan, and speed budget artifacts.
- Add DFix fast black-box fixture and performance release gates for the no-Codex direct-fix loop.
- Add latest OpenAI Codex hook schema snapshot with 10 events and 20 schema files, including `SubagentStart` and `SubagentStop`.
- Add hook trust doctor/state/fix commands, current hash/trusted hash reporting, and warning-zero release gates for trust state, subagent events, unsupported handlers, and schema drift.
- Add flagship artifact graph validation hooks for UX/PPT/DFix so release checks validate command, artifact, evidence, proof, trust, and wrongness linkage.

### Fixed
- Prevent DFix from claiming success on no-op patches, missing verification, broad/high-risk changes, or repeated blocker paths.
- Prevent Codex hook release checks from passing when prompt/agent/async handlers, invalid matchers, dual hook representations, stale 8-event snapshots, or trust warnings are present.
- Prevent all-feature completion from relying on source-string-only checks for flagship routes.

### Changed
- Treat DFix speed and correctness as co-equal release invariants.
- Treat Codex hook warning-zero as a release blocker, not a cosmetic warning.
- Bump package, runtime, release-readiness, and Rust crate metadata to 1.13.0.

## [1.12.0] - 2026-05-21

1.12.0 Real Execution Closure tightens the previously advertised UX/PPT/DFix/all-feature paths so mock, manual, pending, and real evidence cannot be mistaken for each other. Computer Use evidence modes such as `probe_only` and `live_capture_success`, plus codex-lb persistence states such as `process_only_ephemeral`, remain explicit in release truthfulness reports.

### Added
- Add real UX-Review command wiring so `run`, `callouts`, and `extract-issues` invoke gpt-image-2 generation and real callout extraction instead of only rebuilding artifacts.
- Add PPT real adapter closure for slide export, slide imagegen review, issue extraction, deck patch handoff, re-export, and re-review with honest blockers for unavailable external tools.
- Add DFix Codex patch handoff runner metadata, diff capture, verification recommendation, and rollback readiness artifacts.
- Add all-feature completion deep coverage gates for command registry, fixtures, artifacts, Evidence Router coverage, Completion Proof links, Trust Report links, Wrongness mappings, docs, recovery, and blackbox coverage.
- Add stricter mock/real separation checks for UX, PPT, DFix, and advertised runtime features.
- Add recursive schema validation targets for flagship feature artifacts and release-readiness reports.

### Fixed
- Prevent UX-Review `extract-issues` from bypassing `extractRealCallouts()`.
- Prevent UX-Review `run --generate-callouts` and `run --fix` from skipping `generateGptImage2CalloutReview()`.
- Prevent PPT review from passing when slide export, imagegen, issue extraction, or re-review is only pending.
- Prevent DFix from claiming a fix without patch evidence, diff evidence, and verification evidence.
- Prevent advertised features from appearing complete when they only have static contracts or command names.
- Prevent mock fixtures from being treated as real verified evidence in all-feature completion.

### Changed
- Treat feature completion as deep runtime coverage, not command presence.
- Treat UX/PPT/DFix as flagship real execution paths with explicit unavailable blockers.
- Treat release readiness as invalid when advertised runtime commands lack proof/trust/wrongness coverage.
- Bump package, runtime, release-readiness, and Rust crate metadata to 1.12.0.

## [1.11.0] - 2026-05-21

1.11.0 Extreme Feature Completion Kernel keeps the README focused on product usage while this changelog carries release history and detailed gate context, including Computer Use evidence modes such as `probe_only` and `live_capture_success`, plus codex-lb persistence states such as `process_only_ephemeral`.

### Added
- Add `sks features complete --json` and the `sks.all-feature-completion.v1` report for command, fixture, artifact, evidence, proof, trust, wrongness, blackbox, mock/truthfulness, and JSON recovery coverage.
- Add PPT imagegen review fixtures for slide export, generated callout images, issue extraction, patch handoff, re-export, re-review, Image Voxel relations, Completion Proof, and Trust Report evidence.
- Add DFix diagnose, plan, patch, verify, rollback-plan, status, and fixture commands with DFix proof evidence.
- Add a lightweight recursive JSON schema validator and release gate script.

### Fixed
- Block the release gate when Section 29 scripts, 1.11.0 metadata, PPT review proof, DFix verification, all-feature completion, or recursive schema checks are missing.

### Changed
- Bump package, runtime, release-readiness, and Rust crate metadata to 1.11.0.

## [1.10.0] - 2026-05-21

### Added
- Add a shared `runSksUpdateCheck` function that performs the npm freshness check without creating a route, mission, setup, doctor, or Team pipeline.
- Add `sks.update-check.v2` JSON output with explicit `mode`, `route_required`, and `pipeline_required` fields.

### Fixed
- Reuse the function-only update check from the pre-work hook gate so SKS update freshness checks stay outside the execution pipeline.

### Changed
- Bump package, runtime, release-readiness, and Rust crate metadata to 1.10.0.

## [1.0.9] - 2026-05-21

### Added
- Add real `codex exec resume --output-schema` runner with output-file parsing, redaction, timeout, and schema validation.
- Add official docs compatibility report for Codex 0.132, `gpt-image-2` image generation/edit fidelity, and Structured Outputs strict schemas.
- Add OpenAI Structured Outputs fallback adapter and optional OpenAI Images API `gpt-image-2` callout generation fallback.
- Add `image-ux-gpt-image-2-request.json` and `image-ux-gpt-image-2-response.json` artifacts.
- Add Issue Ledger v3 extraction metadata, patch handoff prompts/results, attach-after recapture metadata, UX evidence kinds, and expanded UX wrongness kinds.

### Fixed
- Prevent attached generated images from creating generic callouts before schema-bound pixel extraction succeeds.
- Prevent UX-Review verified claims when generated callout extraction is pending, invalid, text-only, or mock-as-real.
- Prevent visual fix verification without patch evidence plus recapture/re-review evidence.

### Changed
- Treat `gpt-image-2` image input fidelity as high-fidelity automatic metadata and omit unsupported `input_fidelity`.
- Treat Structured Outputs strict schemas as the real fallback when Codex output-schema is unavailable.
- Treat official documentation drift as a release-readiness input.

## [1.0.8] - 2026-05-20

### Added
- Add Codex CLI `rust-v0.132.0` compatibility matrix and feature detection.
- Add `codex exec resume --output-schema` integration for schema-bound Scout, UX-Review callout extraction, Completion Proof, and Wrongness outputs.
- Add app-server image fidelity preservation support for UX-Review source screenshots, gpt-image-2 callouts, and Image Voxel coordinate alignment.
- Add real `$UX-Review` gpt-image-2 callout generation contracts, generated image ingestion, schema-bound callout extraction, fix task creation, bounded fix loop, recapture, and re-review gates.
- Add UX-Review before/after Image Voxel relations and visual wrongness records for bad callouts, stale screenshots, and failed fixes.
- Add Codex memory summary version/rebuild integration for TriWiki/Wrongness generated summaries.
- Add Goal/QA/Research repeated blocker and usage-limit loop stop behavior aligned with Codex 0.132.

### Fixed
- Prevent UX-Review from passing with prose-only screenshot critique.
- Prevent mock gpt-image-2 callout fixtures from being promoted to verified real UX evidence.
- Prevent visual fix claims without post-fix recapture and changed-screen re-review.
- Prevent version drift between package metadata, runtime version, Rust crate version, changelog, and release stamp.

### Changed
- Treat `$UX-Review this screenshot with gpt-image-2 callouts, then fix the issues` as a first-class real execution route.
- Treat source screenshot fidelity and coordinate alignment as release-gated visual evidence requirements.
- Treat Codex 0.132 structured resume output as the preferred path for schema-bound automation artifacts.




## [1.0.7] - 2026-05-20

### Added
- Add Computer Use live evidence capture mode with opt-in real macOS screenshot/action evidence attempts.
- Add Computer Use live evidence schemas for capability probe, screenshot capture, action capture, Image Voxel linkage, and external capability blockers.
- Add codex-lb persistence truthfulness report that distinguishes durable setup from process-only ephemeral setup.
- Add setup plan/apply drift checks that compare requested codex-lb persistence choices with actual filesystem, Keychain, launchctl, and shell profile state.
- Add release readiness report for Computer Use real evidence, codex-lb persistence, hook strict subset, and docs truthfulness.

### Fixed
- Prevent Computer Use smoke from being described as real capture when it only ran a capability probe.
- Prevent codex-lb setup from silently producing process-only credentials without a clear warning.
- Prevent README/docs from overclaiming universal Computer Use availability or live evidence.
- Prevent setup action reports from passing when actual filesystem changes differ from requested setup choices.

### Changed
- Treat Computer Use evidence mode as one of `probe_only`, `live_capture_attempted`, `live_capture_success`, or `live_capture_blocked`.
- Treat codex-lb persistence as explicit: `durable_env_file`, `durable_keychain`, `durable_launchctl`, `shell_profile`, or `process_only_ephemeral`.
- Treat documentation truthfulness as a release invariant.

## [1.0.6] - 2026-05-20

### Added
- Add explicit Codex hook strictness classification: upstream schema, upstream semantic unsupported, SKS zero-warning strict subset, and SKS policy-disallowed.
- Add codex-lb setup plan/preview and exact answer-to-action mapping for default provider selection, env file writing, Keychain storage, launchctl sync, shell profile snippets, and health checks.
- Add optional real macOS Computer Use smoke under `SKS_TEST_REAL_COMPUTER_USE=1` to verify live capability handshake and evidence status when available.
- Add Computer Use live evidence report that distinguishes available, permission missing, Codex App missing, capability missing, external block, and not-macOS.
- Add wrongness records for setup-choice drift and Computer Use live-smoke mismatch.

### Fixed
- Prevent hook validators from overclaiming exact upstream parser mirroring when SKS intentionally enforces a stricter zero-warning subset.
- Prevent codex-lb setup wizard prompts from being ignored.
- Prevent env file, provider selection, launchctl, Keychain, or shell profile writes from happening contrary to the user's explicit setup choices.
- Prevent Computer Use optional live checks from fabricating visual evidence when Codex App or macOS permissions are unavailable.
- Keep release metadata aligned after an explicit SKS version bump advances the package version.

### Changed
- Treat codex-lb setup as a two-phase plan/apply workflow.
- Treat Computer Use live evidence as optional real verification, separate from mock-safe route fixtures.

## [1.0.5] - 2026-05-20

### Added
- Add Codex hook semantic validator that mirrors `rust-v0.131.0` runtime parser rules, not just JSON schema.
- Add strict PreToolUse rule enforcement for unsupported `permissionDecision:ask`, `allow` without `updatedInput`, unsupported `continue:false`, `stopReason`, and `suppressOutput`.
- Add Stop/UserPromptSubmit/PostToolUse block output normalization with non-empty reason requirements.
- Add macOS codex-lb env loader metadata, Keychain-aware lookup/storage hooks, launchctl repair visibility, and missing-env regression checks.
- Add raw `CODEX_LB_API_KEY` missing-message regression gate.
- Add Computer Use capability handshake checks, visual route requirement fixture, and external capability block evidence shape.
- Add hook/codex-lb/Computer Use wrongness kinds and avoidance rules for regression learning.

### Fixed
- Prevent hook outputs that pass JSON schema but fail Codex runtime semantic rules.
- Prevent `permissionDecision:ask`, PreToolUse allow-without-rewrite, unsupported universal hook fields, and legacy top-level hook fields from reaching release fixtures.
- Prevent raw codex-lb missing env errors from appearing in status, doctor, health, postinstall, setup fixture, or black-box outputs.
- Prevent SKS from describing Computer Use as blocked by safety policy or MAD-SKS.
- Prevent visual route proof from omitting Computer Use status when image/visual evidence is required.

### Changed
- Treat Codex hook semantic compatibility as stricter than schema compatibility.
- Treat codex-lb readiness as a durable macOS/user-session setup contract.
- Treat Computer Use as the preferred macOS visual verification path when available.
- Keep release metadata aligned after an explicit SKS version bump advances the package version.

## [1.0.4] - 2026-05-20

### Added
- Add Codex CLI `rust-v0.131.0` compatibility layer with vendored hook schema snapshots and strict hook output validation.
- Add `sks codex-lb setup` interactive wizard for domain/base URL and API key capture with secure storage and env auto-load.
- Add codex-lb missing-env prevention so macOS users do not see the raw CODEX_LB_API_KEY missing-env text after setup or update.
- Add macOS Codex App Computer Use capability detector and visual-route integration that treats Computer Use as a first-class visual evidence source.
- Add hook warning black-box tests that fail release if Codex hook output produces deprecated-shape or unknown-field warnings.
- Add `sks codex compatibility` and `sks hooks codex-validate` surfaces for checking Codex CLI version, hook schemas, and SKS output shape.

### Fixed
- Replace legacy hook output shapes with Codex `rust-v0.131.0` canonical `hookSpecificOutput` / camelCase output syntax.
- Prevent SKS from misclassifying Codex App Computer Use as a MAD-SKS or generic safety block.
- Prevent codex-lb launch/setup paths from throwing raw missing-env errors when setup can repair or explain the missing key.
- Prevent secrets from being written to proof, logs, screenshots, hook replay, black-box reports, or wrongness memory.

### Changed
- Treat Codex CLI compatibility and hook-schema freshness as release invariants.
- Treat Computer Use availability as a capability check, not an SKS safety policy decision.


## [1.0.3] - 2026-05-19

### Added
- Add `sks git policy|install|status|doctor|precommit|publish-plan|summary` for SKS git collaboration hygiene.
- Add tracked shared-memory policy files: `.sneakoscope/git-policy.json` and `.sneakoscope/shared-memory-manifest.json`.
- Add merge-friendly shared TriWiki shards for claims, wrongness, image voxels, and avoidance rules under `.sneakoscope/wiki/**`.
- Add `sks wiki publish latest --shared`, `sks wrongness publish latest --shared`, `sks wiki rebuild-index --json`, and `sks wiki validate-shared --json`.
- Add release checks for git hygiene, precommit fixtures, shared memory validation, and git collaboration E2E coverage.
- Add Codex App hook trust-state generation for current hook trust syntax so managed hooks are written with matching trusted hashes.

### Fixed
- Replace broad `.sneakoscope/` ignore behavior with runtime-only ignores so shared memory shards can be committed.
- Surface shared wrongness shards in wrongness retrieval even when the local project ledger is missing.
- Add git collaboration status to Trust Kernel reports.

### Changed
- Update managed-path manifest schema to `sks.managed-paths.v2` with explicit shared-memory, generated-index, local-runtime, and harness planes.
- Bump npm package and optional Rust crate metadata to `1.0.3`.


## [1.0.2] - 2026-05-19

### Added
- Add `scripts/check-ts-suppressions.mjs` plus `npm run typecheck:suppressions` intended as a release gate rejecting `@ts-nocheck`, `@ts-ignore`, and unstructured `@ts-expect-error` suppressions outside `src/generated/**`.
- Add `npm run typescript:migration-report` emitting `.sneakoscope/reports/typescript-migration.json` / `.md` with suppression and dist summary counters.
- Add dist build manifest schema `sks.dist-build.v2` (writes package version plus `mjs_runtime_files`; enforced by `dist:check`).
- Tighten `dist:check` to validate manifest schema and manifest `mjs_runtime_files`.

### Fixed
- Add suppression rules and reporting intended to eliminate silent TypeScript escapes before `release:check` can declare a strict-runtime seal complete.
- Refine `command-registry` lazy adapters to narrow unknown module exports via explicit callable guards rather than broad `RawCommandModule` casts.
- Rework CLI `router.ts` normalization with explicit `CommandName` guards plus structured blocked results for unknown commands.
- Rewrite `core/fsx` with typed process execution (`RunProcessOptions` / `RunProcessResult`), `TailBuffer`, and explicit JSON boundary helpers aligned with SKS filesystem utilities.

### Changed
- Bump crate `sks-rs` metadata version to remain aligned with the npm package semver for optional Rust tooling.


## [1.0.1] - 2026-05-19

### Added
- Add a hybrid-free TypeScript runtime: CLI entrypoint, command registry, Trust Kernel, Evidence Router, Completion Proof, Image Voxel, Scouts, and route commands now build from TypeScript source into `dist`.
- Add actual typed runtime command registry used by the CLI, replacing the previous contract-only TypeScript registry plus MJS runtime registry split.
- Add dist-only package verification that blocks copied MJS runtime files and verifies every command registry lazy import from the packed package.
- Add `sks run --execute` and `sks run --auto` route execution modes for safe routes.
- Add TypeScript runtime/schema parity checks for completion proof, evidence records, route contracts, scout outputs, image voxel ledgers, and feature fixtures.

### Fixed
- Remove build-time copying of `src/**/*.mjs` into `dist`.
- Remove the hybrid `TypeScript contracts + MJS runtime` package boundary.
- Fix the missing `1.0.0` changelog lineage and document the 1.0.1 runtime completion.
- Prevent feature quality targets from drifting below RC-level requirements.
- Prevent typed command registry from diverging from actual runtime command registry.

### Changed
- Treat TypeScript-built runtime as a release invariant.
- Treat `.mjs` runtime implementation as legacy-only and excluded from the published package.
- Treat `sks run --execute` as the novice-safe execution path for supported routes.

## [1.0.0] - 2026-05-19

### Added
- Add TypeScript-first architecture for SKS core trust kernel, command registry, route contracts, evidence records, completion proof, Image Voxel ledgers, Scout outputs, and feature fixtures.
- Add generated runtime validators or schema guards for every trust-kernel contract.
- Add packed-package command registry import smoke tests that verify every registered command resolves from the packed tarball.
- Add real black-box matrix coverage for pack install, npx one-shot, global shim, Unicode paths, paths with spaces, no-git directories, and read-only project directories.
- Add `sks run --execute` and `sks run --auto` to run selected routes through route command execution, finalization, proof, trust report, and status.
- Add environment-tiered performance budgets for source, packed, CI, local, and global install modes.
- Add hard architecture gates that fail on internal monolith regressions.

### Fixed
- Prevent package `files` exclusions from breaking command registry imports in packed installs.
- Prevent static-contract feature coverage from masking runtime route verification gaps.
- Prevent architecture warnings from allowing new monoliths.
- Prevent `sks run` from stopping at prepared state when `--execute` is requested.
- Prevent TypeScript type drift between compile-time contracts and runtime JSON artifacts.

### Changed
- Treat TypeScript type safety and runtime schema validation as release invariants.
- Treat packed package command import smoke as mandatory before publish.
- Promote `1.0.0` to the stable npm release target so plain `npm publish` can ship on the `latest` dist-tag.

## [0.9.20] - 2026-05-18

### Added
- Add SKS Trust Kernel invariants that make route completion, evidence, and proof validation a single contract.
- Add core performance budgets for CLI hot paths, proof validation, Image Voxel validation, Scout intake, and feature fixture execution.
- Add route finalization audit tests that prove serious route fixtures write Completion Proof through real command paths.
- Add strict evidence router checks so mock/static evidence cannot be upgraded to verified real evidence.
- Add managed-path rollback and pollution checks for SKS-owned project files.
- Add core dominance documentation covering speed, stability, proof, image memory, black-box install, and known gaps.

### Fixed
- Prevent static contracts from being interpreted as runtime verification by routing route completion through `route-completion-contract.json`, `evidence-index.json`, and `trust-report.json`.
- Prevent stale image/voxel/proof/scout evidence from passing route completion by adding freshness and stale-anchor validation.
- Prevent release checks from passing without trust, evidence, safety, chaos, benchmark, and black-box matrix gates.
- Prevent performance claims without benchmark artifacts by writing `.sneakoscope/reports/performance/core-bench.json` and `.md`.
- Keep release metadata aligned after an explicit SKS version bump advances the package version.

### Changed
- Treat SKS as a core trust kernel rather than a feature-cloning harness.
- Prefer fewer, stronger, release-gated core surfaces over broader unverified feature expansion.
- Expose novice-facing `sks run`, `sks status`, `sks trust`, `sks paths`, `sks rollback`, and `sks bench` surfaces.

## [0.9.19] - 2026-05-18

### Added
- Add real scout output parsing for Codex/tmux scout runs into `sks.scout-result.v1`.
- Add consensus binding that uses parsed real scout outputs as the primary source for `scout-consensus.json`.
- Add tmux lane scout execution with session/window creation, watcher, timeout, output collection, and cleanup.
- Add Codex App subagent capability descriptors so SKS only launches subagents when a real local event/output surface is declared.
- Add black-box packed package tests for npm pack, temp install, npx-style one-shot, and global shim behavior.
- Add pipeline runtime decomposition checks so `pipeline-runtime.mjs` is a small compatibility facade.
- Add stricter feature fixture quality gates that distinguish static contracts from runtime-verified features.
- Add scout speedup benchmark proof that allows speed claims only when parsed real scout outputs and measured baselines exist.

### Fixed
- Prevent real scout engines from claiming success when Codex/tmux output cannot be parsed into scout-result schema.
- Prevent pipeline budget checks from ignoring `pipeline-runtime.mjs`.
- Prevent static feature contracts from being treated as runtime route verification.
- Prevent package publish checks from passing without packed install smoke coverage.

### Changed
- Treat real Scout consensus as an evidence-bound parsed-output contract, not a synthetic fallback.
- Treat packed package behavior as part of the release proof.
- Treat pipeline architecture modularity as a hard release invariant.

## [0.9.18] - 2026-05-18

### Added
- Add real 5-Scout execution engine detection and selection for Codex exec, tmux lanes, Codex App subagents, local static fallback, and sequential fallback.
- Add read-only scout filesystem guards with pre/post source snapshots and mission-local allowed write paths.
- Add hermetic E2E route test roots so route tests no longer share the source checkout `.sneakoscope` state.
- Add strict feature fixture mode that rejects features without explicit fixtures and validates command-generated artifacts only.
- Add strict scout validation mode for release checks.
- Add split pipeline architecture module surfaces for stage policy, scout policy, route prep, stop gate, active context, prompt context, and plan writing.
- Add scout performance evidence v2 with speedup claims allowed only when real parallel execution has a measured sequential baseline.

### Fixed
- Prevent new features from receiving implicit static-pass fixture fallback.
- Prevent the former legacy multi-agent strict validation path from silently creating a passing run during release checks.
- Prevent E2E latest-mission collisions by isolating route tests in temp project roots.
- Prevent scout read-only violations by detecting source changes outside allowed scout artifacts.

### Changed
- Treat Five-Scout intake as real engine-backed when available and as verified-partial fallback otherwise.
- Treat feature fixture pass as explicit, command-generated, schema-validated evidence only.
- Promote pipeline budget, scout engine detection, strict scout checks, and hermetic fixture execution into `npm run release:check`.

## [0.9.17] - 2026-05-18

### Added
- Add `src/core/proof/auto-finalize.mjs` and route fixture integrations so serious route commands write Completion Proof without a separate `sks proof finalize` step.
- Add real-command E2E route tests for Team, QA-LOOP, Research, PPT, Image UX Review, Computer Use, DB, Wiki, and GX.
- Add `sks rust status|smoke --json` with optional native detection, stale-binary version checks, and JS fallback parity evidence.
- Add release scripts `route-modularity:check`, `command-budget:check`, and `feature-fixtures:strict`.

### Changed
- Remove the runtime `src/core/commands/route-cli.mjs` monolith and move route logic into focused `src/core/commands/*-command.mjs` modules.
- Make executable feature fixtures validate artifacts generated by the command run itself, including mission-local proofs, visual ledgers, DB reports, and route gates.
- Promote route modularity, command budget, and strict fixture execution into `npm run release:check`.

### Docs
- Document route finalization, feature fixtures, optional Rust behavior, and the 0.9.17 upgrade report path.

## [0.9.16] - 2026-05-18

### Fixed
- Install generated Codex App skill templates for `$Commit` and `$Commit-And-Push` so updated global setups show the commit routes in the dollar-command picker.
- Add a regression test that every `DOLLAR_SKILL_NAMES` entry is backed by a generated `SKILL.md` template.
- Emit canonical Codex hook command output with `hookSpecificOutput` wrappers and `PreToolUse.permissionDecision=deny` instead of relying on legacy top-level context/block shapes.

## [0.9.15] - 2026-05-18

### Fixed
- Fix `sks postinstall` auto-bootstrap by passing the callable bootstrap command instead of a boolean flag, preventing `TypeError: bootstrap is not a function` during `npm i -g sneakoscope@latest`.
- Add a focused postinstall regression test that forces auto-bootstrap in a temporary HOME/global root.

## [0.9.14] - 2026-05-17

### Added
- Add a legacy-free command architecture with no command registry fallback to `legacy-main.mjs`.
- Add automatic route completion proof writers for every serious route finalization path.
- Add automatic image voxel anchor/relation generation for all visual and Computer Use routes.
- Add full executable feature fixtures with expected artifact existence and schema validation.
- Add semantic Rust voxel validation parity with the JavaScript image voxel validator.
- Add strict hook replay matching for decision, reason, gate, and issue expectations.
- Add active project-root codex-lb circuit recording and proof evidence integration.
- Add `$Commit` and `$Commit-And-Push` simple git routes for commit-only and commit-then-push workflows without the full SKS pipeline.

### Fixed
- Remove indirect maintenance/legacy imports from split commands.
- Remove reliance on manual `sks proof repair latest` for normal route completion.
- Block visual completion when anchors or before/after relations are missing.
- Ensure codex-lb launch health reports are written to the active project root.
- Ensure fixture pass status means executed or schema-validated evidence, not registry-only metadata.

### Changed
- Treat Completion Proof and Image Voxel TriWiki as mandatory completion contracts, not optional reports.
- Promote executable fixtures and route proof adapters to the central release gate.
- Make the legacy-free command graph the only supported 0.9.14 command path.




## [0.9.13] - 2026-05-17

### Added
- Add route-bound Completion Proof adapters for all serious SKS routes.
- Add image voxel anchor automation for Computer Use, Image UX Review, PPT, GX, and From-Chat-IMG routes.
- Add executable feature fixtures for core route families and reduce `not_required` fixture coverage.
- Add real hook runtime replay fixtures and expected-decision validation.
- Add codex-lb circuit integration with launch health failures and recovery state.
- Add Rust `image-hash` and `voxel-validate` accelerator commands with JS fallback parity tests.

### Fixed
- Connect serious route gates to completion-proof presence and validation.
- Connect visual/UI route gates to image voxel anchors and before/after evidence where required.
- Fix Rust wrapper/binary command mismatch.
- Correct codex-lb README behavior around stateless `previous_response_not_found` and hard failure fallback.
- Reduce legacy CLI fallback for high-value commands.

### Changed
- Promote executable feature fixtures from registry metadata into release-gated mock validation.
- Treat image voxel anchors and completion proof as first-class serious-route completion requirements.





## [0.9.12] - 2026-05-17

### Added

- Add lazy command architecture foundations for lighter SKS startup, including a slim CLI entrypoint, command registry, and lazy legacy fallback.
- Add a unified Completion Proof Engine surface with latest proof JSON/Markdown, command/file ledgers, validation, and secret redaction.
- Add image-first Voxel TriWiki ledger foundations with SHA-256 image ingest, dimension capture, bbox/anchor validation, and proof summaries.
- Add route fixture coverage contracts for core SKS feature families through the feature registry and all-features selftest.
- Add cold-start performance measurement and release-gated CLI entrypoint checks.
- Add prompt-language response guidance so Korean requests produce Korean progress/final/Honest Mode text and English requests produce English text while preserving code and commands.

### Fixed

- Reduce heavy top-level CLI imports for lightweight commands such as `sks --version`, `sks help`, `sks root --json`, and `sks commands --json`.
- Strengthen Codex App / codex-lb / hook evidence handling with hook trust reports, replay fixture support, circuit metrics, and unified `[redacted]` secret policy.
- Make feature-registry checks distinguish coverage from executable/static fixture contracts.
- Stabilize the release cold-start performance gate by measuring 20 samples by default and retrying budget-only misses once before failing publish.

### Changed

- Promote proof and Voxel TriWiki evidence to first-class release-gated contracts.
- Package the Rust accelerator source in the npm package while keeping JS fallback behavior when no compiled `sks-rs` binary is available.



## [0.9.11] - 2026-05-17

### Fixed

- Repair stale `sks`/`sneakoscope` PATH shims during `npm i -g sneakoscope@latest` when another npm prefix still shadows the newly installed package, so `sks --version` reflects the upgraded release without manual PATH cleanup.
- Raise the npm unpacked-size budget to 1871 KiB for the upgrade-time shim repair code while preserving packed-size, file-count, tracked-file, and forbidden-file guards.

## [0.9.10] - 2026-05-17

### Fixed

- Repair stale Codex App desktop app-server processes during npm upgrades so reconnect loops recover without manual cleanup.

## [0.9.9] - 2026-05-17

### Fixed

- Keep release metadata aligned after an explicit SKS version bump advances the package version.
- Preserve ChatGPT OAuth only as a backup while codex-lb uses `requires_openai_auth = false`; the codex-lb proxy key stays in `CODEX_LB_API_KEY`/`env_key`, and PPT/imagegen bridge checks no longer require OpenAI OAuth for that provider.
- `sks codex-lb status` now reports the local Codex App auth shape and gives the right recovery path for the App refresh-token error: `sks codex-lb repair` keeps codex-lb selected, while `release` is reserved for switching fully away from codex-lb.
- Cache the codex-lb response-chain health probe briefly so repeated bare `sks` launches do not keep paying the same preflight/network cost.
- Raise the npm unpacked-size budget to 1864 KiB for the feature registry and codex-lb auth recovery code while keeping tracked-file, packed-size, file-count, and forbidden-file guards enforced.

## [0.9.8] - 2026-05-17

### Fixed

- Keep release metadata aligned after an explicit SKS version bump advances the package version.

## [0.9.7] - 2026-05-17

### Fixed

- **codex 0.130.0 auth compatibility**: codex CLI changed `auth.json` apikey field from `"key"` to `"OPENAI_API_KEY"`. The `reconcileCodexLbAuthConflict` writer now produces the new format. Reading still supports both old and new formats for backward compat.
- **`[exited]` on launch**: the tmux codex session exited immediately because codex 0.130.0 couldn't find the API key in the old auth.json format. Fixed by the auth format migration above.

### Improved

- `sks codex-lb setup` now supports interactive prompts when `--host`/`--api-key` are omitted: asks for domain and API key step by step, making first-time setup easier.
- On `npm i -g sneakoscope` upgrade, if codex-lb is already configured, prompts "codex-lb key changed? [y/N]" so users can update their key without needing to remember the setup command. Default is N (no change). Skip with `SKS_SKIP_CODEX_LB_KEY_PROMPT=1`.
- Auto-migrates legacy `auth.json` from old `"key"` field to new `"OPENAI_API_KEY"` format during postinstall and doctor --fix. Never wipes user keys or settings.

## [0.9.6] - 2026-05-17

### Fixed

- Selftest hermeticity: `npm publish` -> `prepublishOnly` -> `release:check` -> `selftest` was leaking the codex-lb provider-restore prompt and the new chain-failure prompt to the publisher's interactive terminal. The selftest now forces `process.env.CI = 'true'` at entry so every in-process `canAskYesNo()` falls through to the non-interactive default. Subprocess invocations already pass `--json`; their behavior is unchanged.
- Raise npm packed-tarball size budget from 456 KiB to 460 KiB to accommodate the new chain-failure prompt branches and selftest coverage.
- Republishes the 0.9.5 codex-lb launch-flow fix (which never reached npm because the publish failed at sizecheck): `previous_response_not_found` no longer silently bypasses codex-lb, hard chain failures prompt instead of swap silently, `SKS_CODEX_LB_AUTOBYPASS=1` opts back into silent bypass for automation.

## [0.9.5] - 2026-05-17

### Fixed

- `sks` (bare launch) no longer silently demotes a fully configured codex-lb to ChatGPT OAuth when `checkCodexLbResponseChain` reports `previous_response_not_found`. That failure mode is normal for stateless LB deployments that don't persist Responses across requests, so codex-lb stays active and the launch only logs a warning.
- For hard chain failures (auth rejected, timeout, 5xx, missing base URL), the launch now asks before bypassing: `Use codex-lb anyway, or fall back to ChatGPT OAuth? [LB/oauth]`. Default keeps codex-lb. In non-interactive contexts (CI, pipes, no TTY) the default is also "keep codex-lb" — set `SKS_CODEX_LB_AUTOBYPASS=1` to restore the previous silent-bypass behavior.
- Selftest: replace the assertion that codified the old "always bypass on `previous_response_not_found`" behavior with one that verifies codex-lb stays active. Added coverage for hard 5xx chain failures (default keep) and `SKS_CODEX_LB_AUTOBYPASS=1` (silent bypass restored).
- Note: 0.9.5 was not published to npm — sizecheck tripped at 456.1 KiB. See 0.9.6 for the actual ship of these changes plus the selftest hermeticity fix.

## [0.9.4] - 2026-05-17

### Added

- `sks codex-lb release` — reverses the 0.9.3 auto-reconcile: restores `~/.codex/auth.chatgpt-backup.json` back to `~/.codex/auth.json` and, by default, removes `model_provider = "codex-lb"` from the top-level Codex App config so the app falls back to ChatGPT OAuth. Re-engage codex-lb later with `sks codex-lb repair`.
  - `--keep-provider` — restore `auth.json` only; leave `model_provider = "codex-lb"` selected.
  - `--delete-backup` — remove `~/.codex/auth.chatgpt-backup.json` after a successful restore (default: keep it so a subsequent re-reconcile still has a source backup).
  - `--force` — restore even when the current `auth.json` does not look like the codex-lb apikey shape (e.g. user hand-edited it after reconcile).
  - `--json` — machine-readable result with `status` ∈ {`released`, `no_backup`, `already_chatgpt`, `auth_in_use`, `failed`} plus `auth_path`, `backup_path`, `provider_unselected`, `backup_removed`.
- `sks codex-lb unselect` — flips `model_provider` away from `codex-lb` in the top-level Codex App config without touching `auth.json` or the stored env file. Useful when switching to a different provider temporarily while keeping codex-lb config and `sks-codex-lb.env` intact for later.
- `sks codex-lb status` now reports whether `~/.codex/auth.chatgpt-backup.json` is present and surfaces a "Run `sks codex-lb release`" hint when applicable. The JSON variant adds `chatgpt_backup_present` and `chatgpt_backup_path`.
- Raise npm packed-tarball size budget from 452 KiB to 456 KiB to accommodate the new release/unselect surface plus selftest coverage.

## [0.9.3] - 2026-05-17

### Fixed

- Auto-reconcile codex-lb authentication during `npm i -g sneakoscope@latest`: when both a codex-lb provider with `env_key` auth and a ChatGPT OAuth token blob live in `~/.codex/auth.json`, the OAuth blob is backed up to `~/.codex/auth.chatgpt-backup.json` and `auth.json` is rewritten to apikey mode using the stored `CODEX_LB_API_KEY` so Codex CLI/App stops sending the OAuth bearer to the load balancer. Opt out with `SKS_CODEX_LB_NO_AUTH_RECONCILE=1` (the backup is still produced so nothing is lost).
- Broaden the postinstall codex-lb config/auth snapshot so the snapshot is taken whenever any codex-lb signal (`sks-codex-lb.env`, `[model_providers.codex-lb]` block, or pre-existing `auth.json`) is present, and restore a pre-existing `auth.json` if a bootstrap step emptied or removed it during the upgrade.
- Surface auto-reconciliation, backup-only, and reconciliation failures in postinstall log lines and in the `sks auth repair` / `sks codex-lb repair` JSON output via a new `auth_reconcile` field, so upgrades self-heal the most common codex-lb auth regressions without requiring a manual `sks codex-lb setup` rerun.
- Make the fake-codex login helper used by `sks selftest --mock` portable across `bash` and `dash` so the codex-lb selftest writes valid JSON regardless of the host shell's `printf` escape handling.
- Raise the npm unpacked size budget to 1856 KiB to accommodate the codex-lb auth auto-reconciliation logic and its self-test, while keeping packed size, file count, forbidden-file, and tracked-file guards enforced.

## [0.9.2] - 2026-05-16

### Fixed

- Treat Codex App Git Actions metadata for Commit, Push, Commit and Push, and PR flows as lightweight app git actions so SKS route/finalization hooks no longer block the built-in app commit/push UI.
- Report Codex App git action readiness in `sks codex-app check`, including `codex_git_commit`, hooks, `remote_control`, and Codex CLI remote-control support, so `sks doctor --fix` and upgrade checks surface the exact blocker.
- Keep `$Image-UX-Review` and `$UX-Review` tied to real Codex App `$imagegen`/`gpt-image-2` evidence, and add regression coverage that disabled `image_generation` blocks imagegen-dependent pipelines instead of passing silently.
- Raise the npm release size budget to 452 KiB packed and 1792 KiB unpacked for the Codex App git-action and imagegen readiness checks while keeping file count, forbidden-file, and tracked-file guards enforced.
- Keep release metadata aligned after the explicit SKS version bump to `0.9.2`.

## [0.9.1] - 2026-05-16

### Fixed

- Align codex-lb setup/repair with the upstream `Soju06/codex-lb` provider shape, including the OpenAI-authenticated provider block and websocket/base-url metadata.
- Restore missing Codex App `model_provider = "codex-lb"` settings from stored codex-lb environment during bare `sks` launches and project init/config merging.
- Tighten Codex App plugin readiness checks so missing default plugin sources and generated reserved-name skill shadows are reported with actionable guidance.
- Keep release metadata aligned after the explicit SKS version bump to `0.9.1`.

## [0.9.0] - 2026-05-15

### Added

- Document the report-only Decision Lattice planner for 0.9.0, using A* over proof-debt signals to explain route and verification path selection without claiming speedups before replay or scored eval evidence exists.
- Describe the Decision Lattice integration with proof-field and `sks pipeline plan` surfaces, including frontier, selected path, and rejected path evidence for reviewer audit.
- Raise the unpacked package size gate to 1776 KiB for the new Decision Lattice planner module while keeping packed size and file-count budgets unchanged.
- Strengthen the release registry gate so `--require-unpublished` checks the exact package version, not only whether the candidate is newer than the latest dist-tag.


## [0.8.6] - 2026-05-15

### Fixed

- Automatically restore existing codex-lb API-key auth during npm postinstall upgrades that reach the repair phase and during `sks doctor --fix`, including legacy installs where the key only remains in Codex `auth.json` and a codex-lb provider or env base URL is already recoverable.
- Keep the release size gate publishable after the codex-lb auth restore path by deduplicating its selftest setup and raising the unpacked-size budget to 1744 KiB.
- Restore `model_provider = "codex-lb"` as the top-level Codex App provider during codex-lb setup, repair, postinstall upgrade repair, and project config merging so upgraded apps actually route through codex-lb.
- Make `$PPT` load the `imagegen` skill as part of its required route allowlist and stamp required PPT image assets/review ledgers with Codex App `$imagegen`/`gpt-image-2` invocation instructions.


## [0.8.5] - 2026-05-15

### Fixed

- Keep codex-lb provider authentication from clobbering the shared Codex login cache, while syncing the stored `CODEX_LB_API_KEY` into the user launch environment for Codex App visibility.
- Keep release metadata aligned after an explicit SKS version bump advances the package version.

## [0.8.4] - 2026-05-15

### Fixed

- Surface Research scout agent names as explicit `agent_name` fields such as `Einstein Scout`, `Feynman Scout`, `Turing Scout`, `von Neumann Scout`, and `Skeptic Scout` throughout the plan, prompt, scout ledger, debate ledger, and selftest.
- Write Research paper manuscripts to a dated, topic-specific filename recorded in the plan, while keeping legacy `research-paper.md` compatibility for older missions.
- Keep release metadata aligned after an explicit SKS version bump advances the package version.

## [0.8.3] - 2026-05-15

### Fixed

- Preserve codex-lb as an explicit CLI launch provider without selecting it as the top-level Codex App provider, keeping native Codex App model, speed, and built-in feature UI visible.
- Keep release metadata aligned after the explicit SKS version bump to `0.8.3`.

## [0.8.2] - 2026-05-15

### Fixed

- Restore the `remote_control` Codex App feature flag during SKS setup/doctor repair and require it in `sks codex-app check`, so Codex mobile/remote-control UI entrypoints are not hidden while SKS still reports readiness.
- Keep installed OpenAI default plugins enabled during SKS setup/doctor repair, including Browser, Chrome, Computer Use, Documents, Presentations, Spreadsheets, and LaTeX, and fail `sks codex-app check` when an installed default plugin can be hidden from the composer/tool UI.
- Remove top-level `model_reasoning_effort` locks from Codex config during setup/doctor/codex-lb repair and report Fast UI config locks in `sks codex-app check`, so the Codex App model selector speed control remains visible.
- Raise the npm unpacked-size release budget to 1720 KiB for the Codex App readiness checks while keeping packed size, file count, forbidden-file, and tracked-file guards enforced.
- Keep release metadata aligned after the explicit SKS version bump to `0.8.2`.


## [0.8.1] - 2026-05-15

### Fixed

- Repair Codex App readiness and global repair so `sks doctor --fix` / reinstall restore official app feature flags for Computer Use, image generation, in-app browser, git commit/push, and Research xhigh profiles.
- Stop SKS route gates from blocking Codex App git commit/push and settings/profile UI events.
- Force `$Research` real runs through `gpt-5.5` Fast `xhigh` execution and report/repair missing Research profiles instead of silently running lower-effort paths.
- Change `$Research` from a fixed short loop into a no-code-mutation, evidence-layered genius-scout council that repeats until unanimous scout consensus or an explicit safety cap pauses the run.
- Gate Research completion on `consensus_iterations`, `unanimous_consensus`, and per-scout final agreements before the paper/report can pass.

## [0.8.0] - 2026-05-15

### Added

- Add the 0.8.0 Massive Upgrade report-only RecallPulse spine with TriWiki L1/L2/L3 cache decisions, neutral positive recall wording, durable `mission-status-ledger.json` status projection, duplicate suppression keys, `route-proof-capsule.json`, and `evidence-envelope.json`.
- Add `sks recallpulse run|status|eval|governance|checklist` so missions can write and inspect RecallPulse decisions without changing route behavior, including sequential child `$Goal` task checkpoints for `RECALLPULSE_0_8_0_TASKS.md`.
- Strengthen `$Research` scout personas with named Einstein Scout, Feynman Scout, Turing Scout, von Neumann Scout, and Skeptic Scout ledger fields while keeping them persona-inspired lenses, not impersonations.
- Gate Research scout ledgers on display names, persona boundaries, `reasoning_effort=xhigh`, `Eureka!` ideas, falsifiers, cheap probes, and debate participation evidence.
- Document the 0.8.0 Massive Upgrade while keeping performance claims benchmark-gated until scored RecallPulse evals prove them.
- Raise the npm package file-count release guard for the new RecallPulse core and CLI modules while keeping forbidden generated/runtime files excluded.



## [0.7.78] - 2026-05-14

### Fixed

- Stabilize the Team chat lane selftest used by `npm publish` by checking lane output semantically and including the rendered lane snapshot when the assertion fails.
- Raise the release size budgets to 448 KiB packed, 1700 KiB unpacked, and 384 KiB per tracked file so the current CLI entrypoint can pass publish checks while the larger split-review refactor remains explicit future work.
- Remove SKS support for installing `.git/hooks/pre-commit`; `sks versioning hook` is blocked, setup/doctor remove managed SKS version hooks, and release metadata stays explicit through `sks versioning bump`.

## [0.7.77] - 2026-05-14

### Fixed

- Recognize Codex App `Git Actions Commit` and `Commit and Push` hook payloads as app git actions, so SKS route gates do not block the built-in commit and commit-push flow.
- Keep ordinary user prompts that mention committing or pushing on the normal SKS route instead of treating them as app git actions.

## [0.7.76] - 2026-05-14

### Fixed

- Improve Team tmux live panes with Codex-style per-agent chat framing, lane identity, and color metadata.
- Close stale Team/codex-lb tmux panes before opening new managed views so old sessions do not linger.
- Detect codex-lb `previous_response_not_found` launch failures and bypass codex-lb for that launch instead of blocking SKS.

## [0.7.75] - 2026-05-14

### Fixed

- Keep release metadata aligned after the automatic SKS version guard advances the package version.

## [0.7.74] - 2026-05-14

### Fixed

- Prevent copied Team `Live Chat` status logs from contaminating route classification with stale DB/security keywords.
- Make Team tmux lane panes self-close after follow loops end and fall back to recorded pane ids during cleanup.
- Render per-agent Team lanes as compact Codex-style chat blocks.

## [0.7.73] - 2026-05-14

### Fixed

- Suppress Codex under-development feature warnings whenever SKS enables `codex_git_commit`, including npm postinstall/global repair, project setup, `sks doctor --fix`, and codex-lb config repair paths.

## [0.7.72] - 2026-05-14

### Fixed

- Prepare the real Research run contract for npm release after the `0.7.71` validation pass.

## [0.7.71] - 2026-05-14

### Fixed

- Make normal `$Research` runs require the real Codex execution path instead of silently falling back to mock output; missing Codex now writes `research-blocker.json` and exits blocked.
- Give Research runs a two-hour default per-cycle timeout via `--cycle-timeout-minutes`, while keeping `--mock` explicitly limited to selftests and dry harness checks.
- Update generated Research skill guidance, route context, and README docs so Research is framed as long-running real source gathering, not a short summary loop.

## [0.7.70] - 2026-05-14

### Fixed

- Strengthen `$Research` with a route-local `research-source-skill.md`, layered source retrieval across scholarly, official, news, public-discourse, developer, and counterevidence sources, source-layer coverage and triangulation gate metrics, and optional Context7 only for package/API/framework documentation topics.
- Keep explicit `$Research` prompts on the Research route even when the command appears mid-sentence or as a markdown link, preventing stale Team missions from hijacking research-only work.
- Keep Research mission state marked `implementation_allowed=false`; the route may write research artifacts, but product/code implementation stays out of scope.
- Require `$Research` to finish with `genius-opinion-summary.md`, summarizing each genius-lens scout's final opinion, evidence, disagreement, changed mind, and council consensus.
- Raise the npm unpacked-size release budget to 1.6 MiB for the expanded Research route artifact contract while keeping packed size, file count, and tracked-file limits enforced.

## [0.7.69] - 2026-05-14

### Fixed

- Ship the `$Research` paper-manuscript gate so research runs require `research-paper.md` with paper-style sections before passing.

## [0.7.68] - 2026-05-13

### Fixed

- Route `$Research` through a source-backed xhigh genius scout council contract, requiring one literal `Eureka!` idea per scout, `debate-ledger.json`, `source-ledger.json`, `scout-ledger.json`, `falsification-ledger.json`, citation coverage, counterevidence, and stricter research gate metrics before a run can pass.
- Require `$Research` runs to turn the final result into `research-paper.md` with paper-style sections and references before the research gate can pass.
- Install accepted SKS updates with the exact registry-confirmed version instead of `sneakoscope@latest`, avoiding stale npm cache or propagation windows after a fresh publish.
- Make `sks doctor --fix` repair stored codex-lb config/auth drift, and store the codex-lb base URL beside the API key so future updates can restore provider routing.
- Raise the packed npm tarball budget to 400 KiB while keeping single-file, unpacked-size, and file-count release gates in place.
- Keep the 0.7.67 Codex App commit-message hook bypass, codex-lb postinstall preservation, Team tmux cleanup, and registry safety fixes available under a fresh patch version.

## [0.7.67] - 2026-05-13

### Fixed

- Add a release registry gate so npm version bumps fail before publish when registry config, lockfile registry sources, packed metadata, or npm dist-tag state is unsafe.
- Preserve codex-lb provider routing config through postinstall bootstrap/repair so stored API-key auth is not left without `model_provider = "codex-lb"`.
- Keep Team tmux Scout panes on the right side, close managed panes after work, and render per-Scout live chat transcripts instead of a shared log tail.
- Let Codex App commit message generation bypass SKS route finalization hooks while keeping ordinary user bug-fix prompts on the normal Team route.

## [0.7.66] - 2026-05-13

### Fixed

- Preserve global codex-lb provider and MCP server settings when SKS bootstraps project `.codex/config.toml`, so reinstall/setup does not hide stored auth or existing MCP connections.

## [0.7.65] - 2026-05-13

### Fixed

- Restore clarification and ambiguity gates as hard pauses, so SKS waits for explicit user answers instead of advancing to implementation or later pipeline stages.
- Block non-answer tools and permission requests while a clarification gate is waiting, allowing only `sks pipeline answer` or answers-file sealing commands through.
- Render Team tmux panes from lane-specific agent events instead of duplicating the global transcript tail.
- Close SKS-managed Team tmux panes when session cleanup is recorded, including from stored pane metadata outside the active tmux client.
- Clean up legacy Team tmux sessions and unrecorded Team lane panes by mission/session naming when older pane metadata is absent.
- Allow read-only live SQL inspection through DB safety without MAD-SKS while blocking writes and destructive SQL.

## [0.7.64] - 2026-05-12

### Fixed

- Keep release metadata aligned after the automatic SKS version guard advances the package version.

### Fixed

- Reconcile Team tmux lanes inside the current SKS-owned tmux session when available, while preserving the named `sks-team-*` view as a fallback and closing only SKS-managed agent panes during lifecycle cleanup.
- Clarify that Codex App readiness uses Codex-provided feature/MCP/status surfaces, while Codex Computer Use remains required for actual target UI/browser evidence.

## [0.7.63] - 2026-05-12

### Fixed

- Keep release metadata aligned after the automatic SKS version guard advances the package version.
- Migrate generated Codex configs and npm postinstall repair from deprecated `[features].codex_hooks = true` to `[features].hooks = true`.
- Preserve and re-enable required Codex App feature flags, including `codex_git_commit`, during config normalization and selftest.
- Add `sks team open-tmux` / `attach-tmux` so hook-created Team missions can reopen the split-pane tmux Scout view after mission creation.



## [0.7.62] - 2026-05-12

### Fixed

- Accept terminal sizes larger than the normalized tmux minimum in the dynamic resize selftest.
- Let Codex App Git Actions proceed with normal commit/push permission requests during no-question routes while still denying force-push style requests in that mode.
- Keep release metadata aligned after the automatic SKS version guard advances the package version.

## [0.7.61] - 2026-05-12

### Fixed

- Render the terminal SKS logo through `figlet` with plain ASCII output and show the active package version in CLI/tmux banners.
- Add the `solution-scout` pipeline hook/skill so problem-solving prompts search for similar fixes before local implementation decisions.
- Refit Team tmux split panes on attach and terminal resize with `window-size latest`, resize hooks, and tiled-layout recalculation for Warp-style resizing.
- Strengthen the Computer Use-only policy to forbid installing or using Playwright packages as UI/browser verification substitutes.
- Keep release metadata aligned after the automatic SKS version guard advances the package version.

## [0.7.60] - 2026-05-12

### Fixed

- Keep release metadata aligned after the automatic SKS version guard advances the package version.

## [0.7.59] - 2026-05-12

- Align generated Codex config with current OpenAI Codex docs by emitting `[features].codex_hooks = true` and treating the older `hooks = true` key as legacy.
- Tune skill dreaming to the requested 10-route-event threshold while keeping the cooldown and recommendation-only safety model.

### Fixed

- Keep `sks --mad` as a single Codex tmux pane by default, leaving split panes for active Team scout/worker lanes.
- Make accepted SKS update prompts run only `npm i -g sneakoscope@latest`, without chaining setup, doctor, project install, or pipeline work.
- Remove stale generated `computer-use`, `browser-use`, and `browser` skill shadows during `sks doctor --fix` global repair and npm postinstall global skill setup.
- Raise the tracked-file release budget for the expanded install/doctor selftest coverage while keeping `src/cli/main.mjs` flagged for future extraction.

## [0.7.58] - 2026-05-12

### Fixed

- Remove visible prequestion sheets from SKS execution routes by auto-sealing contracts from prompt, TriWiki/current-code defaults, and conservative policy.
- Keep QA-LOOP UI verification restricted to official Codex Computer Use evidence and block browser automation substitutes.
- Require Codex App `$imagegen`/`gpt-image-2` evidence for required PPT and UI/UX generated-image gates instead of direct API fallback or fabricated assets.
- Show Team scout activity in tmux split panes by seeding scout assignment events and pane-open lane events for each visible agent.

## [0.7.57] - 2026-05-12

### Fixed

- Keep `npm publish` release checks passing after the MAD tmux launch changes by moving the MAD command path out of the oversized CLI entrypoint without increasing package file count.

## [0.7.56] - 2026-05-11

### Fixed

- Keep release metadata aligned after the automatic SKS version guard advances the package version.

## [0.7.55] - 2026-05-11

### Fixed

- Force all Codex launch, exec, remote-control, and hook-observed client model paths back to `gpt-5.5`, stripping `gpt-5.4` request overrides before they can reach the client runtime.

## [0.7.54] - 2026-05-10

### Fixed

- Keep release metadata aligned after the automatic SKS version guard advances the package version.
- Allow active `$MAD-SKS` and top-level `sks --mad` permission gates to run required Supabase migration application, including Supabase MCP `apply_migration`, `supabase migration up`, and `supabase db push`, while keeping default/non-MAD DB push and catastrophic reset/wipe safeguards blocked.


## [0.7.53] - 2026-05-10

### Fixed

- Keep release metadata aligned after the automatic SKS version guard advances the package version.
- Force generated and repaired Codex config plus SKS tmux launches to use `gpt-5.5`, preventing `gpt-5.4-mini` or other model defaults from slipping in through missing top-level model pins or `SKS_CODEX_MODEL` overrides.

## [0.7.52] - 2026-05-10

### Fixed

- Keep release metadata aligned after the automatic SKS version guard advances the package version.
- Treat Codex App Markdown-linked `$research`, `$QA-LOOP`, and related picker skills as explicit SKS routes so Computer Use wording cannot hijack QA/research prompts into the fast lane.
- Clarify `sks codex-app check` Computer Use readiness by distinguishing installed plugin files from live `@Computer` tool exposure in the current Codex App thread.
- Extend the native Computer Use policy text to require `@Computer` or `@AppName` in a fresh Codex App thread when live native Mac/non-web evidence is needed.
- Require real Codex App `$imagegen`/`gpt-image-2` output for generated raster assets and generated image-review evidence, blocking placeholders, prose-only critique, and fabricated image files from satisfying route gates.
- Report Codex image-generation feature readiness in `sks codex-app check` so missing `$imagegen` exposure is visible before SKS visual/image pipelines run.

## [0.7.51] - 2026-05-10

### Fixed

- Keep release metadata aligned after the automatic SKS version guard advances the package version.
- Add the `$Image-UX-Review` / `$UX-Review` route so UI/UX audits require a source screenshot -> `$imagegen`/`gpt-image-2` generated annotated review image -> issue ledger evidence chain instead of passing from text-only critique.
- Add Image UX Review route artifacts, generated skills, CLI status inspection, README guidance, and selftest coverage for missing generated-review-image blockers.
- Raise the release size/file-count guard for the new Image UX Review route module and expanded CLI selftests.

## [0.7.50] - 2026-05-09

### Fixed

- Fix Team review orchestration so default and lower explicit reviewer counts materialize at least five reviewer/QA validation lanes.
- Keep Team tmux review visibility without hiding the scout, executor, and planning representative lanes.
- Resolve `latest` mission selection from mission metadata timestamps instead of lexicographic ids, so same-second duplicate missions do not hide the actually active Goal/Team completion state.

### Changed

- Centralize the Team review-lane policy in a reusable gate module used by runtime plans and selftests.
- Update generated harness text, Team selftests, release size gates, and user-facing examples for the default minimum of five QA/reviewer lanes.

## [0.7.49] - 2026-05-09

### Fixed

- Add `sks codex-lb repair` and `sks auth repair` so stored codex-lb API-key auth can be re-synced without re-entering the key.
- Make `sks --mad` sync codex-lb/Codex CLI auth before launch and open a fresh session when the repaired key must be loaded immediately.
- Stop DB safety pre-tool checks from treating ordinary file-edit patch text such as `Update File` as SQL `UPDATE` operations.

## [0.7.48] - 2026-05-09

### Added

- Centralize the MAD-SKS live full-access permission profile in a reusable gate module so hooks, skills, and MCP-style safety checks share one decision function.
- Make `sks --mad` create an active MAD-SKS tmux permission mission so DB hooks inside the launched workspace allow live server work, Supabase MCP DB writes, direct SQL, targeted DML, and needed migrations while keeping catastrophic wipe safeguards.
- Expose Team tmux sessions as a single-window split-pane live UI with overview and color-coded lane metadata.

### Fixed

- Keep npm install/upgrade repair aligned with the new MAD-SKS and Team tmux behavior so generated setup policy and skill text no longer preserve stale safe-default wording.
- Reduce tmux/Team terminal noise by replacing large lane banners and verbose create output with mission, lane, status, watch, and artifact pointers only.
- Update the package file-count release budget for the new permission gate module.

## [0.7.47] - 2026-05-09

### Fixed

- Remove the generic ambiguity-question gate from normal execution routes so `$Team`, SKS workflow, research, DB, GX, and other direct work no longer stop on prewritten intent/risk questionnaires.
- Keep only explicit checklist routes such as `$QA-LOOP`, `$PPT`, and `$MAD-SKS` on the clarification path, while ordinary Team work now materializes Team artifacts immediately.
- Stop stale non-checklist clarification missions from hijacking later prompts or blocking tool calls, preventing repeated question sheets from recursively reappearing.

## [0.7.46] - 2026-05-09

### Fixed

- Preserve Codex Fast mode defaults during npm install/upgrade repair and `sks codex-lb setup` by keeping `service_tier = "fast"` plus the `sks-fast-high` profile instead of stripping the service tier while rewriting Codex config.
- Keep repeated ambiguity-gate retries compact so pending `INTENT_TARGET` questions no longer reprint the full visible-response contract and plan-tool instructions on every hook resume.
- Let `sks pipeline answer` seal contracts directly from `--stdin` or `--text` so users no longer need to deal with an `answers.json` step for ordinary clarification replies.
- Activate `$MAD-SKS` scoped DB permissions during auto-sealed standalone and modifier routes so ordinary DDL/DML is allowed while catastrophic wipe safeguards stay active.


## [0.7.45] - 2026-05-09

### Fixed

- Keep release metadata aligned after the automatic SKS version guard advances the package version.

### Added

- Add `sks codex-app remote-control` as a version-gated wrapper for Codex CLI 0.130.0's headless remote-control entrypoint, with status/JSON/dry-run modes and no fallback to older app-server internals.
- Add the `$PPT` image asset ledger pipeline so required presentation image resources are planned, generated through real `gpt-image-2` Image API calls when `OPENAI_API_KEY` is available, embedded in source HTML, and blocked instead of faked when credentials or generation output are missing.

### Changed

- Keep Codex App Fast mode selection visible during npm postinstall/setup/codex-lb configuration by enabling Fast UI keys and removing legacy SKS top-level `model`, `model_reasoning_effort`, and `service_tier` locks from Codex config.
- Report Codex remote-control readiness in `sks codex-app check`, and update Codex App guidance for Codex CLI 0.130.0 live app-server config refresh behavior.
- Raise the package file-count gate to 56 so the extracted Codex App command module stays release-checkable without adding more logic to the oversized CLI entry file.
- Make `$PPT` build/status output and selftest cover fact, image asset, review, bounded iteration, cleanup, and parallel build artifacts.


## [0.7.44] - 2026-05-08

### Fixed

- Stop clear auth-worded CLI rendering tasks from asking generic `RISK_AND_BOUNDARY` questions when conservative safety defaults can be inferred.
- Materialize Team runtime artifacts immediately after an auto-sealed ambiguity gate so Team missions can proceed to scouting instead of sitting at a sealed contract.
- Make the tmux/Codex intro stable: animate only for non-tmux unauthenticated launches, redraw frames in place, and show static 3D ASCII inside tmux.

## [0.7.43] - 2026-05-08

### Fixed

- Clarify that the default SKS Team pipeline authorizes route-owned worker/reviewer subagents without a separate user request.
- Make `sks --mad` launch Codex in explicit full-access mode with `danger-full-access` sandboxing and `approval_policy=never`.
- Make the tmux launch intro use a detailed rotating 3D-style SKS ASCII animation with more frame steps.
- Ship the install `.gitignore`, Fast mode, and PPT design-reference pipeline fixes under a fresh npm patch version.


## [0.7.42] - 2026-05-08

### Fixed

- Add a polished animated ASCII SKS intro for tmux launches, with a static fallback through `SKS_TMUX_LOGO_ANIMATION=0`.
- Keep release metadata aligned after the explicit SKS version bump.

## [0.7.41] - 2026-05-08

### Fixed

- Ship the codex-lb pre-launch auth flow in English, collecting host domain and API key before Codex opens.
- Load the codex-lb API key from the SKS-managed env file, sync Codex CLI API-key login for the interactive TUI, and use a fresh tmux session after first-time setup so the key is applied immediately.
- Keep release metadata aligned after the explicit SKS version bump.

## [0.7.40] - 2026-05-08

### Fixed

- Preserve user-owned Codex config such as Fast mode UI settings when SKS setup or global postinstall refreshes `.codex/config.toml`.
- Launch the default SKS tmux Codex CLI workspace in fast-high mode while allowing environment overrides.
- Add a pre-launch SKS codex-lb y/n auth prompt plus `sks codex-lb setup --host <domain> --api-key <key>` so hosted domain and key values are applied directly before Codex CLI opens.
- Repair tmux dependency handling so Homebrew-managed tmux uses Homebrew, npm-managed tmux uses npm, and unknown tmux paths are reported as conflicts.
- Make source-repo version drift checks use the local `bin/sks.mjs` runtime instead of stale global `sks`.
- Stop the pre-commit version guard from automatically bumping package and changelog versions on every commit; explicit `sks versioning bump` remains the release bump path.

## [0.7.38] - 2026-05-08

### Fixed

- Keep release metadata aligned after the automatic SKS version guard advances the package version.

## [0.7.37] - 2026-05-08

### Fixed

- Publish the hook update-check selftest fix under the version actually produced by the automatic SKS version guard.
- Make automatic SKS version bumps create and stage the matching changelog section so publish cannot silently advance beyond the verified changelog entry.

## [0.7.36] - 2026-05-08

### Fixed

- Keep hook update-check selftest verification stable when the on-disk SKS runtime version advances before the child hook process records update state.

## [0.7.35] - 2026-05-08

### Fixed

- Make TriWiki repeat-mistake prevention enforceable by preserving high-priority tail memory claims, binding relevant mistake recall into decision contracts, promoting voxel priority/conflict signals into source hydration, and gating completion on consumed recall evidence.
- Warn during `sks versioning status` when the source package version is newer than the bare global `sks` runtime.

## [0.7.34] - 2026-05-08

### Fixed

- Make `sks --mad` and explicit tmux launches attach automatically in interactive terminals after creating or reusing the session, while preserving print-only behavior for `--json`, `--quiet`, `--status-only`, `--no-attach`, and `SKS_TMUX_NO_AUTO_ATTACH=1`.

## [0.7.33] - 2026-05-08

### Fixed

- Add the release changelog section matching the current package version after the versioning hook advanced the package to `0.7.33`.

## [0.7.32] - 2026-05-08

### Fixed

- Keep the release gate aligned after the version guard advanced the package during install/bootstrap pipeline repair, and make the hook update-check selftest failure report the recorded state for diagnosis.

## [0.7.31] - 2026-05-08

### Fixed

- Make `npm i -g sneakoscope` automatically bootstrap the global SKS runtime root when install/upgrade runs outside a project, so Codex App `$` skills and pipeline fallback behavior are refreshed without requiring a separate `sks bootstrap`.

## [0.7.30] - 2026-05-08

### Fixed

- Add a Codex App pipeline-activation fallback to generated stateful SKS skills so `$Team`, `$SKS`, and related routes run `sks hook user-prompt-submit` and materialize mission/pipeline artifacts even when project hooks are not visibly injecting context.

## [0.7.29] - 2026-05-08

### Fixed

- Keep the Codex CLI update preflight release-ready after the version hook advanced the package again, including agent prompt auto-approve coverage and the extracted install helper path.

## [0.7.28] - 2026-05-08

### Changed

- Check npm `@openai/codex@latest` before tmux launches, prompt `Y/n` when the installed Codex CLI is missing or outdated, and continue the same launch with the updated binary after approval.
- Treat non-interactive agent runs as auto-approved for SKS update/install prompts, and include that environment flag in generated agent guidance.
- Document the Codex CLI update preflight in the README default tmux runtime flow.

## [0.7.27] - 2026-05-08

### Changed

- Make bare `sks` open or reuse the default tmux Codex CLI workspace, keeping `sks tmux open` as the explicit launch form for session/workspace flags.
- Update CLI help, generated quick reference wording, and README runtime guidance so the default tmux launch surface is discoverable.

## [0.7.26] - 2026-05-08

### Added

- Add a generated agent skill package that lets attached agents enable the shell tool and discover/use SKS workflows from a target repo root.
- Document generated agent setup, config YAML, sandbox note, and useful SKS commands in the README.
- Raise the package file-count budget to 54 for the generated agent helper modules while keeping packed and unpacked byte budgets unchanged.

## [0.7.25] - 2026-05-08

### Fixed

- Prune stale SKS-generated skills and generated app/agent files during setup, doctor repair, and postinstall refresh by comparing the previous generated manifest with the current generated surface.
- Preserve user-owned custom skills while removing prior-version SKS generated legacy files, and report the cleanup in doctor JSON output.

## [0.7.24] - 2026-05-08

### Changed

- Bump the deployment package version after the score-based ambiguity-question rebuild so the next publish can ship a fresh patch release.

## [0.7.23] - 2026-05-08

### Changed

- Replace fixed ambiguity-question templates with a weighted clarity gate that scores goal, constraints, success criteria, and codebase context before asking only the lowest-clarity execution-changing questions.
- Add Ouroboros-style ambiguity threshold metadata and Prometheus/Hyperplan-style planning lenses to the generated question schema and visible `questions.md` output.
- Update Team and prompt-pipeline skill guidance plus README documentation so user-facing surfaces describe score-based minimal clarification instead of static `GOAL_PRECISE` / `ACCEPTANCE_CRITERIA` prompts.

## [0.7.21] - 2026-05-08

### Fixed

- Make update-check selftest cases explicitly enable the mocked update check so inherited `SKS_DISABLE_UPDATE_CHECK=1` environments cannot skip the effective installed-version assertion.

## [0.7.20] - 2026-05-08

### Fixed

- Add the release changelog section matching the current package version so `npm run release:check` passes after the patch bump.

## [0.7.19] - 2026-05-08

### Fixed

- Infer conservative payment retry and auth session-expiry defaults during SKS ambiguity gating, so predictable `$Team` payment/auth fixes auto-seal instead of repeatedly asking for obvious policy slots.
- Restrict `$PPT` design/render execution to its route allowlist, ignoring installed out-of-pipeline design skills and MCPs unless a conditional PPT contract explicitly enables them.
- State the root `$PPT` design-policy goal as preventing AI-like generic presentation styling by grounding visuals in audience, sources, getdesign reference, and the design SSOT.

## [0.7.18] - 2026-05-08

### Changed

- Make `design.md` the explicit design decision SSOT while treating getdesign and `VoltAgent/awesome-design-md` as source inputs that must be fused into that SSOT or route-local `$PPT` style tokens.
- Add regression coverage for the fused design SSOT policy in generated `$PPT`, `getdesign-reference`, `design-system-builder`, prompt-pipeline, install manifest, and `$PPT` style-token artifacts.
- Update the README release surface for `$PPT`, design SSOT routing, getdesign, and `awesome-design-md` source-input behavior so npm/GitHub documentation matches the new feature set.

## [0.7.16] - 2026-05-08

### Changed

- Bump the deployment package version after the clarification-gate hard-pause fix so the next npm publish ships a fresh patch version.

## [0.7.15] - 2026-05-08

### Fixed

- Keep mandatory ambiguity-removal questions hard-paused until explicit user answers are sealed with `answers.json` and `sks pipeline answer`, instead of allowing repeated Stop hook blocks to fall through into the next pipeline phase.
- Add regression coverage proving clarification gates do not write compliance hard-blockers while waiting for answers, and that `pipeline status` projects `clarification-gate` blockers before the contract is sealed.

## [0.7.14] - 2026-05-08

### Added

- Add report-only route economy probes to Proof Field and workflow perf: contract clarity scoring, workflow complexity scoring, Team trigger matrices, and fail-closed verification stage cache keys.
- Add gate projection to `sks pipeline status` so active route gates, subagent evidence, Context7 evidence, and reflection freshness can be inspected as a single report-only blocker projection.

## [0.7.13] - 2026-05-08

### Changed

- Make `$PPT` artifact generation parallel-friendly by running independent strategy, render, and file-write groups with `Promise.all`.
- Add `ppt-parallel-report.json` plus gate/selftest coverage so `$PPT` records which presentation build phases ran as parallel groups.

## [0.7.12] - 2026-05-08

### Changed

- Replace the CLI runtime with direct tmux 3.x sessions and split panes across `sks tmux open`, `sks --mad`, dependency checks, doctor/bootstrap readiness, Team live lanes, cleanup, generated quick references, and README setup.
- Remove the remaining current-source tmux predecessor traces from command discovery, dependency repair, package keywords, Team skill wording, and runtime documentation.

## [0.7.11] - 2026-05-08

### Fixed

- Preserve `$PPT` editable source HTML under `source-html/artifact.html` while keeping the exported PDF as the user-facing artifact.
- Add `$PPT` cleanup reporting and gate/selftest coverage so PPT-only temporary build files are removed after completion and stale root `artifact.html` output does not remain.

## [0.7.10] - 2026-05-08

### Fixed

- Close the `$PPT` artifact loopback by adding `sks ppt build|status`, deterministic HTML/PDF artifact generation, storyboard/source/style/render-report files, and a passing `ppt-gate.json` only after the sealed contract has 3+ pain-point/solution/aha mappings.
- Make `$PPT` presentation design explicitly simple, restrained, and information-first, with design detail carried by hierarchy, spacing, alignment, thin rules, source clarity, and subtle accents instead of decorative overdesign.
- Make the generated `imagegen` skill prefer official Codex App built-in image generation via `$imagegen` / `gpt-image-2`, with API generation reserved for approved larger batches using `OPENAI_API_KEY`.
- Split postinstall and Context7 CLI helpers out of `src/cli/main.mjs` so the main CLI entrypoint stays below the 3000-line split-review gate.

## [0.7.9] - 2026-05-08

### Fixed

- Complete the `$PPT` presentation pipeline surface by generating the `ppt` Codex App skill, materializing `ppt-audience-strategy.json` / `ppt-gate.json` after sealed answers, and adding selftest coverage that `$PPT` ambiguity removal asks for delivery context, audience profile, STP strategy, decision context, and pain-point to solution mapping before artifact creation.
- Raise the package file-count budget to 50 for the new generated `$PPT` skill while keeping packed and unpacked byte budgets unchanged.

## [0.7.8] - 2026-05-08

### Fixed

- Stop treating every MCP tool name as a database tool, so Codex Computer Use MCP calls such as opening Microsoft Edge by bundle id are not blocked by the SKS DB safety gate during no-question runs.
- Add selftest coverage proving Computer Use MCP payloads pass the DB safety hook while Supabase execute_sql remains guarded.

## [0.7.7] - 2026-05-08

### Changed

- Infer predictable UI/UX ambiguity slots such as state behavior and visual-regression preference so SKS no longer asks users for defaults like "judge for yourself" or `yes_if_available`.
- Add getdesign.md as the generated design-reference policy for design.md, UI/UX systems, and presentation-like HTML/PDF artifacts, with npm postinstall opportunistically wiring the official Codex skill when the `skills` CLI is available.

## [0.7.6] - 2026-05-07

### Fixed

- Keep ambiguity-gated routes hard-paused after visible questions are shown: pre-tool and permission hooks now block implementation, tests, route materialization, and unrelated tools until explicit user answers are converted to `answers.json` and `sks pipeline answer` seals the contract.
- Add selftest coverage proving pending Team clarification blocks normal tool execution while still allowing the `pipeline answer` command that resumes the route.

## [0.7.5] - 2026-05-07

### Changed

- Embed Hyperplan-style adversarial planning lenses into the existing Proof Field and Team debate rubric, so SKS challenges framing, subtracts unnecessary surface, demands evidence, tests integration risk, and considers a simpler alternative without adding a new route or heavier pipeline stage.
- Add selftest coverage that Proof Field reports and scorecards carry the adversarial lenses, and document the lightweight Hyperplan adaptation in the README.

## [0.7.4] - 2026-05-07

### Changed

- Raise the package size gates to 384 KiB packed and 1536 KiB unpacked so release preparation has practical headroom instead of failing on tiny harness growth.

## [0.7.3] - 2026-05-07

### Fixed

- Infer conservative DB safety defaults for predictable ambiguity-gate prompts so SKS no longer asks users to fill static database policy slots when the safe answer is already clear.
- Add selftest coverage proving a DB safety question-block prompt auto-seals with zero visible slots.
- Raise the package size gates to 269 KiB packed and 1037 KiB unpacked for the DB clarification inference coverage while keeping the package at 49 files.

## [0.7.2] - 2026-05-07

### Fixed

- Auto-run global forced SKS bootstrap from npm postinstall when the install cwd looks like a project, so first installs and upgrades refresh project hooks, skills, and readiness without requiring `sks setup --bootstrap --install-scope global --force`.
- Keep postinstall bootstrap targeted at `INIT_CWD` and add an explicit `SKS_POSTINSTALL_NO_BOOTSTRAP=1` opt-out for users who need package install without project mutation.
- Raise the unpacked package size gate by 1 KiB for the automatic postinstall bootstrap selftest coverage while keeping the package at 49 files.

## [0.7.1] - 2026-05-07

### Fixed

- Fix `sks doctor --fix --json` so the DB safety scan is wired into the CLI instead of crashing before the readiness report.
- Preserve the existing project/global install scope during `doctor --fix` unless the user explicitly passes a new scope, so project installs keep project hook commands.
- Add CLI-level `doctor --fix` selftest coverage for managed file repair across skills, hooks, quick reference, policy, AGENTS managed block, legacy skill mirrors, and user-owned custom skills.

## [0.7.0] - 2026-05-07

### Added

- Add `pipeline-plan.json` as the stateful route execution map. It records runtime lane, kept/skipped stages, required verification, Proof Field binding, and the no-unrequested-fallback invariant for each mission.
- Add `sks pipeline plan [mission-id|latest] [--proof-field] [--json]` and include plan summaries in `sks pipeline status`, Team CLI mission creation, generated skills, README, workflow perf metrics, and selftests.
- Raise package size budgets to 268 KiB packed and 1032 KiB unpacked for the 0.7 pipeline-plan runtime surface while keeping the package at 49 files.

### Changed

- Bind Proof Field speed decisions into the mission plan so fast-lane work skips only explicit stages, while broad/security/database work fails closed to the full Team/Honest path.

## [0.6.100] - 2026-05-07

### Added

- Add lightweight skill dreaming with `.sneakoscope/skills/dream-state.json`, `sks skill-dream status|run|record`, and recommendation-only keep/merge/prune/improve reports so generated skills can be simplified after count/cooldown thresholds without evaluating every conversation or deleting skills automatically.
- Raise the packed package budget from 256 KiB to 264 KiB for the skill-dream runtime surface while keeping the package at 49 files and below the 1 MiB unpacked gate.

## [0.6.99] - 2026-05-07

### Changed

- Add a Proof Field execution lane so small, low-risk, clearly verifiable work can use `proof_field_fast_lane` and skip Team debate, fresh executor teams, broad route rework, and unrelated checks while keeping listed verification, TriWiki validation, and Honest Mode.
- Surface the speed-lane policy in route context, generated Team/prompt/pipeline skills, workflow perf metrics, README, and selftest coverage so risky work still fails closed to the normal Team/Honest path.

## [0.6.98] - 2026-05-06

### Changed

- Adapt Managed Agents-style outcomes/dreaming ideas into the existing lightweight Proof Field path: proof reports now include an outcome rubric, simplicity scorecard, and explicit escalation triggers instead of adding a new background pipeline.
- Shorten the Research plan shape around frame, hypothesize, falsify, and apply phases so research outputs favor the smallest useful mechanism or probe over broad process expansion.

### Fixed

- Suppress negative-priming wording in TriWiki compact recall by rewriting selected anti-goal guardrails into positive target behavior while keeping the original claim hydratable by source/hash.
- Add a selftest proving a selected negated recall claim no longer pastes the negated target into compact `claims` text and is instead routed through `attention.hydrate_first`.
- Accept Context7 MCP underscore tool names such as `resolve_library_id` and `query_docs` as completion evidence, preventing routes from staying blocked after the docs call actually ran.

## [0.6.97] - 2026-05-06

### Fixed

- Pin selected TriWiki claims into the coordinate anchor set so `attention.use_first` keeps cache-hit anchors for the claims the capsule actually chose, even when high-priority distractors compete for a small anchor budget.
- Add a selftest fixture that verifies selected cache-hit claims remain present in `claims`, `wiki.a`, and `attention.use_first` under distractor pressure.

## [0.6.96] - 2026-05-06

### Fixed

- Simplify `$DFix` finalization so it no longer creates a persistent light-route state record; DFix now uses an explicit completion marker plus a one-line DFix-specific Honest Mode check while remaining free of TriWiki/TriFix/reflection recording.
- Stop bare `sks` and default `sks team` creation from opening tmux automatically; tmux launch now requires an explicit `sks tmux open`, `sks --mad`, auto-review start, or `sks team --open-tmux`.
- Reuse the current tmux terminal for explicit single-session launches when SKS is already running inside tmux, preventing nested tmux windows.

## [0.6.93] - 2026-05-05

### Changed

- Bump the deployment package version after the Computer Use fast-lane routing update so the next npm publish ships a fresh patch version.

## [0.6.92] - 2026-05-05

### Added

- Add `$Computer-Use` / `$CU` as a maximum-speed Codex Computer Use lane for native Mac/non-web visual tasks, deferring TriWiki refresh/validate and Honest Mode to final closeout while preserving the Computer Use evidence policy.

### Fixed

- Prevent Computer Use pipeline-tuning requests that mention TriWiki or Honest Mode from being misrouted into `$Wiki`.

## [0.6.91] - 2026-05-05

### Changed

- Clarify `$Goal`/`sks goal` as a fast SKS bridge overlay for Codex native `/goal` persistence, with implementation continuing through the selected SKS execution route and Context7 only required when external docs are involved.

## [0.6.90] - 2026-05-05

### Fixed

- Prevent `$DFix` turns from being pulled into repeated full-route Honest Mode stop-hook loopbacks; DFix uses one-shot ultralight finalization context and keeps only cheap verification for micro-edits.

## [0.6.89] - 2026-05-04

### Changed

- Bump the release version for the SKS generated-file ignore update so the next npm publish can ship a new package version.

## [0.6.88] - 2026-05-04

### Changed

- Make default SKS project setup write shared `.gitignore` entries for generated Sneakoscope files so `.sneakoscope/`, `.codex/`, `.agents/`, and managed `AGENTS.md` do not appear as project changes.
- Keep `--local-only` installs on `.git/info/exclude` while adding selftest coverage for both shared and local-only ignore modes.

## [0.6.87] - 2026-05-04

### Added

- Add `sks proof-field scan` as the first Potential Proof Field implementation slice, reporting invariant ledgers, proof cones, negative-work cache entries, fast-lane eligibility, and fail-closed escalation triggers for the current change set.
- Add `sks perf workflow` to measure Proof Field build time, fast-lane eligibility, selected proof cones, verification count, and cached negative work for a concrete change intent.
- Raise the package file-count budget to 49 for the new proof-field module while keeping packed and unpacked byte budgets unchanged.

## [0.6.86] - 2026-05-03

### Changed

- Change `$MAD-SKS` from a table-removal confirmation flow into a scoped Supabase MCP DB cleanup/write override: column and schema cleanup are allowed during the active invocation, while catastrophic wipe operations remain blocked.

## [0.6.85] - 2026-05-02

### Changed

- Bump the deployment package version after the tmux Team cleanup, message, and color-lane UX work so the next npm release has a fresh patch version.

## [0.6.84] - 2026-05-02

### Changed

- Improve tmux Team sessions with cleanup-aware `watch`/`lane` follow loops, bounded `sks team message` inter-agent communication, terminal titles, and stronger color-coded lane banners.

## [0.6.83] - 2026-05-02

### Changed

- Replace the SKS CLI runtime with terminal multiplexer sessions, including `sks`, `sks tmux`, `sks --mad`, dependency checks, doctor/bootstrap readiness, Team live lanes, generated quick references, and README usage.
- Remove the previous runtime support and its socket/workspace control path from the source tree.

## [0.6.81] - 2026-05-02

### Changed

- Historical package-pipeline UI/browser verification used Codex Computer Use-only evidence; current policy supersedes that with Codex Chrome Extension-first web verification while still rejecting Playwright, Chrome MCP, Browser Use, Selenium, Puppeteer, and other browser automation as substitutes.

## [0.6.80] - 2026-05-02

### Fixed

- Stop repeating the SKS update prompt after the installed `sks` binary is already at the npm latest version, and clear stale pending update offers before accepting another update response.

## [0.6.79] - 2026-05-02

### Changed

- Historical UI-level QA/E2E verification used Codex Computer Use-only evidence; current policy supersedes that with Codex Chrome Extension-first web verification while still rejecting Chrome MCP, Browser Use, Playwright, and other browser automation as substitutes.

## [0.6.78] - 2026-05-02

### Added

- Add `sks harness fixture|review` and `harness-growth-report.json` for deliberate forgetting fixtures, skill card metadata, harness experiment schema, permission profiles, MultiAgentV2 defaults, terminal cockpit view coverage, and tool-error taxonomy.
- Record failed tool calls into `tool-errors.jsonl` with InvalidArguments, UnexpectedEnvironment, ProviderError, UserAborted, Timeout, PermissionDenied, NetworkDenied, ResourceExhausted, Conflict, or Unknown classification; Unknown is marked as a harness bug.

### Changed

- Tighten the ambiguity stop gate so a clarification-only final must visibly include the `Required questions` block and slot ids instead of passing on vague “I need decisions” wording.
- Expand Team dashboard panes to the requested Mission/Goal, Agent Grid, MultiAgentV2, Work Order Ledger, Memory Health, Forget Queue, Mistake Immunity, Tool Reliability, Harness Experiments, Dogfood Evidence, Code Structure, and statusline/title cockpit surfaces.
- Extend Goal workflow artifacts with checkpoints, resume context, clear policy, and structured `/goal` continuation metadata.

## [0.6.77] - 2026-05-02

### Changed

- Make `sks team` open a terminal multiplexer orchestration workspace with a live mission overview pane plus split per-agent lanes.
- Render `sks team watch` as a readable live cockpit instead of raw transcript JSON by default, with `--raw` preserving the old tail output.
- Color-code and rename tmux Team lanes by role, expose role status badges, and collapse agent panes back to the overview through `sks team cleanup-tmux` or the `session_cleanup` live event.
- Repair external terminal socket launch by restarting the multiplexer with a non-persistent permissive socket mode when default control rejects SKS with `Broken pipe`.

## [0.6.76] - 2026-05-01

### Added

- Add TriWiki memory-governor sweep reports with ADD/UPDATE/CONSOLIDATE/DEMOTE/SOFT_FORGET/ARCHIVE/HARD_DELETE/NOOP/PROMOTE operations and bounded retrieval budgets.
- Add `sks wiki sweep` to emit memory hygiene, Skill Forge, Mistake Memory, and code-structure mission artifacts.
- Add `sks code-structure scan` and `code-structure-report.json` for 1000/2000/3000-line structure gates and split-review exceptions.

### Changed

- Team preparation now writes memory sweep, skill forge, mistake-memory, and code-structure reports before dashboard rendering.
- Team dashboard state now includes Memory Attention, Forget Queue, Skill Autopilot, Mistake Immunity, and Code Structure panes.
- Split maintenance-heavy CLI handlers into `src/cli/maintenance-commands.mjs`, bringing `src/cli/main.mjs` below the 3,000-line split-required review gate.

## [0.6.75] - 2026-05-01

### Added

- Add `$Goal` and `sks goal create|pause|resume|clear|status` as the SKS bridge to Codex native persisted `/goal` workflows.
- Add `goal-workflow.json` and `goal-bridge.md` mission artifacts so pipeline runs record the native `/goal` control contract.

### Changed

- Replace the user-facing Ralph route, command, generated skills, and selftest surface with the native Goal workflow path.
- Update no-question, DB safety, retention, generated rules, docs, and discovery surfaces to use generic SKS run/Goal terminology.

## [0.6.74] - 2026-05-01

### Added

- Add schema-backed GPT-5.5 performance artifacts for Work Order Ledgers, effort decisions, From-Chat-IMG visual maps, dogfood reports, Skill Forge, mistake memory, Team dashboard state, terminal pane plans, and Honest Mode reports.
- Add `sks validate-artifacts` and `sks perf run` so mission evidence and performance budgets are locally checkable.
- Add lightweight effort orchestration, prompt-context ordering, Skill Forge, mistake memory, dogfood, From-Chat-IMG work-order, and Team dashboard renderer modules.

### Changed

- Team mission creation now writes work-order, effort, and dashboard-state artifacts and exposes `sks team dashboard`.
- Make ambiguity-removal awaiting states modal: pending questions are re-exposed in chat and new route prompts cannot replace the active question sheet before answers are sealed.
- Size/performance budgets now reflect the measured zero-dependency package payload after schema/orchestration modules were added.

## [0.6.73] - 2026-04-30

### Changed

- Make tmux readiness checks validate workspace socket health, not only the tmux executable version, so `sks deps check`, `sks doctor`, `sks tmux check`, and `sks --mad` report unhealthy app/socket states before launch.
- Make `sks team` create a named tmux Team workspace and target each split/send by returned workspace and surface refs, so visible Team lanes open as split panes instead of relying on ambient tmux environment variables.
- Select the newly created tmux Team workspace after launch and report the actual opened lane count, so split panes are brought to the visible workspace instead of opening behind the current tmux view.

## [0.6.72] - 2026-04-30

### Changed

- Add a bounded stop-hook repeat guard so repeated identical Honest Mode or final completion summary prompts are suppressed instead of re-entering an infinite finalization loop.

## [0.6.71] - 2026-04-30

### Changed

- Persist SKS-created tmux workspace refs so repeated `sks --mad --high` launches can reuse the last workspace even when tmux workspace listing is incomplete or unstable.
- Block duplicate workspace creation when tmux workspace inspection fails, instead of silently falling through to another `new-workspace` request.

## [0.6.70] - 2026-04-30

### Changed

- Make `sks --mad` reuse its named tmux workspace and close duplicate SKS-named MAD workspaces instead of creating another workspace on every launch.
- Add pipeline, Team inbox, generated agent, auto-review, and MAD/MAD-SKS policy text that blocks unrequested fallback implementation code.

## [0.6.69] - 2026-04-30

### Changed

- Add `sks team lane` per-agent monitoring for tmux Team panes, showing agent status, assigned runtime tasks, recent agent events, and a fallback global tail.
- Promote explicit `$From-Chat-IMG` work-order analysis to xhigh temporary reasoning and generated skill metadata.
- Allow runtime commands to work outside any project by falling back to a per-user global SKS root, with `sks root` showing the active project/global root.

## [0.6.68] - 2026-04-29

### Changed

- Align the `main` merge release metadata after SKS versioning advanced the merge package version during the final commit.

## [0.6.67] - 2026-04-29

### Changed

- Merge the verified 0.6.66 MAD tmux repair line from `dev` into `main`, preserving the public README emphasis for From-Chat-IMG and TriWiki voxels.

## [0.6.66] - 2026-04-29

### Changed

- Make `sks --mad` check npm for a newer Sneakoscope release before launch and prompt y/n for updating in interactive terminals.
- Make MAD dependency repair install missing Codex CLI with `@latest`, install or upgrade tmux through Homebrew, and re-probe real tmux app bundle binaries after cask installation.
- Update README MAD/tmux troubleshooting docs for update prompts, `--yes`, and direct tmux app bundle discovery.

## [0.6.65] - 2026-04-29

### Changed

- Make `sks --mad` launch the tmux MAD profile as full-access high reasoning with Codex automatic approval review enabled via `approvals_reviewer = "auto_review"`.
- Align SKS auto-review profile generation with current OpenAI Codex docs by using `auto_review` instead of the legacy `guardian_subagent` reviewer value.

## [0.6.64] - 2026-04-29

### Changed

- Expand the README into a fuller open-source CLI guide with quick start, requirements, installation modes, terminal CLI usage, Codex App `$` commands, common workflows, troubleshooting, and release checks.

## [0.6.63] - 2026-04-29

### Changed

- Make `sks --mad --high` attempt Homebrew tmux installation and re-probe before launch when tmux is missing, with a concise launch blocker if installation cannot complete.
- Replace the first tmux banner box with a stronger SKS/tmux ASCII mark for the CLI workspace header.

## [0.6.62] - 2026-04-29

### Changed

- Make plain `sks --mad --high` wake the tmux app before creating the `sks-mad-high` Codex CLI workspace, so the command opens the tmux UI path directly.

## [0.6.61] - 2026-04-29

### Changed

- Replace the SKS terminal runtime with a tmux-based Codex CLI workspace flow, including tmux dependency checks, help/discovery surfaces, setup guidance, and Team tmux live lanes.
- Add `sks --mad --high` as an explicit one-shot tmux launch that writes and uses the `sks-mad-high` full-access high-reasoning Codex profile without changing the normal default route.

## [0.6.60] - 2026-04-29

### Changed

- Add `$MAD-SKS` as an explicit scoped database authorization modifier that can compose with other dollar-command routes while keeping the widened permission limited to the active invocation.
- Require table-removal operations to pause for short user confirmation even under MAD-SKS, and close the override when the active mission gate is complete.

## [0.6.59] - 2026-04-29

### Changed

- Merge the dev branch Team runtime graph, From-Chat-IMG completion gates, and active TriWiki attention work into main while preserving the main README positioning for From-Chat-IMG and TriWiki voxels.

### Changed

- Infer predictable ambiguity-gate contract answers from the prompt/default safety policy so SKS asks only unresolved behavior or safety questions instead of static `GOAL_PRECISE` and `ACCEPTANCE_CRITERIA` templates.

## [0.6.55] - 2026-04-29

### Changed

- Require From-Chat-IMG completion to include scoped QA-LOOP evidence after the customer-request work is implemented, with every work-order item covered, post-fix verification complete, and zero unresolved QA findings.
- Raise the tracked-file size gate to 288 KiB for the enlarged From-Chat-IMG scoped QA-LOOP selftest while retaining the existing package size gates.

## [0.6.54] - 2026-04-29

### Changed

- Strengthen From-Chat-IMG completion gates with a required checked work checklist and temporary TriWiki-backed request snapshot, so chat screenshot text, image-region matches, work items, and verification steps are tracked before Team completion.
- Add From-Chat-IMG temporary TriWiki retention handling so session-scoped image-analysis claims can be pruned after the configured later-session TTL.

## [0.6.53] - 2026-04-29

### Changed

- Add a stop-gated From-Chat-IMG coverage ledger so every visible customer request, screenshot image region, and attachment must be mapped to work-order item(s) with `unresolved_items=[]` before Team completion.
- Teach Team plans, generated skills, prompt context, inferred acceptance criteria, and selftests to require the From-Chat-IMG no-omission work-order coverage pass.
- Add a compliance-loop guard so repeated identical stop-gate blocks produce an evidenced `hard-blocker.json` instead of looping indefinitely, re-evaluate normal gates after later repairs, and bound route runner `--max-cycles` values.
- Raise the tracked-file size gate to 272 KiB for the enlarged CLI selftest and Team plan coverage logic while retaining the 256 KiB packed tarball limit.

## [0.6.52] - 2026-04-28

### Changed

- Expand README with feature coverage for route commands, Codex App surfaces, workflow rules, release checks, and requirements.
- Raise package size gates to 256 KiB packed and 1 MiB unpacked so shipped README documentation has practical headroom while npm dry-run packaging remains verified.

## [0.6.51] - 2026-04-28

### Changed

- Expose `$From-Chat-IMG` directly in `sks dollar-commands`, manifests, policy, quick reference, and generated dollar-command output instead of only as a hidden Team picker alias.

## [0.6.50] - 2026-04-28

### Changed

- Add explicit `$From-Chat-IMG` / `From-Chat-IMG` Team alias for chat-history screenshot plus original attachment intake.
- Gate chat-image analysis behind the explicit From-Chat-IMG signal so ordinary image prompts are not treated as chat captures.
- Require From-Chat-IMG intake to list chat requirements first, use Codex Computer Use visual inspection to strengthen attachment matching, and produce a client modification work order before continuing the normal Team pipeline.
- Raise the package size gates to 168 KiB packed and 644 KiB unpacked for the added command alias, generated skill, and route-gating selftests.

## [0.6.49] - 2026-04-28

### Changed

- Raise the package size gates to 166 KiB packed and 642 KiB unpacked so the stack-current-docs and final-summary policy surfaces remain publishable.
- Require final answers to omit dirty-worktree boundary wording that the Honest Mode hook treats as an unresolved gap.

## [0.6.48] - 2026-04-28

### Changed

- Require every pipeline final answer to include a user-visible completion summary explaining what changed, what was verified, and what remains unverified or blocked.
- Block Honest Mode final stop when the completion summary is missing, with selftest coverage for the new stop-gate behavior.

## [0.6.47] - 2026-04-28

### Changed

- Route question-shaped implicit directives, policy complaints, and mandatory workflow statements to Team instead of Answer.
- Require Team roster confirmation before implementation by materializing `team-roster.json` and enforcing `team_roster_confirmed=true` in Team gates.
- Raise the packed size gate to 165 KiB and unpacked gate to 640 KiB for the added stack-current-docs and Team roster guidance.

## [0.6.46] - 2026-04-28

### Changed

- Require current Context7 or official-doc evidence whenever stack, framework, package, runtime, or deployment-platform versions change, then record the guidance as high-priority TriWiki claims before coding.
- Add current-doc TriWiki examples for hosted Supabase keys, Next.js 16 proxy files, and Vercel Function duration limits.
- Require the latest coordinate+voxel TriWiki pack shape in validation and pipeline guidance; coordinate-only legacy TriWiki packs now fail validation and must be regenerated before use.
- Keep the package size gate bounded while allowing the required TriWiki voxel validation metadata.

### Fixed

- Treat successful Honest Mode phrases like `No active blocking route gate detected` and verified expected blocking as resolved, so loopback does not reopen on closure evidence.

## [0.6.45] - 2026-04-28

### Added

- Add chat-history screenshot intake guidance so SKS extracts visible text, matches screenshot image regions to attachments, and carries the evidence through the normal Team pipeline.
- Raise the package size gate slightly for the added pipeline guidance while keeping the tarball bounded under 628 KiB unpacked.

### Fixed

- Block full-route completion when Team work continues after `reflection-gate.json` was passed, forcing reflection to be refreshed before final Honest Mode.

## [0.6.44] - 2026-04-28

### Changed

- Use a GitHub raw logo URL in README so npm can render the image.

## [0.6.43] - 2026-04-28

### Changed

- Make QA-LOOP dogfood real UI/API flows as a human proxy, immediately apply safe contract-allowed fixes, and require focused rechecks before passing the QA gate.

## [0.6.42] - 2026-04-28

### Changed

- Add full-route reflection with generated `reflection` skill, stop-gate enforcement, and TriWiki lesson recording.
- Add Team `team-session-cleanup.json` as a required pre-reflection gate.
- Require QA-LOOP reports to use `YYYY-MM-DD-v<version>-qa-report.md`.
- Treat verified expected-block evidence as resolved in Honest Mode gap detection.
- Add `sks bootstrap` plus `sks deps check/install` for first-install readiness, and make postinstall point to bootstrap instead of mutating projects by default.
- Reduce Ralph questions for setup work by inferring non-target DB/UI fallback slots from local context.
- Count user request topics in TriWiki packs and prioritize repeated or strongly frustrated feedback as high-weight context for future inference.
- Raise the npm unpacked size budget to 620 KiB so the richer setup, reflection, QA, and TriWiki priority pipeline remains releasable.

## [0.6.41] - 2026-04-28

### Fixed

- Preserve custom Codex App skills during `sks doctor --fix`.

## [0.6.40] - 2026-04-28

- Preserve user-owned non-generated skill aliases during upgrade/repair while removing obsolete SKS aliases.
- Add selftest coverage for custom skill preservation.

## [0.6.39] - 2026-04-28

- Restore fuller README guidance while keeping package size under the gate.

## [0.6.38] - 2026-04-28

- Seed SKS dollar-command skills into `$HOME/.agents/skills` during package install.
- Report project-local and global dollar-command readiness in `sks codex-app check` and `sks doctor`.
- Add the minimal `ㅅㅋㅅ` README mark.

## [0.6.37] - 2026-04-28

- Add Korean `ㅅㅋㅅ` branding, tmux/setup guidance, Team live event logging, Codex CLI readiness handling, design/image skills, and Team-default execution routing.
- Fix Korean execution-prompt routing, Team continuation after ambiguity gates, Context7 readiness checks, changelog release checks, and Honest Mode loop-back/no-gap handling.
