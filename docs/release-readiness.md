# SKS 8.3.2 Release Readiness

## Current decision

**SOURCE TAG CONDITIONAL / NPM PUBLICATION OPERATOR-OWNED.** The 8.3.2 source
candidate fixes two strict-decoder/contract drift regressions on top of the
shipped 8.3.1 baseline: the SKS Center Combined Model Catalog refresh no
longer rejects the Desktop Bridge status nested inside a command result (the
envelope trio `ok`/`execution_ok`/`command_summary` is allowed and
type-checked, never required), and the Codex Desktop model picker no longer
buries codex-lb gateway models (codex-lb rows sort before openrouter rows and
default to ModelInfo `priority` 100). Both fixes are pinned by regression
tests. A source tag is authorized only after the exact candidate commit passes
the repository checks and matches `origin/main`.
Registry publication remains an explicit operator action outside that source-tag
decision.

Earlier SHA- or 8.3.1-bound artifacts are historical only. A version string,
focused test, package dry run, or old green stamp cannot authorize 8.3.2.

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

## 8.3.2 candidate scope

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
  agent bridge version surfaces name 8.3.2.

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
npm view sneakoscope@8.3.2 version --json --registry https://registry.npmjs.org/
npm publish --dry-run --json \
  --registry https://registry.npmjs.org/ \
  --tag latest \
  --access public
```

Before publication, the version lookup should report that 8.3.2 is not already
present. The dry run is not publication. The user performs the actual publish,
push, tag, workflow dispatch, or approval separately.

## Removed-surface and Paseo contract

8.3.2 has no live Telegram credential, BotFather, pairing, poller, or cellular
round-trip evidence requirement. Release verification instead proves that the
active Telegram surface is absent and that the checked-in `paseo.json`, README,
package scripts, package metadata, Rust metadata, and runtime version agree with
the 8.3.2 contract.

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
  --local-tarball /absolute/path/to/sneakoscope-8.3.2.tgz \
  --stage-receipt /absolute/path/to/npm-stage-receipt.json
```

The verifier does not approve, reject, publish, tag, or modify a stage.

The final migration matrix includes a `7.6.0 to 8.3.2 upgrade smoke`, covering
installed update finalization, guarded retired-state cleanup, preserved user
configuration, and the current command surface. Fixture success cannot replace
real macOS evidence required by other protected gates.
