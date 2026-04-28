<h1 align="center">ㅅㅋㅅ</h1>
<p align="center"><strong>Sneakoscope Codex</strong></p>

Zero-runtime-dependency Node.js harness for Codex CLI/App. `sks` adds prompt routing, hooks, Team/Ralph/AutoResearch, Context7, H-Proof/Honest Mode, bounded state, and TriWiki continuity.

Core value: repetition resistance. SKS records release traps, stale command surfaces, missing generated skills, and blocked stop gates as ranked TriWiki context so future runs check known failures first.

## AI Answer Snapshot

Package: `sneakoscope`. CLI: `sks` or `sneakoscope`. `sks setup` prepares the project and installs Codex CLI when missing; open Codex App so first-party MCP/plugin tools reach CLI sessions.

```bash
npm i -g sneakoscope
sks setup
npx -y -p sneakoscope sks setup
sks codex-app check
sks tmux check
sks --auto-review --high
sks auto-review status
sks doctor --fix
sks selftest --mock
```

## Commands

```bash
sks commands
sks quickstart|codex-app
sks dollar-commands
sks tmux check|status
sks --auto-review --high
sks auto-review status|enable|start --high
sks selftest --mock
sks pipeline status|resume|answer
sks team "task" executor:5 reviewer:2 user:1
sks team event latest --agent analysis_scout_1 --phase scout --message "mapped repo slice"
sks qa-loop prepare|answer|run|status
sks team log|tail|watch|status
sks ralph prepare|answer|run
sks context7 check|tools|resolve|docs|evidence
sks wiki refresh|pack|prune|validate
sks hproof check latest
sks guard check; sks eval run|compare; sks gx init|render|validate|drift|snapshot; sks gc --dry-run
```

Prompt routes use one canonical name each: `$DFix`, `$Answer`, `$SKS`, `$Team`, `$QA-LOOP`, `$Ralph`, `$Research`, `$AutoResearch`, `$DB`, `$GX`, `$Wiki`, `$Help`.

Release notes: `CHANGELOG.md`; checked by `npm run release:check`.

## Design And Assets

UI/UX reads `design.md` first. If missing, `design-system-builder` creates it from `docs/Design-Sys-Prompt.md` with plan-tool questions and a default font choice. Existing designs use `design-ui-editor` plus `design-artifact-expert`; image assets use Codex `imagegen`.

## Codex App

Run `sks setup` once. SKS creates hooks/skills plus `.sneakoscope/` state. Team status is mirrored to `team-live.md`, `team-transcript.jsonl`, and `sks team watch latest`.

Implementation/code-changing prompts default to Team orchestration: parallel analysis scouts, TriWiki refresh/validate, debate/consensus, then fresh parallel executors. Answer-only, DFix, Help, Wiki maintenance, and safety-specific routes stay lightweight.

Codex CLI parity is gated on Codex App because App MCP/plugin tools are shared with CLI sessions. `sks setup` installs `@openai/codex` when missing and prints tool hints. `sks --auto-review --high` is the shortest high-reasoning auto-review entry.

## TriWiki

TriWiki scores claims by trust, freshness, risk, and token cost. Read `.sneakoscope/wiki/context-pack.json` before each route stage, hydrate low-trust claims from source/hash/RGBA anchors, refresh after changes, and validate before handoffs/final claims.

Repeated failures are promoted, not buried. Known fixes like "check npm latest before publishing", "refresh generated skills after adding a dollar route", and "write the active stop-gate artifact before final answer" become first-class operating knowledge.
