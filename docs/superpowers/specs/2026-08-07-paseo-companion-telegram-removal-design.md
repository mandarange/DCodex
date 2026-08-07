# Paseo Companion and Telegram Removal Design

## Goal

Release Sneakoscope Codex 8.3.0 without a first-party Telegram transport, make
[Paseo](https://paseo.sh/) the prominently recommended remote and cross-device
companion, and make this repository immediately usable from Paseo workspaces.

## Decision

Paseo remains an independent external product. Sneakoscope will not bundle its
daemon, wrap its CLI, probe its health, or own its authentication and relay
lifecycle. The repository will instead expose a committed `paseo.json` and
document the official Paseo installation and Codex launch flows.

This is preferred to either embedding Paseo as a dependency or retaining a
`sks telegram` compatibility shim. It keeps the trust boundary explicit,
avoids duplicating Paseo's mobile/desktop/web/relay lifecycle, and satisfies the
request to remove rather than rename the Telegram integration.

## Telegram Removal Boundary

The active Telegram surface is removed from:

- the CLI registry, help, command contracts, and command implementation;
- Doctor output and readiness projections;
- the TypeScript transport, state, token, pairing, polling, and audit modules;
- the native menu-bar poller and Telegram settings UI; the existing Remote
  Coding page becomes a static, accessible Paseo recommendation with links to
  its website and docs, not an integration wrapper;
- feature inventories, runtime/package manifests, release gates, physical
  evidence requirements, mutation allowlists, and active tests; and
- current README and release-readiness guidance.

`sks telegram` becomes an ordinary unknown command. Historical changelog
entries and narrowly scoped retired-bridge migration code remain as historical
and upgrade-safety records; neither is an active integration.

The release does not automatically revoke a BotFather token or delete an
operator's external bot. Existing verified cleanup code may remove only
provably SKS-owned retired runtime artifacts under its current confinement and
quarantine rules.

## Paseo Project Contract

The repository root gains `paseo.json` with:

- a worktree setup sequence of `npm ci --ignore-scripts` followed by
  `npm run build:clean`;
- named `build`, `typecheck`, `test`, `release-check`, and
  `release-confidence` scripts backed by existing package scripts; and
- no teardown, secret copying, daemon configuration, hard-coded ports, or
  external mutations.

Ignoring install scripts is deliberate: creating a Paseo worktree must not run
Sneakoscope's package postinstall against the operator's global Codex setup.
The explicit build leaves the worktree ready for commands and tests that use
`dist`.

The README and native Remote Coding page recommend Paseo's desktop app first;
the README also documents the official
`npm install -g @getpaseo/cli` plus `paseo` flow for headless use. It shows
`paseo run --provider codex`, worktree isolation, and the repository-provided
scripts without claiming that Sneakoscope installs, supports, or secures Paseo.

## Release Contract

All current version authorities move to `8.3.0`: npm package and lockfile,
Rust crate metadata, runtime version constant, README, current performance and
agent-bridge examples, changelog, and current release-readiness/proof docs.

Hermetic completion requires a clean build, focused regression tests, version
and documentation checks, affected/confidence release gates, and an npm pack
dry run. A live npm publish, git tag, push, GitHub workflow dispatch, Paseo
installation, Paseo pairing, and external Telegram token revocation are not
performed by this change.

## Failure and Verification Behavior

Paseo workspace commands surface the exit status of the underlying npm command;
there is no fallback that could mask a failed build or gate. Regression tests
exercise the removed user-visible Telegram command, Doctor projection, feature
inventory, and packed artifact. `paseo.json` is verified by parsing the real
artifact and executing its referenced repository commands; human-facing prose
is reviewed rather than protected by brittle text-matching tests.
