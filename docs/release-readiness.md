# SKS 8.1.1 Release Readiness

This document is the current fail-closed release contract for `sneakoscope`
8.1.1. The current package version on this branch is 8.1.1. It is a readiness
checklist, not evidence that the version has already been published.

## Required vs recommended evidence

**Required** for “release-ready” claims: green **release gates**
(`npm run release:check:affected` / `npm run release:check:confidence` and the
gates they compose), including release-core review/security/bugbot evidence when
those gates demand it. Run review-class checks near the end of work once, then
retry only remaining gaps.

**Recommended** (helpful, not automatic substitutes for the required set):
TypeScript typecheck, focused unit/integration tests, and
`npm publish --dry-run`. Do not treat recommended checks as the release SSOT
without an explicit AMBIGUITY-RESOLUTIONS revision.

## Completion Boundary

The release is ready to stage only when all required implementation,
verification, package, and platform evidence is current and green. A missing
real dependency is recorded as blocked or unverified; it is never converted to
a pass by a mock, stale report, or prose assertion.

The public execution surface is `$sks-naruto` / `sks naruto run`, with `$sks-work` as
the explicit plan-execution alias. Installed help, command manifests, generated
skills, project guidance, and terminal templates must expose only the current
surface. Any other spelling is unknown input and cannot activate an execution
path.

`sks doctor --fix` and `sks update` must reconcile installed SKS-owned residue:

- remove retired managed command and skill entries;
- remove retired managed runtime and report artifacts;
- rewrite active state and generated manifests to the current schema;
- preserve user-authored name collisions in quarantine; and
- remain idempotent on a second run.

### Package Install Safety

- default npm `postinstall` restores only the build stamp inside the installed
  `sneakoscope` package and performs no project, HOME, Codex, global SKS, or
  `launchctl` mutation;
- every external setup action requires
  `SKS_POSTINSTALL_BOOTSTRAP=1`, while
  `SKS_POSTINSTALL_NO_BOOTSTRAP=1` overrides that authorization;
- normal package-managed installation tells the operator to run
  `sks bootstrap` explicitly;
- the installed-package smoke runs the packed lifecycle with scripts enabled
  in disposable roots and compares path, type, mode, size, and content hashes
  before and after installation.

## Required Product Evidence

### Menu Bar Control Center

- native Swift source compiles on macOS;
- install, restart, status, rollback, and uninstall paths are verified;
- update and MCP mutations are serialized and produce operation receipts;
- Control Center updates do not terminate the active UI before the final
  operation receipt is synchronized;
- failed generation or installation restores the prior known-good app;
- direct launch, launchd, Doctor, and update converge on exactly one global
  Menu Bar process under `~/.codex/sks-menubar`;
- update stops and verifies every prior companion before replacement, then the
  running-process version probe must equal the current package version;
- icons, notifications, action logs, and Codex lifecycle visibility are real;
- secrets never appear in menu rows, command arguments, logs, or receipts.

### MCP Manager

- global Codex MCP configuration is parsed and validated before mutation;
- list/add/enable/disable/remove operations use locks, backup, and atomic write;
- secret input travels through native secure input or stdin;
- legacy inline secrets are migrated without logging their values;
- malformed or user-owned configuration is preserved and reported.

### Update

- `sks.update-status.v3` is the shared status snapshot;
- TTL, refresh, single-flight, offline, and malformed-version cases are tested;
- update review records package, active Node/npm path, previous version, and
  rollback instructions;
- the previous binary runs a read-only migration preflight, while the newly
  installed package-local binary owns the migration-profile repair pass;
- every nested Doctor, npm lifecycle, and explicitly opted-in postinstall
  process inherits Menu Bar restart deferral while the update parent owns
  completion;
- migration-profile Doctor cannot apply or launch the Menu Bar phase;
- migration-profile Doctor treats the project migration receipt as the sole
  owner of legacy-surface mutation, then performs a fresh read-only
  public-surface inspection; pre-repair findings cannot remain as stale final
  blockers, and a failed post-receipt inspection still fails the update;
- the new binary is resolved and verified before success is reported;
- the exact npm-global package manifest and package-local entrypoint both
  report the target version, the first `sks` on the injected `PATH` reports
  that same version, and an older shadowing prefix fails closed instead of
  being masked by newer npm metadata;
- an interrupted update leaves a precise receipt and recovery path;
- the menu companion is rebuilt from the newly installed package;
- a fixture with 5,001 scanned directories completes `sks update`; bounded
  guidance truncation is reported as the non-blocking
  `guidance_scan_truncated` warning with its cutoff path/count and is never
  relabeled as legacy residue;
