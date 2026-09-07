<div align="center">

<img src="docs/assets/sks-logo.svg" alt="Sneakoscope Codex logo" width="120" height="120" />

# Sneakoscope Codex

**Plan, build, and verify with Codex.**

[![npm version](https://img.shields.io/npm/v/sneakoscope?color=cb3837&logo=npm)](https://www.npmjs.com/package/sneakoscope)
[![node](https://img.shields.io/badge/node-%3E%3D20.11-339933?logo=node.js&logoColor=white)](#requirements)
[![license](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

</div>

<!-- BEGIN SKS SEARCH VISIBILITY MARKETING -->
Sneakoscope Codex (`sks`) is an open-source trust layer for Codex CLI and ChatGPT Desktop. It coordinates bounded AI coding agents, records machine-verifiable evidence, preserves project memory, and blocks release claims that are not supported by current tests or artifacts. Search visibility outcomes are measured separately; SKS does not promise rankings or traffic.
<!-- END SKS SEARCH VISIBILITY MARKETING -->

Current package: **SKS 10.1.3**. Install the latest stable release from npm.

[Quick start](#install-in-one-command) · [Commands](#everyday-commands) · [SKS Center](#sks-center-macos) · [Documentation](#documentation) · [Changelog](CHANGELOG.md)

## Install in one command

```sh
npm exec --yes --package=sneakoscope@latest -- sneakoscope install --yes
```

The installer resolves the latest release, installs it globally, runs setup and
Doctor, and checks that `sks` on your PATH points to the installed version.

To set up a project, run this from its root, then open it in Codex:

```sh
sks bootstrap --yes
```

## What SKS adds

| Capability | What you get |
| --- | --- |
| Focused execution | Small tasks stay lightweight; independent work can use official Codex subagents with parent-owned integration. |
| Project context | TriWiki indexes repository code and supplies bounded context that can be checked against source. |
| Verification | Tests, diagnostics, and release evidence support completion claims. Security and data-integrity checks stay in place. |
| Native controls | SKS Center brings connections, updates, MCP servers, and diagnostics together on macOS. |
| Consistent setup | `sks update` installs the latest release, runs Doctor, and reconciles SKS-managed files and legacy assets. |

The default `essential` profile avoids repetitive completion rituals. `strict`
adds stronger completion requirements. See [Essential Trust](docs/essential-trust.md).

With Codex-LB connected, `sks agent-bridge async --prompt "Check SKS status while
explaining what the check covers" --tools status --json` runs native Astra Async
tool calling with selected read-only SKS tools, using WebSocket first and safe
HTTP fallback. See [Astra guidance](docs/astra-guidance.md)
for setup boundaries and reported execution evidence.

## Everyday commands

SKS enables experimental Astra context management by default during setup and
repair. Turn it off in **SKS Center → Settings → Astra context management**, or
use `sks codex-app context-management off`. Updates preserve an explicit opt-out.
Start a new task after changing the setting. Availability depends on a supported
Codex client and eligible ChatGPT sign-in; API-key and custom-provider sessions
may not activate it. See [OpenAI's context management guidance](https://learn.chatgpt.com/docs/models#experimental-context-management).

Use these inside a Codex conversation:

| Command | Purpose |
| --- | --- |
| `$sks-plan "task"` | Create a plan without editing product code. |
| `$sks-work` | Execute the latest plan. |
| `$sks-naruto "task"` | Run an official subagent workflow. |
| `$sks-review` | Review the current changes. |
| `$sks-help` | Explore available SKS workflows. |

Use these in your terminal:

```sh
sks --help
sks status --json
sks review --staged
sks doctor --json
sks update-check
sks update
```

`sks update` runs setup reconciliation even when the package is already current.
It preserves user-authored configuration and cleans up recognized SKS-owned
legacy assets. If a check needs attention, follow its reported recovery action
in your terminal.

## SKS Center (macOS)

Open **SKS Control Center** from the SKS menu bar.

| Page | Use it to |
| --- | --- |
| Overview | Check local health and find the next action. |
| Connections | Connect Codex-LB or OpenRouter, choose authentication priority, and manage exposed models. |
| Updates | Check and update SKS and Codex CLI, with operation progress and recovery details. |
| MCP Servers | Manage server configuration, health checks, and authentication. |
| Diagnostics | Inspect issues and run targeted checks. |
| Settings | Configure lifecycle behavior, notifications, and advanced options. |
| Remote Coding | Find the independent [Paseo companion](https://paseo.sh/docs) and its setup guidance. |

Connection controls appear first. Model catalogs, bridge diagnostics, and
advanced settings expand when you need them.

## Desktop Bridge

One local bridge manages routing for independent **Codex-LB** and **OpenRouter**
profiles. ChatGPT sign-in remains owned by Codex. Provider choices and existing
session pins remain authoritative; unavailable routes are reported explicitly.

In **Connections**, turn on **Prefer Codex-LB** to use the saved Codex-LB
connection first for eligible models. The switch distinguishes a saved preference
from connection readiness: **on but unavailable** means setup needs attention.
Turning it off restores the configured official-model routing preference.

The same controls are available from the CLI:

```sh
sks bridge auth-priority status --json
sks bridge auth-priority on --json
sks bridge auth-priority off --json
sks bridge status --json
sks bridge route explain gpt-6-astra --json
```

Enter credentials through the native connection dialog or the CLI's
`--api-key-stdin` option. See the [provider guide](docs/codex-lb.md) for
configuration, transport checks, and recovery commands.

## Naruto workflow

SKS uses official Codex subagents. The parent owns decomposition, integration,
and final verification; children receive bounded tasks and do not spawn children.

| Work | Managed model | Effort |
| --- | --- | --- |
| Tiny mechanical tasks | GPT-5.6 Luna | max |
| Exploration, large-context reads, and direct tool operation | GPT-6 Astra | medium |
| Implementation | GPT-6 Astra | high |
| Review, debugging, and focused judgment | GPT-6 Astra | max |

An active Codex task keeps the user's selected main model, effort, and service
tier. Codex native `/goal` remains the persisted goal owner. Parallelism depends
on useful independent work and the host's available capacity.

See the [Naruto guide](docs/naruto.md) for explicit agent counts, role preferences,
trust boundaries, and completion evidence.

## Project context

```sh
sks align run
sks search context "How does authentication routing work?" --json
sks wiki validate .sneakoscope/wiki/context-pack.json --json
```

`align` rebuilds the repository navigation graph and its context projections.
These are generated local caches; refresh them after material changes. See the
[Context Graph guide](docs/architecture/context-graph.md) for source lookup and
freshness semantics.

## Requirements

- Node.js **20.11 or newer** and npm.
- Git for repository workflows and reviews.
- The latest stable Codex CLI or supported desktop host; capabilities are checked at runtime.
- macOS for the native menu bar and Center. Linux and Windows CLI support is best-effort.

## Documentation

- [Product contract](docs/PRODUCT-CONTRACT.md) — supported surfaces and ownership.
- [Essential Trust](docs/essential-trust.md) — verification profiles and safety boundaries.
- [Astra guidance](docs/astra-guidance.md) — how SKS applies the official model recommendations.
- [Agent Bridge](docs/AGENT-BRIDGE.md) — integrate through the CLI or MCP interface.
- [Codex-LB priority](docs/codex-lb-priority.md) — how Codex App WebSockets follow the Center priority setting.
- [Release readiness](docs/release-readiness.md) — build, verify, and publish a release.
- [Release evidence](docs/release-proof-truth.md) — what each verification result proves.
- [Changelog](CHANGELOG.md) — changes by version.

For development: `npm ci --ignore-scripts`, then `npm run build`.
Use `npm run typecheck` and `npm test` to verify changes; follow the release guide
before publication.

Questions or bugs? [Open an issue](https://github.com/mandarange/Sneakoscope-Codex/issues).

## License

[MIT](LICENSE)
