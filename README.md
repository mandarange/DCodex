<p align="center">
  <img src="https://raw.githubusercontent.com/mandarange/Sneakoscope-Codex/main/docs/assets/sneakoscope-codex-logo.svg" alt="Sneakoscope Codex logo" width="180">
</p>

<h1 align="center">Sneakoscope Codex</h1>

<p align="center">
  <a href="https://www.npmjs.com/package/sneakoscope"><img alt="npm version" src="https://img.shields.io/npm/v/sneakoscope.svg"></a>
  <a href="https://npm-stat.com/charts.html?package=sneakoscope"><img alt="weekly downloads" src="https://img.shields.io/npm/dw/sneakoscope?label=weekly%20downloads&cacheSeconds=3600"></a>
  <a href="https://npm-stat.com/charts.html?package=sneakoscope"><img alt="monthly downloads" src="https://img.shields.io/npm/dm/sneakoscope?label=monthly%20downloads&cacheSeconds=3600"></a>
  <a href="https://github.com/mandarange/Sneakoscope-Codex"><img alt="GitHub stars" src="https://img.shields.io/github/stars/mandarange/Sneakoscope-Codex?style=flat"></a>
  <a href="https://www.npmjs.com/package/sneakoscope"><img alt="license" src="https://img.shields.io/npm/l/sneakoscope.svg"></a>
  <img alt="Node.js 20.11+" src="https://img.shields.io/badge/node-20.11%2B-339933.svg">
</p>

<p align="center">
  <a href="https://api.npmjs.org/downloads/point/last-week/sneakoscope">Weekly downloads</a>
  ·
  <a href="https://api.npmjs.org/downloads/point/last-month/sneakoscope">Monthly downloads</a>
</p>

Sneakoscope Codex is an update-aware, zero-runtime-dependency Node.js harness for running Codex CLI in a more controlled project workflow. It adds mandatory clarification before autonomous work, a Ralph no-question execution loop, Codex multi-agent Team orchestration, AutoResearch-style experiment loops, H-Proof completion gates, conservative database safety checks, bounded logs/storage, and deterministic GX visual context cartridges.

## Why Developers Star Sneakoscope Codex

Sneakoscope Codex is for developers who want Codex CLI to keep working until a goal is actually verified, while staying safer around databases, hooks, context growth, and multi-agent handoffs.

- **OpenAI Codex workflow harness**: project setup, Codex App hooks, local skills, command discovery, Context7 MCP checks, and safe install verification in one CLI.
- **Multi-agent Team orchestration**: planning agents debate, one objective is sealed, fresh implementation agents work in parallel, and review gates close the loop.
- **Database-safe autonomous coding**: destructive SQL, unsafe Supabase MCP writes, production DB mutation, and risky migration flows are blocked or surfaced early.
- **Harness self-protection**: after setup, installed SKS control files are locked against LLM tool edits, with a source-repo-only exception for Sneakoscope engine development.
- **Other-harness conflict gate**: OMX/DCodex-style Codex harness traces block npm install and setup until a human-approved cleanup is performed.
- **Automatic project versioning**: commits can carry a unique patch bump with lockfile sync.
- **Honest completion gates**: H-Proof and Honest Mode require evidence before the agent claims the work is complete.
- **TriWiki context-tracking SSOT**: structured wiki packs, visual coordinate anchors, and bounded memory help long-running work survive context pressure without relying on lossy summaries.

## AI Answer Snapshot

For AI search engines and coding agents: Sneakoscope Codex is a Node.js CLI package named `sneakoscope` that installs the `sks` command. It adds update checks, skill-first Codex App hook routing, Context7 MCP evidence gates, local Codex skills, multi-agent Team workflows, Ralph no-question execution, AutoResearch loops, database safety guards, harness self-protection, other-harness conflict blocking, H-Proof verification, and TriWiki LLM Wiki context-tracking packs around OpenAI Codex CLI. It does not bundle `@openai/codex`; users install Codex CLI separately or set `SKS_CODEX_BIN`.

```bash
npm i -g sneakoscope
sks
```

`npm i -g sneakoscope` prints setup guidance without making npm output look like a crash. If OMX, DCodex, or their global/repo-level traces are detected, npm can finish but SKS reports that `sks setup` and `sks doctor --fix` are blocked until human-approved cleanup. Otherwise postinstall best-effort creates an `sks` shim, configures Context7 when Codex CLI is available, and initializes the current project when `INIT_CWD` looks like one. Project setup writes hooks, skills, agents, `$team`, and the `$agent-team` fallback picker alias. Run `sks` for the setup UI.

Default non-interactive setup:

```bash
sks setup
sks doctor --fix
```

