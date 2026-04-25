<p align="center">
  <img src="docs/assets/sneakoscope-codex-logo.svg" alt="Sneakoscope Codex logo" width="180">
</p>

<h1 align="center">Sneakoscope Codex</h1>

Sneakoscope Codex is a zero-runtime-dependency Node.js harness for running Codex CLI in a more controlled project workflow. It adds mandatory clarification before autonomous work, a Ralph no-question execution loop, H-Proof completion gates, conservative database safety checks, bounded logs/storage, and deterministic GX visual context cartridges.

```bash
npm i -g sneakoscope
```

The npm package name is `sneakoscope`; the command is branded as SKS and exposed as lowercase `sks` for shell portability. The package also exposes a `sneakoscope` command alias, so `sks setup` and `sneakoscope setup` are equivalent.
Global installation is the default and recommended setup. During `sks setup` or `sks init`, SKS resolves the global binary when possible and writes that absolute path into `.codex/hooks.json`, which avoids PATH issues in GUI or hook execution environments. For a project-only install, use `npm i -D sneakoscope` and initialize hooks with `npx sks setup --install-scope project`; this writes hook commands that call the local `node_modules/sneakoscope` binary.

`@openai/codex` is intentionally not bundled. Install Codex separately, or set `SKS_CODEX_BIN` to the Codex executable you want Sneakoscope Codex to supervise.

## One-Prompt LLM Install

If you are using Codex App, ChatGPT, Claude Code, Cursor, or another coding agent, copy this prompt into the agent from your target project directory:

````text
You are installing Sneakoscope Codex in the current project. Do the setup end to end without asking follow-up questions unless a command needs user approval.

Repository:
https://github.com/mandarange/Sneakoscope-Codex.git

Requirements:
- Node.js must be >=20.11.
- Codex CLI is installed separately; if missing, report that @openai/codex must be installed or SKS_CODEX_BIN must be set.
- Prefer safe, local verification. Do not modify application source files unless needed for SKS setup.

Run:
```bash
npm i -g git+https://github.com/mandarange/Sneakoscope-Codex.git
sks setup
sks doctor --fix
sks selftest --mock
sks commands
```

If the global command is not on PATH, use:
```bash
npx -y -p git+https://github.com/mandarange/Sneakoscope-Codex.git sks setup
npx -y -p git+https://github.com/mandarange/Sneakoscope-Codex.git sks doctor --fix
```

After setup, explain these outputs to the user:
- `.sneakoscope/` mission state and policy
- `.codex/config.toml` Codex App profiles
- `.codex/hooks.json` SKS hook integration
- `.codex/skills/` local Codex App skills
- `.codex/SNEAKOSCOPE.md` Codex App quick reference
- `AGENTS.md` repository rules

Show the user how to discover commands:
```bash
sks help
sks commands
sks usage ralph
sks quickstart
sks codex-app
sks dollar-commands
```

Tell the user they can use these prompt commands inside Codex App:
```text
$DF 글자 색 바꿔줘
$DF 내용을 영어로 바꿔줘
$SKS show me available workflows
$Ralph implement this with mandatory clarification
$Research investigate this idea
$DB check this migration safely
```
````

After SKS is installed, you can print this prompt again from the CLI:

```bash
sks install-prompt
sks install-prompt --project
```

## Repository

```bash
npm i -g git+https://github.com/mandarange/Sneakoscope-Codex.git
```

Source repository: <https://github.com/mandarange/Sneakoscope-Codex.git>

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
sks install-prompt
sks codex-app
sks dollar-commands
sks df
sks aliases
```

## Prompt Pipeline and $ Commands

SKS installs a Codex App `UserPromptSubmit` hook that adds a lightweight prompt-optimization context to every user request. You do not need to type a command for basic routing: SKS will infer the lightest path before work starts.

Use `$` prompt commands inside Codex App or another coding agent when you want to force a route:

```text
$DF        fast design/content fix
$SKS       general Sneakoscope workflow/help
$Ralph     clarification-gated Ralph mission
$Research  frontier research mission
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

## Codex App

Sneakoscope Codex can also be used from Codex App when the repository is opened in the app. Run setup once in the project:

```bash
sks setup
```

This creates the app-facing control surface:

```text
.codex/config.toml       Codex App profiles for SKS Ralph, research, and default work
.codex/hooks.json        Codex App hook entrypoints routed through SKS guards
.codex/skills/           local project skills for Ralph, DB safety, GX, research, and design work
.codex/SNEAKOSCOPE.md    quick reference for using SKS inside Codex App
AGENTS.md                repository rules loaded by Codex agents
.sneakoscope/            mission state, gates, logs, policy, GX cartridges, and reports
```

Inside Codex App, you can ask the agent to use the local SKS control surface, for example:

```text
$DF 글자 색 바꿔줘
$DF 내용을 영어로 바꿔줘
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

- **Mandatory clarification**: `ralph prepare` generates required decision slots before autonomous execution can start.
- **Sealed decision contract**: `ralph answer` validates answers and writes `decision-contract.json`.
- **No-question Ralph loop**: after `ralph run` starts, Ralph must resolve ambiguity with the sealed contract instead of asking the user.
- **Research mode**: `research` runs a frontier-discovery loop for non-obvious hypotheses, falsification, novelty ledgers, and testable experiments.
- **Prompt pipeline and `$` routes**: user prompts are lightly optimized by default, and Codex App users can force routes such as `$DF`, `$Ralph`, `$Research`, `$DB`, and `$GX`.
- **Fast DF mode**: `$DF` handles small design/content edits like color, copy, labels, spacing, and translation without unnecessary Ralph, Research, or evaluation loops.
- **Database guard**: destructive DB operations, production writes, unsafe Supabase MCP configuration, and direct live SQL mutations are blocked or warned on.
- **H-Proof done gate**: completion requires supported critical claims, reviewed DB safety state, acceptable visual/wiki drift, and required test evidence.
- **Performance evaluation**: `sks eval` produces deterministic token, accuracy-proxy, recall, support, and runtime metrics for before/after evidence.
- **Bounded runtime state**: child process output is tailed, logs are rotated/compacted, and old mission artifacts can be pruned.
- **Visual cartridges**: `gx` creates deterministic SVG/HTML visual context from `vgraph.json` and `beta.json`; no generated-image service is required.
- **Design artifact skill**: `sks init` installs a local skill for high-fidelity HTML/UI/prototype work with design-context gathering and rendered verification.

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

All examples below use `sks`, but the same commands can be run with the `sneakoscope` alias.

```bash
sks help [topic]
sks commands [--json]
sks usage [install|setup|ralph|research|db|codex-app|df|dollar|eval|gx]
sks quickstart
sks install-prompt [--project]
sks codex-app
sks dollar-commands [--json]
sks df
sks aliases

sks --help
sneakoscope --help

sks setup [--install-scope global|project] [--force] [--json]
sks fix-path [--install-scope global|project] [--json]
sks doctor [--fix] [--json] [--install-scope global|project]
sks init [--force] [--install-scope global|project]
sks selftest [--mock]

sks ralph prepare "task"
sks ralph answer <mission-id|latest> <answers.json>
sks ralph run <mission-id|latest> [--mock] [--max-cycles N]
sks ralph status <mission-id|latest>

sks research prepare "topic" [--depth frontier]
sks research run <mission-id|latest> [--mock] [--max-cycles N]
sks research status <mission-id|latest>

sks db policy
sks db scan [--migrations] [--json]
sks db mcp-config --project-ref <ref> [--features database,docs]
sks db classify --sql "DROP TABLE users"
sks db classify --command "supabase db reset"
sks db check --sql "SELECT * FROM users LIMIT 10"
sks db check --command "supabase db reset"
sks db check --file ./migration.sql

sks eval run [--json] [--out report.json] [--iterations N]
sks eval compare --baseline old.json --candidate new.json [--json]
sks eval thresholds

sks hproof check [mission-id|latest]
sks team "task"
sks gx init [name]
sks gx render [name] [--format svg|html|all]
sks gx validate [name]
sks gx drift [name]
sks gx snapshot [name]
sks profile show
sks profile set <model>
sks gc [--dry-run] [--json]
sks memory [--dry-run] [--json]
sks stats [--json]
```

`sks memory` is currently an alias for garbage collection/retention handling.

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
.sneakoscope/              mission state, policy, retention, logs, GX cartridges
.codex/config.toml    Codex profiles used by Sneakoscope Codex
.codex/hooks.json     hook entrypoints
.codex/skills/        Codex App local project skills
.codex/SNEAKOSCOPE.md Codex App quick reference
.agents/skills/       Sneakoscope Codex helper skills
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

See [docs/PERFORMANCE.md](docs/PERFORMANCE.md) for the detailed resource policy.

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

## TriWiki Context Compression

TriWiki is a harness-level context selection strategy, not a model-internal modification. It scores claims and memory entries by geometric distance, authority, freshness, risk, and token cost, then builds small context capsules for the current mission.

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
src/core/hproof.mjs         done-gate evaluator
src/core/init.mjs           project bootstrap and hook/skill installation
src/core/research.mjs       research-mode plan, novelty ledger, and gate helpers
src/core/retention.mjs      storage report and garbage collection policy
src/core/triwiki-attention.mjs
docs/PERFORMANCE.md         resource and leak policy
crates/sks-core/         optional Rust helper source, not shipped in npm package
```

The published npm package is allowlisted to `bin`, `src`, `docs`, `README.md`, and `LICENSE`; `.sneakoscope`, `.codex`, `.agents`, Rust sources, archives, and local state are excluded.

## Development

```bash
npm run packcheck
npm run selftest
npm run sizecheck
npm run doctor
```

`npm run sizecheck` blocks accidental package bloat before `npm pack` or `npm publish`. Defaults: packed tarball `<=96 KiB`, unpacked package `<=320 KiB`, package files `<=40`, and each tracked file `<=256 KiB`. Override only for an intentional release with `SKS_MAX_PACK_BYTES`, `SKS_MAX_UNPACKED_BYTES`, `SKS_MAX_PACK_FILES`, or `SKS_MAX_TRACKED_FILE_BYTES`.

`npm run selftest` uses the mock path and does not call a model. Live Ralph runs require a working Codex CLI installation and authentication.