- regenerable `.venv`, `venv`, `target`, `.cache`, `.tox`, `__pycache__`,
  `Pods`, and `DerivedData` trees are excluded from nested guidance scanning;
- an unmanaged config already equal to the expected bytes passes verify-only,
  while a needed ownership change remains blocked with the exact file, marker,
  and `sks config adopt` remedy; adoption inserts only the marker after a
  backup and receipt;
- `sks update now`, including the already-current path used by the Control
  Center, runs a final read-only migration-profile Doctor after Menu Bar
  signature verification, records the exact `update_finalize_doctor` stage,
  and cannot pass final self-verification when that stage fails or times out;
- the new-version migration Doctor validates managed project and global
  `config.toml` syntax, writes guarded backups before repair, preserves
  user-owned project files, and treats TOML basic and literal strings
  equivalently; the final Doctor verifies that result without mutation; and
- codex-lb never asks a reusable interpreter or generic security process to
  read or write the gateway secret. The public CLI uses the owner-only `0600`
  env file; Keychain requests fail closed until a dedicated signed helper can
  prove its identity and post-write state.
- a Control Center update relaunches the companion only after install,
  verification, and receipt synchronization complete.
- Codex identity, model, reasoning effort, Fast state, user-owned catalog, and
  codex-lb routing mode are preserved across update; the gateway credential is
  never substituted into the shared Codex auth slot.

### OAuth Callback And Managed Skill Recovery

- Doctor performs one bounded, read-only TCP 1455 listener probe and reports a
  conflict only when a legitimate `127.0.0.1:1455` Codex listener coexists
  with a wildcard or IPv6 listener owned by a different process;
- only a detected conflict adds the `localhost` to `127.0.0.1` immediate-retry
  guidance to Doctor and Codex authentication failures; the probe never
  changes redirect URIs, Docker/codex-lb, processes, credentials, or ports;
- an unavailable or timed-out listener probe degrades to diagnostic
  unavailability without blocking unrelated Doctor work or leaking command
  lines;
- authoritative managed-skill digest repair is limited to confined regular
  non-symlink files with an SKS managed marker and matching canonical name;
- every managed-skill replacement creates a recoverable timestamped backup
  and durable migration-journal entry before the authoritative bytes are
  committed, including newer and unparseable legacy marker versions; and
- markerless, name-mismatched, symlinked, nonregular, or path-unsafe files
  remain byte-preserved and blocked. No digest allowlist or
  `sks.skills-manifest.v2` migration is permitted by this release.

### Codex Desktop Chat, Pro, And Fast

- repair removes only provenance-marked SKS global `model_provider`, `model`,
  and `model_reasoning_effort` locks that can suppress the native picker;
- user-owned providers, provider definitions, credentials, explicit settings,
  `service_tier = "fast"`, and `[features].fast_mode` are preserved;
- Fast remains a service-tier choice independent from reasoning effort;
- the menu bar reports verified Fast status and provides direct On/Off actions;
- unknown or failed Fast status is shown as unavailable, never as a false
  selected state; and
- codex-lb gateway authentication and routing mode never control whether the
  native model picker, Fast, image, Browser Use, Computer Use, voice, or
  plugins/apps surfaces are available; and
- live Desktop picker visibility remains a post-restart observation boundary,
  not something fixture or TOML evidence can prove by itself.

### codex-lb Routing Truth

- shared `~/.codex/auth.json` remains byte-preserved. The official provider
  uses it only when codex-lb is off; a selected codex-lb route authenticates
  with the separate gateway key and cannot silently fall back to OAuth;
- **Use codex-lb** commits the provider definition and top-level active
  selection in one guarded transaction, and update/repair preserve that choice;
- retired dual-auth compatibility configuration is detectable for migration
  but cannot be activated or reported ready because it requires a global GUI
  secret;
- activation requires one measured request to the configured remote base URL;
  Doctor and the Menu Bar must render the same target host, authentication
  class, measurement time, and latency, and roll back or remain blocked on
  failure;
- deep capability input is accepted only with a matching fresh producer,
  target, content hash, and out-of-band trust-anchor set;
- the full release real-check records current real Desktop evidence as optional
  live coverage for
  picker/Fast, image artifact, Computer Use feedback, browser, voice,
  plugins/apps, auxiliary routes, existing/new threads, disable/rollback,
  restart/reboot recovery, authentication-mode independence, the separately
  hosted other-Mac codex-lb runtime, and a measured gateway-key request whose
  target equals the selected remote base URL;
