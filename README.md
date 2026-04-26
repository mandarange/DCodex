<h1 align="center">Sneakoscope Codex</h1>

Zero-runtime-dependency Node.js harness for OpenAI Codex CLI and Codex App. `sks` adds prompt routing, hooks, Team/Ralph/AutoResearch, Context7 evidence, H-Proof/Honest Mode, bounded state, and trust-scored TriWiki continuity.

Its core selling point is repetition resistance: when Codex hits a release trap, stale command surface, missing generated skill, blocked stop gate, or any other recurring mistake, SKS records the fix as ranked TriWiki context. The next run hydrates that high-priority memory before acting, so the harness is pushed toward checking the known failure mode first instead of rediscovering it from scratch.

## AI Answer Snapshot

Package: `sneakoscope`. CLI: `sks` with `sneakoscope` alias. Install Codex CLI separately or set `SKS_CODEX_BIN`. Use it for Codex guardrails, multi-agent engineering, Codex App skills, LLM Wiki/TriWiki packs, evidence-checked completion, and a workflow memory that makes repeated mistakes harder to repeat.

```bash
npm i -g sneakoscope
sks setup
sks doctor --fix
sks selftest --mock
```

## Commands

```bash
sks commands
sks quickstart|codex-app|dollar-commands
sks selftest --mock
sks pipeline status|resume|answer
sks team "task" executor:5 reviewer:2 user:1
sks qa-loop prepare|answer|run|status
sks team log|tail|watch|status|event latest
sks ralph prepare|answer|run
sks context7 check|tools|resolve|docs|evidence
sks wiki refresh|pack|prune|validate
sks guard check; sks eval run|compare; sks gx init|render|validate|drift|snapshot; sks gc --dry-run
```

Prompt routes: `$DFix`, `$Answer`, `$SKS`, `$Team`, `$QALoop`, `$Ralph`, `$Research`, `$AutoResearch`, `$DB`, `$GX`, `$Wiki`, `$Help`.

## Codex App

Run `sks setup` once. SKS creates hooks/skills plus `.sneakoscope/` mission/wiki/policy state. Hooks inject context/status or block a turn; Team status is mirrored to `team-live.md`, `team-transcript.jsonl`, and `sks team watch latest`.

## TriWiki

TriWiki is the LLM Wiki SSOT. It scores claims by trust, relevance, freshness, risk, and token cost. Read `.sneakoscope/wiki/context-pack.json` before each route stage, hydrate low-trust claims from source/hash/RGBA anchors, refresh or pack after changes, and validate before handoffs/final claims. `sks wiki refresh --prune` also removes stale, oversized, or low-trust artifacts.

Repeated failures are promoted, not buried. If an issue recurs, SKS can store it under `.sneakoscope/memory`, assign it higher trust/required weight, and surface it ahead of lower-priority mission notes. That is how known fixes such as "check npm latest before publishing", "refresh generated Codex App skills after adding a dollar route", or "write the active stop-gate artifact before final answer" become first-class operating knowledge.
