# Research Artifacts

Required research artifacts include:

- `research-quality-contract.json`: threshold contract for source count, source layers, counterevidence, claim support, blueprint depth, falsification, experiments, and report length.
- `claim-evidence-matrix.json`: key claims, source ids, counterevidence ids, triangulation, unsupported claims, confidence, and test probes.
- `source-quality-report.json`: metadata completeness and claim citation coverage for `source-ledger.json`.
- `research-synthesis-output.json`: evidence-bound synthesis output containing report markdown, paper markdown, cited source ids, covered key claims, repetition ratio, and template phrase hits.
- `implementation-blueprint.json` and `implementation-blueprint.md`: read-only handoff sections for later execution routes.
- `experiment-plan.json` and `experiment-plan.md`: validation steps, metrics, controls, and acceptance threshold.
- `replication-pack.json`: inputs, commands, expected artifacts, and reproduction notes.
- `research-final-review.static.json`: deterministic validator output.
- `research-final-review.codex.json`: Codex/GPT reviewer output, or a mock reviewer artifact in explicit fixture mode.
- `research-final-review.json`: merged final reviewer decision. `approved=true` is required before the research gate can pass.
- `research/cycle-N/source-shards/<layer>.json`: per-layer source shard partials.
- `research/cycle-N/stages/<stage-id>.json`: `ResearchStageResult` records for every executed stage.
- `research-gate.evaluated.json`: computed gate result with quality metrics and blockers.

The legacy core artifacts still matter: `research-report.md`, the dated research paper artifact, `research-source-skill.md`, `source-ledger.json`, `agent-ledger.json`, `debate-ledger.json`, `novelty-ledger.json`, `falsification-ledger.json`, and `research-gate.json`.

Short reports, one-source ledgers, empty claim matrices, incomplete blueprints, missing experiment/replication packs, repeated/template-like prose, low source density, low claim density, and unapproved final review artifacts are blackbox rejected even if the prose is fluent.
