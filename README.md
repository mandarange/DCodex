# Sneakoscope Codex

![](https://github.com/mandarange/Sneakoscope-Codex/raw/dev/docs/assets/sneakoscope-codex-logo.png)

Sneakoscope Codex (`sks`, displayed as `ㅅㅋㅅ`) is a Codex CLI/App harness for repeatable agent workflows. It adds terminal commands, Codex App `$` prompt commands, cmux-native CLI workspaces, Team/Ralph/QA/Research routes, Context7 evidence checks, DB safety, TriWiki context tracking, Honest Mode, and release-readiness gates.

## Quick Start

Install globally, then run `sks` from either a project or any global shell location:

```sh
npm i -g sneakoscope
sks root
sks bootstrap
sks
```

`sks root` tells you whether SKS found a project root or is using the per-user global runtime root. Outside a repo/project marker, runtime commands such as `sks`, `sks deps check`, `sks pipeline status`, and `sks team ...` use that global root instead of writing `.sneakoscope` into the random current directory.

If you only want a one-shot run without keeping `sks` installed globally:

```sh
npx -y -p sneakoscope sks root
```

For a repo-local install:

```sh
npm i -D sneakoscope
npx sks setup --install-scope project
```

Check that the install is usable:

```sh
sks deps check
sks codex-app check
sks dollar-commands
sks selftest --mock
```

## What Sneakoscope Adds

| Area | What it does |
| --- | --- |
| CLI runtime | `sks`, `sks cmux`, and `sks --mad` open Codex CLI in a cmux workspace. |
| Codex App commands | Installs generated skills so `$Team`, `$DFix`, `$QA-LOOP`, `$Ralph`, `$DB`, `$Wiki`, `$Help`, and related routes are visible in prompt workflows. |
| Team orchestration | Runs substantial work through ambiguity handling, scouts, TriWiki refresh, debate, runtime task graphs, worker inboxes, implementation, review, cleanup, reflection, and Honest Mode. |
| QA loop | Dogfoods UI/API behavior with safety gates, Browser/Computer evidence, safe fixes, and rechecks. |
| Ralph | Clarifies once, seals a decision contract, then continues without repeatedly asking the user. |
| TriWiki | Maintains `.sneakoscope/wiki/context-pack.json` as the context SSOT with `attention.use_first` and `attention.hydrate_first`. |
| Context7 | Requires current docs for external packages, APIs, MCPs, SDKs, and framework/runtime behavior when correctness depends on current guidance. |
| DB safety | Treats SQL, migrations, Supabase, RLS, and destructive operations as high risk. |
| Release hygiene | Checks versioning, changelog, package contents, tarball size, syntax, selftests, and dry-run publishing. |

## Requirements

- Node.js `>=20.11`
- npm
- Codex CLI for terminal workflows
- Codex App for app-facing workflows and first-party Browser Use / Computer Use parity
- cmux for the CLI-first runtime
- Context7 MCP for current-docs-gated routes

On macOS, `sks --mad` can install cmux through Homebrew when cmux is missing. You can also install it manually:

```sh
brew tap manaflow-ai/cmux
brew install --cask cmux
```

If the CLI is not on `PATH`, SKS also checks the app bundle path:

```sh
/Applications/cmux.app/Contents/Resources/bin/cmux
/Applications/cmux.app/Contents/MacOS/cmux
```

`sks --mad` is stricter than the normal runtime path:

- Checks npm for a newer `sneakoscope` before launch and asks whether to update when the terminal can answer y/n.
- Installs the latest Codex CLI with `npm i -g @openai/codex@latest` when it is missing and you approve or pass `--yes`.
- Installs or upgrades the latest cmux cask through Homebrew when cmux is missing or not launchable.
- Re-probes the real cmux binary after install instead of trusting Homebrew's success text alone.
- Wakes cmux and retries the socket probe; if the socket is broken, SKS attempts a cmux app restart during that explicit launch.
- Reuses the named SKS MAD cmux workspace when it already exists and closes duplicate SKS-named MAD workspaces instead of increasing the workspace count on every launch.

## Installation

### Global Install

Use this when you want `sks` available from any repo:

```sh
npm i -g sneakoscope
sks root
sks bootstrap
```

`sks` commands work even when no project root is present. Project-aware commands use the nearest `.sneakoscope`, `.dcodex`, or `.git` root; if none exists, SKS uses a per-user global runtime root. `sks bootstrap` still initializes the current project when you want project-local hooks, skills, and TriWiki state.

### One-Shot Install

Use this when you do not want to keep a global install:

```sh
npx -y -p sneakoscope sks bootstrap
```

`npx` fetches the package into npm's cache and runs the binary for that command. This is useful for first-time setup or CI-style verification.

### Project Install

Use this when a repo should pin Sneakoscope as a development dependency:

```sh
npm i -D sneakoscope
npx sks setup --install-scope project
```

Project installs are useful when a team wants a repeatable harness version checked through `package-lock.json`.

### Source Checkout

Use this when developing Sneakoscope itself:

```sh
git clone https://github.com/mandarange/Sneakoscope-Codex.git
cd Sneakoscope-Codex
npm install
npm install -g .
sks --version
```

## Terminal CLI Usage

Use terminal commands when you want to inspect, set up, verify, or start a CLI-first workspace.

### Discovery

```sh
sks commands
sks usage install
sks usage team
sks usage codex-app
sks dollar-commands
sks --version
```

### Setup And Repair

```sh
sks bootstrap
sks deps check
sks deps install cmux
sks codex-app check
sks doctor --fix
sks fix-path
```

### Open Codex CLI With cmux

```sh
sks
sks cmux check
sks cmux status --once
```

`sks` opens a cmux workspace for Codex CLI when running in an interactive terminal. `sks cmux check` is diagnostic and prints readiness without starting a workspace.

### MAD cmux Workspace

```sh
sks --mad
sks --mad --yes
```

This creates/uses the `sks-mad-high` Codex profile for a one-shot full-access, high-reasoning cmux workspace with `approval_policy = "on-request"` and `approvals_reviewer = "auto_review"`. It is scoped to that explicit command and does not change normal SKS/DB safety defaults. Repeat launches select the existing named SKS MAD workspace and clean duplicate SKS-named MAD workspaces instead of creating an endless workspace list.

MAD does not disable the pipeline contract: stages, executors, reviewers, and auto-review policy still must not invent unrequested fallback implementation code. If the requested path cannot be implemented, SKS should block with evidence rather than add substitute behavior.

Before launching, SKS checks whether a newer `sneakoscope` exists on npm. In an interactive terminal it prompts:

```text
SKS 0.x.y -> 0.x.z update before MAD launch? [Y/n]
```

Answer `y` to install `sneakoscope@latest`, then rerun `sks --mad`. Answer `n` to continue with the current version. Use `--yes` to approve missing dependency installs automatically.

### Team Missions

```sh
sks team "implement this feature" executor:3 reviewer:1
sks team watch latest
sks team lane latest --agent analysis_scout_1 --follow
sks team status latest
sks team log latest
```

Team mode prepares the mission, records live events, compiles runtime tasks and worker inboxes, and opens cmux live lanes when cmux is available. `sks team lane` renders one agent's status, assigned runtime tasks, recent events, and a fallback global tail for multi-pane monitoring.

### QA, Ralph, Research, DB, Wiki, GX

```sh
sks qa-loop prepare "http://localhost:3000"
sks qa-loop run latest --max-cycles 2
sks ralph prepare "migrate this workflow without asking after prepare"
sks research prepare "evaluate this approach"
sks db scan --json
sks wiki refresh
sks wiki validate .sneakoscope/wiki/context-pack.json
sks gx init homepage
sks gx render homepage --format html
```

## Codex App Usage

Sneakoscope has two surfaces:

- Terminal commands such as `sks deps check`, `sks team "task"`, and `sks --mad`
- Codex App prompt commands such as `$Team`, `$DFix`, `$QA-LOOP`, and `$Wiki`

After installing, run:

```sh
sks bootstrap
sks codex-app check
sks dollar-commands
```

Then open Codex App and use prompt commands directly in the chat. Examples:

```text
$Team implement the checkout fix and verify it
$DFix change this label and spacing only
$QA-LOOP dogfood localhost:3000 and fix safe issues
$Ralph clarify once, then finish the migration without more questions
$Wiki refresh and validate the context pack
$DB inspect this migration for destructive risk
```

Generated app files include:

| Path | Purpose |
| --- | --- |
| `.codex/SNEAKOSCOPE.md` | Codex App quick reference and route guidance. |
| `.agents/skills/` | Generated skill instructions for `$` commands. |
| `.codex/hooks.json` | Stop/finalization hooks for Honest Mode and completion summaries. |
| `.codex/config.toml` | Codex profiles, agents, and MCP configuration. |
| `.sneakoscope/` | Runtime state, missions, wiki packs, policies, and artifacts. |

Use `sks dollar-commands` to confirm that terminal discovery and Codex App prompt commands agree.

## Prompt `$` Commands

Use these inside Codex App or another agent prompt. They are prompt commands, not terminal commands.

| Prompt | Use when |
| --- | --- |
| `$Team` | You want implementation, code changes, or substantial repo work. |
| `$From-Chat-IMG` | You have a chat screenshot plus original attachments and want each visible request mapped to work. |
| `$DFix` | You need a tiny design/content edit such as copy, label, color, spacing, or translation. |
| `$Answer` | You want an answer only and no implementation should start. |
| `$SKS` | You need setup, status, usage, or workflow help. |
| `$QA-LOOP` | You want UI/API dogfooding, safe fixes, and rechecks. |
| `$Ralph` | You want one prepare-time clarification pass, then no more user questions. |
| `$Research` | You need frontier-style research with hypotheses and falsification. |
| `$AutoResearch` | You want iterative improve/test/keep-or-discard optimization. |
| `$DB` | You need database, Supabase, migration, SQL, or MCP safety checks. |
| `$MAD-SKS` | You explicitly authorize a scoped high-risk DB permission modifier for the active invocation only. |
| `$GX` | You need deterministic visual context cartridges. |
| `$Wiki` | You want TriWiki refresh, pack, prune, validate, or maintenance. |
| `$Help` | You want installed command and workflow explanation. |

## Common Workflows

### First Install Checklist

```sh
npm i -g sneakoscope
sks bootstrap
sks deps check
sks codex-app check
sks dollar-commands
sks selftest --mock
```

### Start A CLI Workspace

```sh
sks cmux check
sks
```

For the high-reasoning full-access profile:

```sh
sks --mad
```

### Use Codex App `$Team`

```text
$Team implement the requested change, update docs if needed, and verify with the relevant tests
```

Team mode records a mission under `.sneakoscope/missions/`, keeps a live transcript, uses TriWiki context, and finishes with evidence and Honest Mode.

### Dogfood A UI Or API

```sh
sks qa-loop prepare "http://localhost:3000"
sks qa-loop run latest --max-cycles 2
sks qa-loop status latest
```

Use `$QA-LOOP` in Codex App when Browser Use or Computer Use evidence should be part of the workflow.

### Refresh Context Before Risky Work

```sh
sks wiki refresh
sks wiki validate .sneakoscope/wiki/context-pack.json
```

TriWiki is the long-running context source of truth. It keeps compact high-trust recall in `attention.use_first` and source-hydration targets in `attention.hydrate_first`.

## Safety Model

Sneakoscope intentionally treats these as high-risk:

- SQL and migrations
- Supabase MCP and RLS changes
- destructive filesystem operations
- user-global harness config
- published package/release state

By default, SKS favors inspection, local files, branch-safe changes, explicit confirmation for destructive DB operations, and completion claims backed by tests or artifacts.

## Troubleshooting

### `sks` points to an old version

```sh
which sks
sks --version
node ./bin/sks.mjs --version
npm install -g .
```

If the global command is stale, reinstall globally from the repo or from npm.

### cmux is missing

```sh
sks deps install cmux
sks cmux check
```

`sks --mad` also attempts Homebrew installation or upgrade automatically on macOS when cmux is missing. If Homebrew reports the cask installed but the CLI still is not reachable, SKS checks the cmux app bundle paths directly, wakes the app, and retries the socket before reporting a remaining cmux app/socket issue.

### Codex App tools are missing

```sh
sks codex-app check
codex mcp list
```

Codex App workflows need the app installed and the first-party Browser Use / Computer Use tools available for parity with QA and visual workflows.

### Setup is blocked by another harness

```sh
sks conflicts check
sks conflicts prompt
```

OMX/DCodex conflicts intentionally block setup/doctor until the user approves cleanup.

### The route is stuck or a final hook keeps reopening

```sh
sks pipeline status --json
sks team watch latest
sks team lane latest --agent parent_orchestrator --follow
sks wiki validate .sneakoscope/wiki/context-pack.json
```

Finalization requires real evidence, no unsupported critical claims, valid Team cleanup artifacts, reflection when required, and Honest Mode.

## Development And Release

Run local checks:

```sh
npm run repo-audit
npm run changelog:check
npm run packcheck
npm run selftest
npm run sizecheck
npm run release:check
```

Dry-run publish:

```sh
npm run publish:dry
```

`publish:dry` proves the local package is packable. It does not prove npm ownership, OTP, or registry publish permission.

## Documentation Style

This README follows a common open-source CLI shape:

- quick start first
- explicit install paths
- separate CLI and app/plugin usage
- command examples before internal architecture
- troubleshooting and release checks near the end

That shape mirrors how projects such as `rdme` and Vite separate quick start, setup/configuration, and CLI usage while keeping copy-ready commands visible.

## License

MIT