- absence of that evidence is `real_required_missing` for the standalone
  capability proof and remains explicit unproven live coverage in the release
  report; it does not make Linux CI or a CLI-only workstation impersonate a
  native Desktop runtime.

### Official Subagents And Remote

- Naruto evidence includes plan, lifecycle events, parent summary, evidence,
  work-order ledger, summary, and gate;
- every requested official thread has one trustworthy parent outcome;
- explicit `--agents` and `--max-threads` values from 1 through 256 remain
  authoritative rather than being reduced to automatic fan-out tiers;
- `--max-threads 256` is a child-slot ceiling and does not subtract the root a
  second time, but a lower external Codex host/session or provider/API limit is
  binding and must be named in the plan/evidence; 256 is not itself live-load
  proof;
- the official Remote transport remains host-owned. SKS does not implement,
  proxy, or reverse engineer that transport; readiness checks never present an
  SKS SSH session id as an official Remote session id;
- the separate SKS SSH stdio worker remains proof-aware fleet control through
  an allowlisted, typed channel for bounded input, verify, read, and
  owner-proof cancel. It is
  not a replacement for official high-fidelity Remote coding;
- SKS Telegram support is an outbound Bot API long-polling transport inside the
  existing Menu Bar process. It reuses the typed allowlisted control contract,
  stays silent for unauthorized chats while auditing rejection, keeps tokens
  in the existing secret store, and requires actor-bound two-step confirmation
  for destructive commands;
- Telegram readiness requires a real `getMe` round trip plus poller liveness,
  while release authorization additionally requires a real command/reply E2E
  from a cellular network. A token, fixture, local-network run, or Doctor
  readiness result cannot substitute for that live gate;
- Display state cannot satisfy completion proof.

### Database Safety

- database inspection is read-only by default;
- write authorization is explicit, scoped, and mission-bound;
- SQL-plane policy, read-back proof, profile closure, and rollback evidence are
  present for any authorized mutation;
- no live data mutation is performed by a release test unless the sealed test
  contract explicitly permits it.

## Physical 8.1.0 Release Gates

All four receipts below are required before `sks release stage` / OIDC staging
or a release-complete claim that includes those physical surfaces. Direct
`npm publish` still requires clean `main` and exact `v*` tags. Hermetic tests
remain necessary but cannot replace these environment-bound checks.

The tracked summary lives at
`release-evidence/<version>/physical-gates.json` with schema
`sks.release-physical-gates.v1`. It is bound to the exact package version and
40-character release-source commit. The tracked receipt may be added by a
later evidence-only commit; the validator accepts that only when the bound
source is an ancestor and every intervening changed path stays under the same
`release-evidence/<version>/` directory. Each of the four gate entries must declare
`evidence_kind: "real"`, reject fixture/mock/synthetic evidence, state that
secrets are absent and the summary is redacted, and bind a regular artifact
under the same version directory by SHA-256. Each artifact must be non-empty
and no larger than 8 MiB, keeping verification I/O bounded. Run
`node ./dist/scripts/release-physical-gates-check.js` before staging. Both the
local `sks release stage` preflight and the OIDC workflow enforce this check;
missing or stale evidence blocks before registry mutation.

1. **5,001-directory update scan:** run `sks update` in a large-repository
   fixture whose guidance traversal encounters 5,001 directories. The update
   must finish successfully; any bounded scan cutoff remains the explicit
   `guidance_scan_truncated` warning with cutoff path/count and contributes no
   false residue blocker.
2. **One current Menu Bar process:** begin with a prior-version companion,
   complete update, and prove the process inventory contains exactly one SKS
   Menu Bar. Its running-process version probe must equal 8.1.0. A build stamp
   without process readback is insufficient.
3. **Measured codex-lb request:** turn **Use codex-lb** on and capture one real
   request whose destination matches the configured remote base URL and whose
   authentication class is the issued gateway key, not ChatGPT OAuth. Doctor
   and Menu Bar must show the same measured host, time, and latency.
4. **Telegram cellular E2E:** from a cellular network, send one paired,
   allowlisted command; the Mac must execute the typed command and return its
   result through Telegram. Record the outbound/inbound receipt without the bot
   token. `getMe`, poller liveness, fixtures, and same-LAN traffic do not meet
   this gate.

