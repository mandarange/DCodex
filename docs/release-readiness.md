# SKS 8.2.0 Release Readiness

## Current decision

**SOURCE PREPARED / RELEASE BLOCKED.** The Telegram arbitrary-bot correction
and 8.2.0 version surfaces are prepared locally. Publication is not authorized
by this state: the tree is not yet a clean promoted release commit, current
exact-commit receipts do not exist, the user's live BotFather flow has not been
exercised, and registry mutation remains an operator action.

Earlier SHA- or 8.1.3-bound artifacts are historical only. A version string,
focused test, configured credential, package dry run, or old green stamp cannot
authorize 8.2.0.

Evidence labels are intentionally narrow:

- **passed-hermetic** — current local source/build/test evidence only;
- **not-run-real** — no redacted target-bound live receipt exists; and
- **blocked-external** — a clean promoted commit, private credential, target
  environment, or operator authority is required.

The current execution surface is `$sks-naruto` / `sks naruto run`, with
`$sks-work` as the explicit plan-execution route. `sks doctor --fix` remains
an operator-run repair command and must not be invoked automatically. Update
and Control Center views share the `sks.update-status.v3` snapshot.

## 8.2.0 candidate scope

- SKS Center and the CLI accept any user-owned BotFather bot. Setup verifies
  `getMe` and binds the exact returned bot ID; it does not assume a product bot
  name or username.
- Every setup outcome uses the setup response schema. Identity rejection,
  network failure, timeout, and invalid identity have stable secret-free error
  codes; later setup failures retain neutral wording.
- Native receipts encode absent Telegram liveness values as JSON `null`, while
  the TypeScript reader accepts legacy 8.1.x receipts that omitted those
  optional keys.
- Package, lockfile, runtime, Rust, README, changelog, performance, and agent
  bridge version surfaces name 8.2.0.

These are source claims. They become release claims only after the exact
candidate commit passes the repository's release flow.

## Pre-commit preparation checks

Run from the integrated working tree before creating the final candidate
commit. Retain the command output, but do not treat it as exact-commit release
proof:

```sh
npm run typecheck
npm run build:clean
node --test --test-concurrency=1 \
  dist/core/telegram/__tests__/telegram-setup.test.js \
  dist/core/telegram/__tests__/telegram-private-storage.test.js \
  dist/core/telegram/__tests__/telegram-state-lock.test.js \
  dist/core/telegram/__tests__/telegram-transport.test.js \
  dist/commands/__tests__/doctor-telegram-runtime.test.js \
  dist/core/codex-app/__tests__/sks-menubar-telegram-runtime.test.js
node --test --test-concurrency=1 \
  test/unit/telegram-native-runtime.test.mjs \
  test/unit/telegram-state-lock-interop.test.mjs \
  test/unit/package-publish-lifecycle.test.mjs
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
npm view sneakoscope@8.2.0 version --json --registry https://registry.npmjs.org/
npm publish --dry-run --json \
  --registry https://registry.npmjs.org/ \
  --tag latest \
  --access public
```

Before publication, the version lookup should report that 8.2.0 is not already
present. The dry run is not publication. The user performs the actual publish,
push, tag, workflow dispatch, or approval separately.

## Real Telegram acceptance

A live arbitrary-bot check requires the user's private token and target Mac.
After installing the exact 8.2.0 candidate, the operator should save one owned
BotFather bot in SKS Center, confirm the displayed `getMe` identity, restart
the resident poller, pair one private chat, and run a bounded `/sks status {}`
round trip. Redact the token from every artifact. No hermetic test or configured
token flag substitutes for that target-bound receipt.

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
  --local-tarball /absolute/path/to/sneakoscope-8.2.0.tgz \
  --stage-receipt /absolute/path/to/npm-stage-receipt.json
```

The verifier does not approve, reject, publish, tag, or modify a stage.

The final migration matrix includes a `7.6.0 to 8.2.0 upgrade smoke`, covering
installed update finalization, Telegram receipt compatibility, preserved user
configuration, and the current command surface. Fixture success cannot replace
the real macOS and Telegram evidence described above.
