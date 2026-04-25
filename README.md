<p align="center">
  <img src="docs/assets/sneakoscope-codex-logo.svg" alt="Sneakoscope Codex logo" width="180">
</p>

<h1 align="center">Sneakoscope Codex</h1>

Sneakoscope Codex is a zero-runtime-dependency Node.js harness for running Codex CLI in a more controlled project workflow. It adds mandatory clarification before autonomous work, a Ralph no-question execution loop, H-Proof completion gates, conservative database safety checks, bounded logs/storage, and optional GPT Image 2 visual cartridges.

```bash
npm i -g sneakoscope
```

The npm package name is `sneakoscope`; the command is branded as SKS and exposed as lowercase `sks` for shell portability.

`@openai/codex` is intentionally not bundled. Install Codex separately, or set `SKS_CODEX_BIN` to the Codex executable you want Sneakoscope Codex to supervise.

## Requirements

- Node.js `>=20.11`
- Codex CLI authentication for live Ralph runs
- No runtime npm dependencies in the Sneakoscope Codex package
- Optional Rust helper: compile `crates/sks-core` yourself and expose `sks-rs` on `PATH`, or set `SKS_RS_BIN`

## Quick Start

```bash
sks doctor --fix
sks init
sks selftest --mock
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

## What Sneakoscope Codex Adds

- **Mandatory clarification**: `ralph prepare` generates required decision slots before autonomous execution can start.
- **Sealed decision contract**: `ralph answer` validates answers and writes `decision-contract.json`.
- **No-question Ralph loop**: after `ralph run` starts, Ralph must resolve ambiguity with the sealed contract instead of asking the user.
- **Database guard**: destructive DB operations, production writes, unsafe Supabase MCP configuration, and direct live SQL mutations are blocked or warned on.
- **H-Proof done gate**: completion requires supported critical claims, reviewed DB safety state, acceptable visual/wiki drift, and required test evidence.
- **Bounded runtime state**: child process output is tailed, logs are rotated/compacted, and old mission artifacts can be pruned.
- **Visual cartridges**: `gx` creates metadata-first visual cartridges where `vgraph.json` remains the source of truth and image generation is delegated to Codex/GPT Image 2.

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
6. Generated images are not authoritative; `vgraph.json` is.
7. Unsupported critical claims block completion.

## Commands

```bash
sks doctor [--fix] [--json]
sks init [--force]
sks selftest [--mock]

sks ralph prepare "task"
sks ralph answer <mission-id|latest> <answers.json>
sks ralph run <mission-id|latest> [--mock] [--max-cycles N]
sks ralph status <mission-id|latest>

sks db policy
sks db scan [--migrations] [--json]
sks db mcp-config --project-ref <ref> [--features database,docs]
sks db classify --sql "DROP TABLE users"
sks db classify --command "supabase db reset"
sks db check --sql "SELECT * FROM users LIMIT 10"
sks db check --command "supabase db reset"
sks db check --file ./migration.sql

sks hproof check [mission-id|latest]
sks gx init [name]
sks gx render|validate|drift
sks profile show
sks profile set <model>
sks gc [--dry-run] [--json]
sks stats [--json]
```

`sks memory` is currently an alias for garbage collection/retention handling.

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

## H-Proof Done Gate

Ralph completion is evaluated through `.sneakoscope/missions/<MISSION_ID>/done-gate.json`.

A mission cannot pass when:

- `decision-contract.json` is missing
- unsupported critical claims are present
- a database safety violation or destructive DB attempt is recorded
- DB safety logs exist but have not been reviewed
- required tests lack evidence
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
.agents/skills/       Sneakoscope Codex helper skills
AGENTS.md             managed repository rules block
```

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
.sneakoscope/gx/cartridges/<name>/image-prompt.md
```

The intended flow is metadata first:

```text
vgraph.json
  -> image-prompt.md
  -> Codex $imagegen / GPT Image 2
  -> sheet.png
  -> vision parse.json
  -> validate against vgraph.json
```

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
src/core/hproof.mjs         done-gate evaluator
src/core/init.mjs           project bootstrap and hook/skill installation
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
npm run doctor
```

`npm run selftest` uses the mock path and does not call a model. Live Ralph runs require a working Codex CLI installation and authentication.
