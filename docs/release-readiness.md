# SKS 7.5.0 Release Readiness

This document is the current fail-closed release contract for `sneakoscope`
7.5.0. The current package version on this branch is 7.5.0. It is a readiness
checklist, not evidence that the version has already been published.

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

## Required Product Evidence

### Menu Bar Control Center

- native Swift source compiles on macOS;
- install, restart, status, rollback, and uninstall paths are verified;
- update and MCP mutations are serialized and produce operation receipts;
- Control Center updates do not terminate the active UI before the final
  operation receipt is synchronized;
- failed generation or installation restores the prior known-good app;
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
- both the previous binary and newly installed package-local binary run
  migration-profile `doctor --fix`;
- every nested Doctor, npm lifecycle, and postinstall process inherits Menu Bar
  restart deferral while the update parent owns completion;
- migration-profile Doctor cannot apply or launch the Menu Bar phase;
- the new binary is resolved and verified before success is reported;
- an interrupted update leaves a precise receipt and recovery path;
- the menu companion is rebuilt from the newly installed package.
- a Control Center update relaunches the companion only after install,
  verification, and receipt synchronization complete.
- provider/auth mode, model, reasoning effort, managed catalog, and routing
  state are preserved across update; an OAuth backup never silently unselects
  an active codex-lb provider.

### Codex Desktop Chat, Pro, And Fast

- repair removes only provenance-marked SKS global `model_provider`, `model`,
  and `model_reasoning_effort` locks that can suppress the native picker;
- user-owned providers, provider definitions, credentials, explicit settings,
  `service_tier = "fast"`, and `[features].fast_mode` are preserved;
- Fast remains a service-tier choice independent from reasoning effort;
- the menu bar reports verified Fast status and provides direct On/Off actions;
- unknown or failed Fast status is shown as unavailable, never as a false
  selected state; and
- API-key auth with a preserved OAuth backup is reported as Chat/Pro inactive
  with an explicit OAuth restore action; no doctor or update path switches the
  auth class automatically; and
- live Desktop picker visibility remains a post-restart observation boundary,
  not something fixture or TOML evidence can prove by itself.

### Official Subagents, Remote, And Telegram

- Naruto evidence includes plan, lifecycle events, parent summary, evidence,
  work-order ledger, summary, and gate;
- every requested official thread has one trustworthy parent outcome;
- the official Remote transport remains host-owned. SKS does not implement,
  proxy, or reverse engineer that transport; readiness checks never present an
  SKS SSH session id as an official Remote session id;
- the separate SKS SSH stdio worker remains proof-aware fleet control through
  an allowlisted, typed channel for bounded input, verify, read, and
  owner-proof cancel. It is
  not a replacement for official high-fidelity Remote coding;
- same-Mac Telegram coding uses an explicit local machine target and dedicated
  Codex session binding rather than self-SSH or a guessed GUI session;
- Telegram setup verifies the bot, pairs one private chat/user, stores only a
  Keychain reference in config, and never prints or persists the token in
  project files, process arguments, logs, or receipts;
- the user LaunchAgent exposes verified start, stop, restart, and status
  lifecycle, while the first ordinary private-chat message creates the thread
  and starts its first turn in one App Server connection before persisting the
  binding; later text resumes that exact idle thread, waits for completion, and
  returns the final public response;
- a missing rollout may recreate a binding only when no prior turn was ever
  recorded; persisted Telegram history fails closed rather than being silently
  replaced;
- Telegram keeps durable aliases and idempotency records, rejects unpaired
  chats and project-scope drift, and never exposes arbitrary remote shell;
- Zellij is observability only and cannot satisfy completion proof.

### Database Safety

- database inspection is read-only by default;
- write authorization is explicit, scoped, and mission-bound;
- SQL-plane policy, read-back proof, profile closure, and rollback evidence are
  present for any authorized mutation;
- no live data mutation is performed by a release test unless the sealed test
  contract explicitly permits it.

## Local Verification Order

The order is strict: cut the intended version once, then run every
version-bound check, write and verify the full release stamp, and only then run
the package dry-run. For this branch, 7.4.0 to 7.5.0 is the one-time minor
version cut; if the branch already reports 7.5.0, do not bump it again.

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
npm publish --dry-run --json --registry https://registry.npmjs.org/ --tag latest --access public
```

Focused checks must cover the changed Menu Bar, MCP, update, Remote, Telegram,
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
- the 6.2.0 to 7.5.0 upgrade smoke uses an isolated HOME and proves managed
  cleanup, user-file preservation, new-binary re-exec, rollback receipts,
  exact lifecycle command inventory, no timeout, no host HOME/prefix reuse,
  no unexpected `launchctl` call, and successful sandbox removal;
- the macOS proof embeds and rehashes the exact upgrade report, including its
  source commit, pack-receipt hash, tarball SHA-256/SHA-512, and target version;
- Linux package smoke and macOS native/Menu Bar smoke both pass.

Record the tarball path, size, SHA-256, integrity, file inventory, installed
smoke report, and platform-gate reports under the 7.5.0 release evidence root.

## Version Cut (Step 1, Before Local Verification)

Do not cut a release while feature integration or a required gate is red. Once
the cut is made, rerun every command in **Local Verification Order** because the
release stamp and package proof are version- and source-bound.

```bash
sks versioning bump minor --json
npm run build:clean --silent
npm run release:version-truth --silent
```

The `minor` increment is the explicit 7.4.0-to-7.5.0 cut. Do not rerun it once
the branch already reports 7.5.0.

Package metadata, lockfile, runtime constants, Rust metadata, managed assets,
README, changelog, built output, and release evidence must agree on 7.5.0.
Sneakoscope does not install or rely on a Git pre-commit version hook.

## Trusted Staged Publishing

The publish workflow uses a GitHub-hosted runner, `id-token: write`, and npm
Trusted Publishing with the allowed action restricted to `npm stage publish`.
No long-lived npm write token is used. The workflow pins Node and npm to the exact
versions declared by the maintainer stage verifier, runs the full release and
platform dependencies, then stages the reviewed package.

The macOS proof job downloads the exact Linux-built tarball and receipt, runs
the isolated 6.2.0-to-current upgrade lifecycle against those bytes, and
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
terminal with exact npm `11.15.0`:

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

Automation must stop before this approval. It must not claim that 7.5.0 is
published while only a stage exists.

Because the trusted publisher is bound to the configured workflow on the
default branch, the verified release commit reaches `main` before the stage
workflow runs. A failed or rejected stage is discarded; the same version is
not restaged until the cause and version-uniqueness state are understood.

## Post-Publish Verification

After maintainer approval, verify the live registry independently:

```bash
npm view sneakoscope@7.5.0 version dist.integrity dist.tarball --json
npm view sneakoscope dist-tags --json
```

Then install `sneakoscope@7.5.0` into a fresh isolated prefix and rerun the
installed-package smoke. Completion requires the registry version to be
7.5.0, `latest` to resolve to 7.5.0, integrity to match, and the fresh install
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