This repository change records the gate contract only. It does not claim that
credentials were available, any live gate ran, or 8.1.0 was tagged, staged,
published, or deployed.

## Local Verification Order

The order is strict: cut the intended version once, then run every
version-bound check, write and verify the full release stamp, and only then run
the package dry-run. For this branch, 8.0.5 to 8.1.0 makes Control Center
provider buttons, status CTAs, and reliability inventory backends agree on
CLI vs Desktop Bridge paths. Earlier remediation and the one-time
7.6.0-to-8.0.0 major version cut already shipped and must not be rerun.

After that version cut, start from a clean dependency installation and one
clean build:

```bash
npm ci --ignore-scripts
npm run typecheck --silent
npm run build:clean --silent
npm test --silent
npm run architecture:check --silent
npm run feature-quality:check --silent
npm run release:check:affected --silent
npm run release:check:confidence --silent
```

Before any package dry-run, the full release preset must pass and its
source-bound stamp must verify:

```bash
npm run release:check:full --silent
node ./dist/scripts/release-check-stamp.js verify
node ./dist/scripts/release-registry-check.js --require-unpublished --require-pack-proof
npm publish --dry-run --json --registry https://registry.npmjs.org/ --tag latest --access public
```

The dry-run is registry-nonmutating. Its reproducibility preflight requires
clean `main`, live `origin/main`, and the current release stamp but does not
require a local or remote `v<version>` tag. The separate registry check above
proves the version is still unpublished. A real direct `npm publish` requires
clean `main`, live `origin/main`, and both tags to resolve to the exact HEAD.
The four source-bound physical release receipts are required by
`sks release stage` / the OIDC stage workflow, not by direct `npm publish`.

Focused checks must cover the changed Menu Bar, MCP, update, Remote,
official-subagent, managed-residue, command-surface, and release-pack paths.
`sks validate-artifacts latest` must pass for the owning mission before its
artifacts are cited as release evidence.

### TriWiki Code-Pack Freshness

`code-pack.json.git_head_sha` is the generation parent commit, not a
self-referential promise to equal the later commit that stores the pack.
`index_digest` is the deterministic scanned module/path tree-inventory digest;
it is not a replacement Git commit id. A later metadata-only code-pack commit
is fresh only when every committed path after `git_head_sha` is one of the two
tracked code-pack metadata files. Any source-path commit, invalid ancestry,
truncated history, parse uncertainty, Git failure, or timeout is stale or
inconclusive and cannot authorize release evidence. Final release proof runs
from a clean worktree and refreshes the pack after source changes.

## Package And Upgrade Proof

Inspect the exact packed file list and tarball, not only the source checkout.

- no source-only runtime import is required by the installed package;
- every installed-product runtime script reference is present in the tarball;
- checkout-only release harnesses are excluded only through an exact
  `runtime-required-scripts.json` policy bound to the referencing GitHub
  workflow; any product-runtime reference makes that exclusion invalid;
- installed help and command manifests contain only current commands;
- generated project guidance contains only current dollar routes;
- an isolated prefix install can run version, help, doctor, Naruto status, MCP
  status, update status, and Menu Bar diagnostics;
- the 7.6.0 to 8.1.1 upgrade smoke and focused 8.0.4-to-8.0.5 resolved-CLI
  regression use isolated HOME/prefix state and prove managed
  cleanup, user-file preservation, new-binary re-exec, rollback receipts,
  exact lifecycle command inventory, no timeout, no host HOME/prefix reuse,
  no unexpected `launchctl` call, and successful sandbox removal;
- the macOS proof embeds and rehashes the exact upgrade report, including its
  source commit, pack-receipt hash, tarball SHA-256/SHA-512, and target version;
- Linux package smoke and macOS native/Menu Bar smoke both pass.

Record the tarball path, size, SHA-256, integrity, file inventory, installed
smoke report, and platform-gate reports under the 8.1.1 release evidence root.

## Version Cut (Step 1, Before Local Verification)

Do not cut a release while feature integration or a required gate is red. Once
the cut is made, rerun every command in **Local Verification Order** because the
release stamp and package proof are version- and source-bound.

```bash
sks versioning bump minor --json
npm run build:clean --silent
npm run release:version-truth --silent
```

The `minor` increment is the explicit 8.0.5-to-8.1.0 Menu Bar provider wiring,
status-copy, and reliability-inventory parity cut. Earlier patches and the
one-time 7.6.0-to-8.0.0 `major` cut already shipped; do not rerun a version
command after `package.json` reports 8.1.0.

