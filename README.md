# DCODEX

DCODEX is a zero-runtime-dependency Node.js harness for running Codex CLI in a more controlled project workflow. It adds mandatory clarification before autonomous work, a Ralph no-question execution loop, H-Proof completion gates, conservative database safety checks, bounded logs/storage, and optional GPT Image 2 visual cartridges.

```bash
npm i -g dcodex-cli
```

The npm package name is `dcodex-cli`; the installed command is `dcodex`.

`@openai/codex` is intentionally not bundled. Install Codex separately, or set `DCODEX_CODEX_BIN` to the Codex executable you want DCODEX to supervise.

## Requirements

- Node.js `>=20.11`
- Codex CLI authentication for live Ralph runs
- No runtime npm dependencies in the DCODEX package
- Optional Rust helper: compile `crates/dcodex-core` yourself and expose `dcodex-rs` on `PATH`, or set `DCODEX_RS_BIN`

## Quick Start

```bash
dcodex doctor --fix
dcodex init
dcodex selftest --mock
```

Create a Ralph mission:

```bash
dcodex ralph prepare "결제 실패 재시도 로직 개선"
```

Answer every generated slot, seal the decision contract, then run:

```bash
cat .dcodex/missions/<MISSION_ID>/questions.md
cp .dcodex/missions/<MISSION_ID>/required-answers.schema.json answers.json
# edit answers.json
dcodex ralph answer <MISSION_ID> answers.json
dcodex ralph run <MISSION_ID> --max-cycles 8
```

For a local smoke test that does not call a model:

```bash
dcodex ralph run latest --mock
```

## What DCODEX Adds

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
4. Hooks help enforce the policy, but the DCODEX supervisor and mission files remain the source of truth.
5. Database destructive operations are never allowed.
6. Generated images are not authoritative; `vgraph.json` is.
7. Unsupported critical claims block completion.

## Commands

```bash
dcodex doctor [--fix] [--json]
dcodex init [--force]
dcodex selftest [--mock]

dcodex ralph prepare "task"
dcodex ralph answer <mission-id|latest> <answers.json>
dcodex ralph run <mission-id|latest> [--mock] [--max-cycles N]
dcodex ralph status <mission-id|latest>

dcodex db policy
dcodex db scan [--migrations] [--json]
dcodex db mcp-config --project-ref <ref> [--features database,docs]
dcodex db classify --sql "DROP TABLE users"
dcodex db classify --command "supabase db reset"
dcodex db check --sql "SELECT * FROM users LIMIT 10"
dcodex db check --command "supabase db reset"
dcodex db check --file ./migration.sql

dcodex hproof check [mission-id|latest]
dcodex gx init [name]
dcodex gx render|validate|drift
dcodex profile show
dcodex profile set <model>
dcodex gc [--dry-run] [--json]
dcodex stats [--json]
```

`dcodex memory` is currently an alias for garbage collection/retention handling.

## Database Safety

DCODEX treats database access as high risk across Supabase MCP, Supabase CLI, Postgres, Prisma, Drizzle, Knex, Sequelize, `psql`, SQL files, and MCP-shaped payloads.

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
dcodex db policy
dcodex db scan --migrations
dcodex db mcp-config --project-ref <supabase_project_ref>
dcodex db check --sql "DROP TABLE users"
dcodex db check --command "supabase db reset"
```

Hooks are strongest for Codex tool execution paths, but DCODEX does not rely on hooks alone. Ralph startup also scans DB/MCP configuration, and the supervised prompt embeds the DB policy.

## H-Proof Done Gate

Ralph completion is evaluated through `.dcodex/missions/<MISSION_ID>/done-gate.json`.

A mission cannot pass when:

- `decision-contract.json` is missing
- unsupported critical claims are present
- a database safety violation or destructive DB attempt is recorded
- DB safety logs exist but have not been reviewed
- required tests lack evidence
- visual or wiki drift is marked `high`

Run the evaluator directly with:

```bash
dcodex hproof check latest
```

## Runtime State

`dcodex init` creates the local control surface:

```text
.dcodex/              mission state, policy, retention, logs, GX cartridges
.codex/config.toml    Codex profiles used by DCODEX
.codex/hooks.json     hook entrypoints
.agents/skills/       DCODEX helper skills
AGENTS.md             managed repository rules block
```

Storage is intentionally bounded:

- process stdout/stderr are kept as bounded tails
- large outputs are written to files
- recursive scans have file/depth caps
- `dcodex gc` compacts oversized JSONL logs and prunes old artifacts
- `dcodex stats` reports package and `.dcodex` storage size

See [docs/PERFORMANCE.md](docs/PERFORMANCE.md) for the detailed resource policy.

## Visual Cartridges

```bash
dcodex gx init architecture-atlas
```

This creates:

```text
.dcodex/gx/cartridges/<name>/vgraph.json
.dcodex/gx/cartridges/<name>/beta.json
.dcodex/gx/cartridges/<name>/image-prompt.md
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
bin/dcodex.mjs              CLI executable
src/cli/main.mjs            command router and Ralph loop
src/core/db-safety.mjs      SQL, CLI, and MCP payload classifier
src/core/hproof.mjs         done-gate evaluator
src/core/init.mjs           project bootstrap and hook/skill installation
src/core/retention.mjs      storage report and garbage collection policy
src/core/triwiki-attention.mjs
docs/PERFORMANCE.md         resource and leak policy
crates/dcodex-core/         optional Rust helper source, not shipped in npm package
```

The published npm package is allowlisted to `bin`, `src`, `docs`, `README.md`, and `LICENSE`; `.dcodex`, `.codex`, `.agents`, Rust sources, archives, and local state are excluded.

## Development

```bash
npm run packcheck
npm run selftest
npm run doctor
```

`npm run selftest` uses the mock path and does not call a model. Live Ralph runs require a working Codex CLI installation and authentication.
