# Orchestration Layers

SKS has one general public execution workflow and keeps route-specific policy,
terminal observability, and completion proof separate.

## Public Entry Points

- `$sks-naruto` / `sks naruto run`: canonical Codex official subagent workflow.
- `$sks-work`: executes the newest explicit SKS plan through the same workflow.
- Research, AutoResearch, QA-Loop, MAD-SKS, PPT, and visual routes keep their
  own route contracts while using official child threads where required.

Unrecognized command and dollar-route spellings remain unrecognized. The
router does not warn-and-forward them into another execution path.

## Official Execution

- `src/core/subagents/**`: task profiles, model selection, thread budgets,
  delegation prompts, event correlation, and parent-summary evidence.
- `src/core/hooks-runtime.ts`: official lifecycle capture and stop evaluation.
- `src/core/commands/naruto-command.ts`: command parsing, project-scoped agent
  configuration, mission artifacts, status, and proof.

The parent owns decomposition, integration, verification, and the final answer.
Codex owns the official child threads. Codex App sessions reuse the current
parent instead of launching a nested orchestrator.

## Completion Evidence

Process count and display state never satisfy the completion contract. Official
model, budget, prompt, and evidence semantics belong in `src/core/subagents/**`.

<!-- sks-release-version: 8.4.0 Architecture Map (AMG/ADR) -->