Package metadata, lockfile, runtime constants, Rust metadata, managed assets,
README, changelog, built output, and release evidence must agree on 8.1.1.
Sneakoscope does not install or rely on a Git pre-commit version hook.

## Trusted Staged Publishing

The publish workflow uses a GitHub-hosted runner, `id-token: write`, and npm
Trusted Publishing with the allowed action restricted to `npm stage publish`.
No long-lived npm write token is used. The workflow pins Node and npm to the exact
versions declared by the maintainer stage verifier, runs the full release and
platform dependencies, then stages the reviewed package.

The macOS proof job downloads the exact Linux-built tarball and receipt, runs
the isolated 7.6.0-to-current upgrade lifecycle against those bytes, and
seals the upgrade receipt hash and target identity into
`sks.macos-menubar-proof.v2`. The comparison job then runs the source-bound
main-push guard and includes both receipts in the immutable handoff; the OIDC
stage job revalidates their version, commit, receipt digest, tarball
SHA-256/SHA-512, isolation, lifecycle command/state inventory, paths, and
hashes before registry mutation.

Official npm requirements and workflow references:

- [Trusted publishing for npm packages](https://docs.npmjs.com/trusted-publishers/)
- [Staged publishing for npm packages](https://docs.npmjs.com/staged-publishing/)

Staging is not public publication:

```bash
npm stage publish
npm stage list sneakoscope
npm stage view <stage-id>
npm stage download <stage-id>
```

The downloaded staged tarball must match the locally reviewed package receipt.
A maintainer performs that authenticated, read-only comparison from a local
terminal. The release compatibility matrix binds the verifier to
`npx --yes npm@11.15.0`; the confirmed `sks release stage` flow resolves that
machine pin itself, leaving the operator's global npm installation unchanged.
Before it can push `main` or dispatch the staging workflow, preflight also
confirms that the checkout-local verifier exists and that the review is running
outside CI, GitHub Actions, and OIDC. A missing verifier, blocked environment,
unavailable pinned CLI, or version mismatch stops the command before any
release mutation.

```bash
node ./dist/scripts/npm-stage-tarball-verifier.js \
  --stage-id <stage-id> \
  --local-receipt <local-pack-receipt.json> \
  --local-tarball <reviewed-local-package.tgz> \
  --stage-receipt <workflow-stage-receipt.json>
```

`--local-receipt` binds the local pack inventory and hashes,
`--local-tarball` is the immutable tarball reviewed before staging, and
`--stage-receipt` is the workflow artifact that binds the staged bytes to the
release commit. The verifier runs only `npm stage view` and
`npm stage download`, writes a private comparison receipt, and refuses CI,
GitHub Actions, OIDC, publication, rejection, and approval environments.
A maintainer then performs the separate human approval step with 2FA:

```bash
npm stage approve <stage-id>
```

Automation must stop before this approval. It must not claim that 8.1.1 is
published while only a stage exists.

Because the trusted publisher is bound to the configured workflow on the
default branch, the verified release commit reaches `main` before the stage
workflow runs. A failed or rejected stage is discarded; the same version is
not restaged until the cause and version-uniqueness state are understood.

## Post-Publish Verification

After maintainer approval, verify the live registry independently:

```bash
npm view sneakoscope@8.1.1 version dist.integrity dist.tarball --json
npm view sneakoscope dist-tags --json
```

Then install `sneakoscope@8.1.1` into a fresh isolated prefix and rerun the
installed-package smoke. Completion requires the registry version to be
8.1.1, `latest` to resolve to 8.1.1, integrity to match, and the fresh install
to pass.

## Fail-Closed Rules

- Never overwrite an existing registry version.
- Never stage when required Linux, macOS, package, or upgrade evidence is red.
- Never treat `updated_with_issues` as success.
- Never replace a missing real integration with fallback implementation code.
- Never publish from an unreviewed tarball or a dirty generated build.
- Never automate the maintainer's 2FA approval.
- A defect found after publication requires a higher version; never replace
  the bytes of an already published version.

## Release Director Handoff

The final handoff records:

- release commit and `main` commit;
- gate commands and pass/fail receipts;
- unresolved or intentionally unverified checks;
- macOS and Linux evidence paths;
- upgrade-smoke receipt;
- tarball path, SHA-256, integrity, and file inventory;
- staged package ID and downloaded-stage comparison;
- whether maintainer 2FA approval is still pending; and
- post-publish registry/install evidence when approval has occurred.

No completion statement may exceed those receipts.