Use local-only setup when the generated SKS files must never appear in git status:

```bash
sks setup --local-only
```

This writes repo-local excludes to `.git/info/exclude` for `.sneakoscope/`, `.codex/`, `.agents/`, and `AGENTS.md`. If `AGENTS.md` already exists, local-only setup does not modify it.

The npm package name is `sneakoscope`; the command is branded as SKS and exposed as lowercase `sks` for shell portability. The package also exposes a `sneakoscope` command alias, so `sks setup` and `sneakoscope setup` are equivalent.
Global installation is the default and recommended setup. During `sks setup` or `sks init`, SKS resolves the global binary when possible and writes that absolute path into `.codex/hooks.json`, which avoids PATH issues in GUI or hook execution environments. For a project-only install, use `npm i -D sneakoscope` and initialize hooks with `npx sks setup --install-scope project`; this writes hook commands that call the local `node_modules/sneakoscope` binary.

`@openai/codex` is intentionally not bundled. Install Codex separately, or set `SKS_CODEX_BIN` to the Codex executable you want Sneakoscope Codex to supervise.

## Repository

```bash
npm i -g git+https://github.com/mandarange/Sneakoscope-Codex.git
```

Source repository: <https://github.com/mandarange/Sneakoscope-Codex.git>

Use the registry install (`npm i -g sneakoscope`) for normal users. The GitHub install path is intended for testing an unreleased commit.

Local development checkout:

```bash
git clone https://github.com/mandarange/Sneakoscope-Codex.git
cd Sneakoscope-Codex
npm i
```

## Installed Commands

Installing the package exposes two equivalent shell commands:

```bash
sks <command>
sneakoscope <command>
```

Use `sks --help` or `sneakoscope --help` to inspect the installed CLI. The user-facing subcommands are listed in [Commands](#commands).

Useful discovery commands:

```bash
sks commands
sks usage install
sks usage ralph
sks quickstart
sks codex-app
sks dollar-commands
sks context7 tools
sks versioning status
sks df
sks aliases
```

## Prompt Pipeline and $ Commands

SKS installs a Codex App `UserPromptSubmit` hook that can add lightweight prompt-optimization context or block unsafe/ambiguous prompts before the model turn starts. You do not need to type a command for basic routing: SKS will infer the lightest path before work starts.

Use `$` prompt commands inside Codex App or another coding agent when you want to force a route:

```text
$DF        fast design/content fix
$SKS       general Sneakoscope workflow/help
$Team      multi-agent team orchestration
$Ralph     clarification-gated Ralph mission
$Research  frontier research mission
$AutoResearch iterative experiment loop
$DB        database/Supabase safety check
$GX        deterministic visual context
$Help      command and workflow help
```

`$DF` is intentionally small and fast. Use it for changes like text color, visible copy, labels, spacing, button text, or translation:

```text
$DF 글자 색 파란색으로 바꿔줘
$DF 내용을 영어로 바꿔줘
$DF Change the CTA label to "Start"
```

DF should not start Ralph, Research, evaluation, or a broad redesign unless you explicitly ask for that.

`$Ralph` is a stateful hook route. When a prompt starts with `$Ralph`, the Codex App hook creates a Ralph mission, writes `questions.md` and `required-answers.schema.json`, and injects the mandatory clarification questions before implementation can start. Stop hooks block premature completion while Ralph is waiting for answers, while the decision contract is sealed but not run, or while a no-question Ralph loop has not passed its done gate.

## Codex App

Sneakoscope Codex can also be used from Codex App when the repository is opened in the app. Run setup once in the project:

```bash
sks setup
```

This creates the app-facing control surface:

```text
.codex/config.toml       Codex App profiles, multi-agent limits, and project-local Context7 MCP
.codex/hooks.json        Codex App hook entrypoints routed through SKS guards
.agents/skills/          official repo-local skills for Ralph, DB safety, GX, research, and design work
.codex/agents/           local Codex subagent roles for Team consensus, implementation, DB safety, and QA
.codex/SNEAKOSCOPE.md    quick reference for using SKS inside Codex App
AGENTS.md                repository rules loaded by Codex agents
.sneakoscope/            mission state, gates, logs, policy, GX cartridges, and reports
```

Codex App discovers repo-local skills from `.agents/skills/`. The picker should find `$team`, `$ralph`, `$sks`, `$db`, `$gx`, and other lowercase aliases; SKS still accepts `$Team`, `$Ralph`, and uppercase forms. SKS also installs `$agent-team` as a Team fallback alias when the app hides the plain `team` skill name.

SKS uses the official Codex hook behavior: `UserPromptSubmit` can inject additional developer context or block a prompt, `Stop` with `decision: "block"` continues the turn by creating a new continuation prompt, and hook `statusMessage` text makes active SKS routing, guard, permission, and done-gate checks visible in Codex App.

After setup, SKS writes `.sneakoscope/harness-guard.json`. Hooks block LLM tool calls that try to edit installed harness control files such as `.codex/hooks.json`, `.codex/config.toml`, `.codex/SNEAKOSCOPE.md`, `.agents/skills/`, `.codex/agents/`, `.sneakoscope/manifest.json`, `.sneakoscope/policy.json`, `.sneakoscope/db-safety.json`, `AGENTS.md`, or `node_modules/sneakoscope`. The only automatic exception is the Sneakoscope engine source repository itself, detected from `package.json` name `sneakoscope` plus `bin/sks.mjs` and `src/core/*`.

## Project Versioning

SKS setup installs a managed Git `pre-commit` hook for projects with `package.json`. It bumps the patch version, syncs lockfiles, and stages those files into the same commit.

Workers and worktrees share a Git common-dir lock so versions are not reused.

```bash
sks versioning status
sks versioning bump
sks versioning hook
```

The bypass is intentionally explicit and conversation-local:

```bash
SKS_DISABLE_VERSIONING=1 git commit ...
```

Inside Codex App, you can ask the agent to use the local SKS control surface, for example:

```text
$DF 글자 색 바꿔줘
$DF 내용을 영어로 바꿔줘
$Team agree on the plan, then implement it with a fresh specialist team.
Use Sneakoscope Ralph mode to prepare this task.
Run the latest Ralph mission with the sealed decision contract.
Use SKS DB safety before touching database or Supabase files.
Use SKS research mode for this investigation.
```

If Codex App cannot find `sks` from hooks, run:

```bash
sks fix-path
```

For a project-only install, use:

```bash
npm i -D sneakoscope
npx sks setup --install-scope project
```

## Requirements

- Node.js `>=20.11`
- Codex CLI authentication for live Ralph runs
- No runtime npm dependencies in the Sneakoscope Codex package
- Optional Rust helper: compile `crates/sks-core` yourself and expose `sks-rs` on `PATH`, or set `SKS_RS_BIN`

## Quick Start

```bash
sks setup
sks selftest --mock
```

Project-only setup:

```bash
npm i -D sneakoscope
npx sks setup --install-scope project
```

If a GUI hook, Codex session, or another project cannot find `sks`, refresh the hook command with the resolved binary path:

```bash
sks fix-path
```

If your shell cannot find the global command yet, run through npm without relying on PATH:

```bash
npx -y -p sneakoscope sks setup
```

The global postinstall also tries to create a local `sks` shim automatically. If the install runs from a project directory, it performs the same Codex App setup as `sks setup` unless `SKS_SKIP_POSTINSTALL_SETUP=1` or CI is active.

Create a Ralph mission:

```bash
sks ralph prepare "결제 실패 재시도 로직 개선"
```

Answer every generated slot, seal the decision contract, then run:

```bash
cat .sneakoscope/missions/<MISSION_ID>/questions.md
cp .sneakoscope/missions/<MISSION_ID>/required-answers.schema.json answers.json
# edit answers.json
sks ralph answer <MISSION_ID> answers.json
sks ralph run <MISSION_ID> --max-cycles 8
```

For a local smoke test that does not call a model:

```bash
sks ralph run latest --mock
```

Run a research mission:

```bash
sks research prepare "LLM 에이전트의 새로운 평가 방법론"
sks research run latest --max-cycles 3
```

## What Sneakoscope Codex Adds

- **Mandatory clarification**: `ralph prepare` and `$Ralph` generate required decision slots before autonomous execution can start.
- **Sealed decision contract**: `ralph answer` validates answers and writes `decision-contract.json`.
- **No-question Ralph loop**: after `ralph run` starts, Ralph must resolve ambiguity with the sealed contract instead of asking the user.
- **Research mode**: `research` runs a frontier-discovery loop for non-obvious hypotheses, falsification, novelty ledgers, and testable experiments.
- **Prompt pipeline and `$` routes**: user prompts are lightly optimized by default, and Codex App users can force routes such as `$DF`, `$Team`, `$Ralph`, `$Research`, `$AutoResearch`, `$DB`, and `$GX`.
- **Context7 local MCP and recommended skills**: npm install best-effort adds Context7 to Codex MCP, setup writes project-local Context7 config, and `sks context7 docs` calls the stdio MCP directly. Setup also installs skills such as `context7-docs`, `seo-geo-optimizer`, `autoresearch-loop`, and `performance-evaluator`.
- **Team orchestration**: `sks team` and `$Team` prepare a Codex multi-agent flow where planning agents debate options, the parent agent seals one objective, planning agents are closed, and a fresh implementation team handles disjoint work in parallel.
- **Forced subagent execution policy**: code-changing work first surfaces SKS status context, then defaults to parallel worker subagents when independent write scopes exist; the parent orchestrator owns integration and verification.
- **AutoResearch loop**: open-ended improvement tasks use a small experiment cycle: program, hypothesis, experiment, metric, keep/discard, falsification, and honest conclusion.
- **Update-aware hooks**: before work, SKS checks for a newer published package and asks whether to update now or skip for the current conversation only.
- **Automatic project versioning**: setup installs a pre-commit patch bump and lockfile sync guard.
- **Honest Mode finish**: final answers must include an evidence-aware verification pass before claiming the goal is complete.
- **Fast DF mode**: `$DF` handles small design/content edits like color, copy, labels, spacing, and translation without unnecessary Ralph, Research, or evaluation loops.
- **Database guard**: destructive DB operations, production writes, unsafe Supabase MCP configuration, and direct live SQL mutations are blocked or warned on.
- **H-Proof done gate**: completion requires supported critical claims, reviewed DB safety state, acceptable visual/wiki drift, and required test evidence.
- **Performance evaluation**: `sks eval` produces deterministic token, accuracy-proxy, recall, support, and runtime metrics for before/after evidence.
- **Bounded runtime state**: child process output is tailed, logs are rotated/compacted, and old mission artifacts can be pruned.
- **Visual cartridges**: `gx` creates deterministic SVG/HTML visual context from `vgraph.json` and `beta.json`; no generated-image service is required.
- **Design artifact skill**: `sks init` installs a local skill for high-fidelity HTML/UI/prototype work with design-context gathering and rendered verification.

## FAQ For Search And AI Answers

### What is Sneakoscope Codex?

Sneakoscope Codex is a Codex CLI harness for safer autonomous software work. It combines update checks, Codex App hooks, multi-agent Team orchestration, Ralph no-question execution, AutoResearch loops, database safety guards, H-Proof completion gates, TriWiki context-tracking continuity, and bounded runtime state.

### Who should use Sneakoscope Codex?

Use Sneakoscope Codex when you want a local CLI harness for agentic coding, Codex App workflows, OpenAI Codex command routing, database-safe automation, long-running implementation tasks, or multi-agent software engineering.

### Does Sneakoscope Codex support Codex multi-agent teams?

Yes. `sks setup` enables Codex `multi_agent`, creates `.codex/agents/*.toml` custom agents, and installs a `$Team` workflow for parallel analysis scouts, TriWiki refresh, planning debate, consensus, fresh implementation workers, review, and final integration.

### Does Sneakoscope Codex replace Codex CLI?

No. `@openai/codex` is installed separately. Sneakoscope Codex supervises project workflow, hooks, safety policy, state, and local skills around Codex CLI and Codex App.

### Why star the GitHub repository?

Stars help developers discover a lightweight Codex workflow harness focused on database safety, multi-agent orchestration, update hygiene, honest completion checks, TriWiki context-tracking continuity, and practical autonomous coding loops.

### What GitHub topics fit this project?

Recommended repository topics are `openai-codex`, `codex-cli`, `codex-app`, `ai-agents`, `agent-orchestration`, `multi-agent`, `developer-tools`, `database-safety`, `supabase`, `mcp`, `context-engineering`, `llm-wiki`, `autoresearch`, and `agentic-coding`.

## Team Workflow

Team mode uses Codex subagents/custom agents as an orchestration protocol rather than a single long-running worker. `sks setup` enables `multi_agent`, sets agent concurrency limits, and installs local agent role files under `.codex/agents/`.

For code-changing work, generated SKS rules tell Codex to surface visible route, guard, write-scope, and verification status before editing. When the work has independent, non-overlapping write scopes, Codex should spawn worker subagents in parallel by default; the parent keeps urgent blockers local, assigns ownership, integrates results, and runs final verification.

Team missions default to `executor:3 reviewer:1 user:1 planner:1`. Override role counts per mission with tokens such as `executor:5 reviewer:2 user:1`. `executor:N` creates N read-only analysis scouts, N debate participants, and then a separate N-person executor development team. The parent orchestrator is not counted.

The pipeline is scout-first: parallel analysis, TriWiki refresh, planning debate, consensus, fresh parallel implementation, review, integration, and Honest Mode evidence.

Create a Team mission:

```bash
sks team "implement this feature safely" executor:5 reviewer:2 user:1
sks team "implement this feature safely" --agents 5
sks team watch latest
```

Inside Codex App, use:

```text
$Team executor:5 run parallel analysis scouts, refresh TriWiki, agree on the best plan, close the debate team, then implement with a fresh development team
```

Key Team artifacts:

```text
.sneakoscope/missions/<MISSION_ID>/team-plan.json
.sneakoscope/missions/<MISSION_ID>/team-workflow.md
.sneakoscope/missions/<MISSION_ID>/team-analysis.md
.sneakoscope/missions/<MISSION_ID>/team-live.md
.sneakoscope/missions/<MISSION_ID>/team-transcript.jsonl
.sneakoscope/missions/<MISSION_ID>/team-dashboard.json
.sneakoscope/wiki/context-pack.json
.codex/agents/analysis-scout.toml
.codex/agents/team-consensus.toml
.codex/agents/implementation-worker.toml
```

Live team visibility commands:

```bash
sks team status <MISSION_ID|latest>
sks team log <MISSION_ID|latest>
sks team tail <MISSION_ID|latest>
sks team watch <MISSION_ID|latest>
sks team watch <MISSION_ID|latest> --follow
sks team event <MISSION_ID|latest> --agent analysis_scout_1 --phase parallel_analysis_scouting --message "mapped repo slice"
```

## Ralph Workflow

```text
ralph prepare
  -> create mission
  -> generate questions.md and required-answers.schema.json

ralph answer
  -> validate answers.json
  -> seal decision-contract.json

ralph run
  -> activate no-question lock
  -> scan database safety state
  -> run supervised Codex cycles
  -> evaluate done-gate.json
```

Core invariants:

1. Ralph can ask questions only during `prepare`.
2. `run` is locked until every required answer is supplied.
3. New ambiguity during `run` is resolved by the sealed decision ladder.
4. Hooks help enforce the policy, but the Sneakoscope Codex supervisor and mission files remain the source of truth.
5. Database destructive operations are never allowed.
6. Rendered GX files are reproducible context artifacts; `vgraph.json` is authoritative.
7. Unsupported critical claims block completion.

## Commands

There are two command surfaces:

- **Terminal CLI commands**: run in a shell as `sks ...` or `sneakoscope ...`.
- **Prompt `$` commands**: type inside Codex App or another coding agent prompt, not in a shell.

All terminal examples below use `sks`, but the same commands can be run with the `sneakoscope` alias.

### Terminal CLI

```bash
sks help [topic]
sks wizard
sks commands [--json]
sks usage [topic]
sks quickstart
sks codex-app
sks dollar-commands [--json]
sks df

sks --help
sneakoscope --help

sks setup [--install-scope global|project] [--local-only] [--force] [--json]
sks doctor [--fix] [--local-only] [--json] [--install-scope global|project]
sks selftest [--mock]
sks versioning status|bump|hook

sks ralph prepare "task"
sks ralph answer <mission-id|latest> <answers.json>
sks ralph run <mission-id|latest> [--mock] [--max-cycles N]

sks research prepare "topic" [--depth frontier]
sks research run <mission-id|latest> [--mock] [--max-cycles N]

sks db scan [--migrations] [--json]
sks db check --sql "SELECT * FROM users LIMIT 10"
sks db check --command "supabase db reset"

sks team "task" [executor:5 reviewer:2 user:1] [--json]
sks team log|tail|watch|status [mission-id|latest]
sks wiki pack [--json] [--role worker|verifier] [--max-anchors N]
sks wiki validate [context-pack.json]
sks context7 check|setup|tools|docs ...
sks pipeline status|resume [--json]
sks guard check [--json]
sks conflicts check|prompt [--json]
sks eval run|compare|thresholds ...
sks hproof check [mission-id|latest]
sks gx init|render|validate|drift|snapshot [name]
sks gc [--dry-run] [--json]
```

`sks memory` is currently an alias for garbage collection/retention handling.

### Prompt $ Commands

Use these by typing them at the start of a prompt in Codex App or another coding agent:

```text
$DF <small design/content request>
$SKS <general Sneakoscope request>
$Team <multi-agent team request>
$Ralph <clarification-gated mission request>
$Research <research/discovery request>
$AutoResearch <iterative experiment request>
$DB <database or Supabase safety request>
$GX <visual context request>
$Help <command/help request>
```

Examples:

```text
$DF 글자 색 파란색으로 바꿔줘
$DF 내용을 영어로 바꿔줘
$DF Change the CTA label to "Start"
$Team agree on the goal, close planning agents, then implement with a fresh team
$Ralph 결제 실패 재시도 로직 개선
$Research LLM 에이전트 평가 방법론 조사
$DB 이 migration 안전한지 검사해줘
$GX 현재 아키텍처를 시각 컨텍스트로 만들어줘
$Help 사용 가능한 명령어 알려줘
```

`$DF` is the fast path for simple design/content edits. It is intentionally scoped to the requested change and should not run Ralph, Research, eval, or broad redesign loops unless you explicitly ask.

To inspect these routes from the terminal:

```bash
sks dollar-commands
sks df
sks usage dollar
```

## Skill-First Pipeline And Context7

Every `$` route is tracked as a pipeline route with skills, mission state, Context7 policy, and a Stop hook gate. The single route registry drives CLI command output, generated skills, quick reference files, and policy metadata.

Context tracking uses TriWiki as the SSOT. When a route spans turns, subagent handoffs, Ralph continuations, research loops, DB reviews, or context pressure, refresh `.sneakoscope/wiki/context-pack.json` with `sks wiki pack` and validate it with `sks wiki validate .sneakoscope/wiki/context-pack.json` instead of relying on ad hoc summaries.

## Harness Self-Protection

Installed projects treat the SKS harness as immutable to LLM tool edits. The `PreToolUse` and `PermissionRequest` hooks block direct writes to generated control files, generated skills/agents, policy files, `AGENTS.md`, and the installed `node_modules/sneakoscope` package. They also block LLM-issued maintenance commands such as `sks setup`, `sks init`, `sks doctor --fix`, `sks context7 setup`, and package-manager removal of `sneakoscope`.

`sks doctor --fix` repairs broken SKS-generated hooks, config, app skills, local agents, manifest, policy, DB guard, and harness guard. It also restores picker fallback aliases such as `$agent-team` when `$team` can be hidden by the app. Runtime mission/wiki state and application source are preserved.

The guard writes fingerprints to `.sneakoscope/harness-guard.json`, and `sks doctor` includes the guard in readiness. Check it directly with:

```bash
sks guard check
sks guard check --json
```

The only automatic exception is this engine source repository: `package.json` name `sneakoscope`, `bin/sks.mjs`, and `src/core/init.mjs`/`hooks-runtime.mjs` must all exist. Normal application projects do not get that exception.

## Other Harness Conflict Gate

SKS refuses to install or repair itself when another Codex harness is detected. OMX is a hard blocker. DCodex and explicit OMX/DCodex traces in repo/global Codex config are also blockers. Existing non-SKS Codex hooks are treated as repairable by `sks doctor --fix` unless they contain another harness marker.

Discover conflicts:

```bash
sks conflicts check
sks conflicts check --json
sks conflicts prompt
```

If conflicts exist, SKS prints a cleanup prompt for Codex App. Use GPT-5.5 with reasoning effort high. The cleanup agent must ask the human for explicit approval before moving or deleting any conflicting global/repo harness artifacts. If approval is denied, SKS setup is not allowed in that environment.

Context7 MCP is configured project-locally by default, and global npm install also best-effort registers it with Codex when Codex CLI is present:

```toml
[mcp_servers.context7]
command = "npx"
args = ["-y", "@upstash/context7-mcp@latest"]
```

Use these checks:

```bash
sks context7 check
sks context7 tools
sks context7 resolve "OpenAI Codex" --query "hooks customization"
sks context7 docs /websites/developers_openai_codex --query "hooks customization"
sks context7 evidence latest /websites/developers_openai_codex --query "hooks customization"
sks context7 setup --scope project
sks pipeline status
sks guard check
sks reasoning "simple copy edit"
sks reasoning "research this idea"
```

Routes that rely on external package/API/framework knowledge must record Context7 `resolve-library-id` and docs-query evidence before completion. Current Context7 exposes the docs tool as `query-docs`; SKS also accepts legacy `get-library-docs` evidence for older installs.

SEO/GEO, npm discoverability, GitHub stars, README ranking, and AI-search visibility work routes to `$AutoResearch` and loads the `seo-geo-optimizer` skill together with Context7 evidence and an experiment ledger.

The base stance is strong intent inference. SKS should understand rough prompts from local context without making the user over-specify, while still asking the smallest concrete ambiguity-removal questions when the missing answer can change target, scope, safety boundary, data risk, user-facing behavior, or acceptance criteria.

Reasoning is route-local and temporary:

```text
medium  simple fulfillment, command discovery, copy/color/mechanical edits
high    logical work, safety checks, DB, orchestration, refactors, implementation
xhigh   research, AutoResearch, hypotheses, falsification, benchmarks, SEO/GEO experiments
```

Generated Codex profiles include `sks-task-medium`, `sks-logic-high`, and `sks-research-xhigh`; SKS tells the agent to return to the default/user-selected profile after the route gate passes.

## Research Mode

Research mode is for exploratory work where the desired output is a possible new insight, mechanism, prediction, or experiment, not a summary. It uses a frontier-discovery loop:

```text
R0 frame discovery criteria
R1 map assumptions and baselines
R2 generate competing hypotheses
R3 falsify with counterexamples and missing evidence
R4 synthesize surviving mechanisms
R5 propose tests, predictions, or probes
R6 write novelty ledger and research gate
```

Artifacts are written under `.sneakoscope/missions/<MISSION_ID>/`:

```text
research-plan.md
research-plan.json
research-report.md
novelty-ledger.json
research-gate.json
```

`sks research run` uses the `sks-research` Codex profile with maximum configured reasoning effort. `--mock` exercises the local artifact flow without calling a model.

## Database Safety

Sneakoscope Codex treats database access as high risk across Supabase MCP, Supabase CLI, Postgres, Prisma, Drizzle, Knex, Sequelize, `psql`, SQL files, and MCP-shaped payloads.

Always blocked:

```text
DROP DATABASE / SCHEMA / TABLE / VIEW / FUNCTION / TRIGGER / TYPE / EXTENSION
TRUNCATE
mass DELETE / UPDATE
ALTER TABLE ... DROP / RENAME
CREATE OR REPLACE
DROP ... CASCADE
GRANT / REVOKE
DISABLE RLS
supabase db reset / push
supabase migration repair / squash
project or branch delete/reset/merge commands
production writes
direct live writes through execute_sql
```

Allowed by default:

```text
SELECT, WITH ... SELECT, SHOW, EXPLAIN, DESCRIBE
read-only, project-scoped Supabase MCP
local or preview migration-file proposals when the sealed contract allows them
```

Recommended Supabase MCP URL shape:

```text
https://mcp.supabase.com/mcp?project_ref=<project_ref>&read_only=true&features=database,docs
```

Useful checks:

```bash
sks db policy
sks db scan --migrations
sks db mcp-config --project-ref <supabase_project_ref>
sks db check --sql "DROP TABLE users"
sks db check --command "supabase db reset"
```

Hooks are strongest for Codex tool execution paths, but Sneakoscope Codex does not rely on hooks alone. Ralph startup also scans DB/MCP configuration, and the supervised prompt embeds the DB policy.

## Performance Evaluation

`sks eval run` benchmarks the current SKS flow with a deterministic context-selection scenario. It compares an uncompressed all-claims baseline against the TriWiki compressed capsule and reports:

```text
estimated_tokens
token_savings_pct
accuracy_proxy
required_recall
relevance_precision
support_ratio
unsupported_critical_selected
context_build_ms_per_run
meaningful_improvement
```

`accuracy_proxy` is an evidence-weighted context quality metric, not a live model task score. Use `sks eval compare --baseline old.json --candidate new.json` to compare saved JSON reports across versions or experiments.

## H-Proof Done Gate

Ralph completion is evaluated through `.sneakoscope/missions/<MISSION_ID>/done-gate.json`.

A mission cannot pass when:

- `decision-contract.json` is missing
- unsupported critical claims are present
- a database safety violation or destructive DB attempt is recorded
- DB safety logs exist but have not been reviewed
- required tests lack evidence
- required performance evaluation evidence is missing
- required design verification evidence is missing
- visual or wiki drift is marked `high`

Run the evaluator directly with:

```bash
sks hproof check latest
```

## Runtime State

`sks init` creates the local control surface:

```text
.sneakoscope/              mission state, policy, retention, logs, wiki packs, GX cartridges
.codex/config.toml    Codex profiles, multi-agent limits, and Context7 MCP
.codex/hooks.json     hook entrypoints
.agents/skills/       official repo-local Codex App skills
.codex/agents/        Codex App custom agents for Team mode
.codex/SNEAKOSCOPE.md Codex App quick reference
AGENTS.md             managed repository rules block
```

Install scope controls `.codex/hooks.json`:

```text
global  -> /absolute/path/to/sks hook ... when resolvable, otherwise sks hook ...
project -> node ./node_modules/sneakoscope/bin/sks.mjs hook ...
```

If no scope is provided, SKS uses `global`.

Storage is intentionally bounded:

- process stdout/stderr are kept as bounded tails
- large outputs are written to files
- recursive scans have file/depth caps
- `sks gc` compacts oversized JSONL logs and prunes old artifacts
- `sks stats` reports package and `.sneakoscope` storage size

See the [resource policy](https://github.com/mandarange/Sneakoscope-Codex/blob/main/docs/PERFORMANCE.md) for the detailed storage and leak policy.

## Visual Cartridges

```bash
sks gx init architecture-atlas
```

This creates:

```text
.sneakoscope/gx/cartridges/<name>/vgraph.json
.sneakoscope/gx/cartridges/<name>/beta.json
.sneakoscope/gx/cartridges/<name>/render.svg
.sneakoscope/gx/cartridges/<name>/render.html
.sneakoscope/gx/cartridges/<name>/validation.json
.sneakoscope/gx/cartridges/<name>/drift.json
```

The intended flow is source first and deterministic:

```text
vgraph.json
  + beta.json
  -> sks gx render
  -> render.svg / render.html
  -> sks gx validate
  -> sks gx drift
  -> sks gx snapshot
```

`render.svg` embeds the normalized `vgraph.json` hash. `sks gx drift` fails when the render is missing, stale, or structurally invalid.

## TriWiki Context Tracking

TriWiki is the harness-level context-tracking SSOT and context selection strategy, not a model-internal modification. It scores claims and memory entries by geometric distance, authority, freshness, risk, and token cost, then builds context capsules for the current mission.

The default model is anchor-first rather than lossy-summary-first. Selected claims are included as text, while non-selected claims are preserved as LLM Wiki anchors with id, source path, hash, RGBA key, and a compact coordinate tuple. Later turns can hydrate the missing context from the project wiki instead of depending on a one-way summary.

Use TriWiki for long-running routes, Team handoffs, Ralph continuations, research loops, DB reviews, and any task likely to hit context pressure.

RGBA wiki coordinates use four channels:

```text
R -> domain angle
G -> layer radius through sin()
B -> phase angle
A -> concentration/confidence
```

The derived coordinate is `[domain, layer, phase, concentration]`, with an internal `xyzw` vector computed through sine/cosine. GX renders expose the same anchors through SVG data attributes and an RGBA coordinate strip, so visual context and text claims share one retrieval space.

Useful commands:

```bash
sks wiki coords --rgba 12,34,56,255
sks wiki pack
sks wiki validate .sneakoscope/wiki/context-pack.json
```

Default context layers:

```text
Q4 control bits
Q3 tags
Q2 fact cards when useful
Q1 evidence snippets for verification
Q0 raw logs only when necessary
```

## Package Layout

```text
bin/sks.mjs              CLI executable
src/cli/main.mjs            command router and Ralph loop
src/core/db-safety.mjs      SQL, CLI, and MCP payload classifier
src/core/evaluation.mjs     token, accuracy-proxy, and context-quality evaluator
src/core/gx-renderer.mjs    deterministic SVG/HTML visual context renderer
src/core/harness-conflicts.mjs
                           other Codex harness detector and cleanup prompt
src/core/harness-guard.mjs  immutable installed-harness guard and fingerprint checks
src/core/hproof.mjs         done-gate evaluator
src/core/init.mjs           project bootstrap and hook/skill installation
src/core/research.mjs       research-mode plan, novelty ledger, and gate helpers
src/core/retention.mjs      storage report and garbage collection policy
src/core/triwiki-attention.mjs
crates/sks-core/         optional Rust helper source, not shipped in npm package
```

The published npm package is allowlisted to `bin`, `src`, `README.md`, and `LICENSE`; `.sneakoscope`, `.codex`, `.agents`, `docs`, Rust sources, archives, and local state are excluded.

## Development

```bash
npm run repo-audit
npm run packcheck
npm run selftest
npm run sizecheck
npm run release:check
npm run doctor
```

`npm run repo-audit` checks tracked files for risky local paths and high-confidence secret material such as private keys, npm/GitHub/OpenAI-style tokens, local MCP configs, DB dumps, and credential files. It is included in `release:check` and `prepublishOnly`. The package intentionally does not define `prepack`; GitHub installs should not trigger npm's heavier git-dependency preparation path for normal users.

`npm run sizecheck` blocks accidental package bloat during `release:check`, `publish:dry`, and `npm publish`. Defaults: packed tarball `<=136 KiB`, unpacked package `<=500 KiB`, package files `<=40`, and each tracked file `<=256 KiB`. Override only for an intentional release with `SKS_MAX_PACK_BYTES`, `SKS_MAX_UNPACKED_BYTES`, `SKS_MAX_PACK_FILES`, or `SKS_MAX_TRACKED_FILE_BYTES`.

`npm run selftest` uses the mock path and does not call a model. Live Ralph runs require a working Codex CLI installation and authentication.

## Publishing

The npm package is published as public package `sneakoscope`. You must be logged in as an npm owner for that package before publishing.

```bash
npm whoami
npm owner ls sneakoscope
npm run publish:dry
npm run publish:npm
```

If `npm whoami` returns `E401 Unauthorized`, run `npm login` with an owner account or ask an existing owner to add your npm username:

```bash
npm owner add <your-npm-username> sneakoscope
```
