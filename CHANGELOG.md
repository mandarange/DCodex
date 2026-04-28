# Changelog

## [Unreleased]

## [0.6.51] - 2026-04-28

### Changed

- Expose `$From-Chat-IMG` directly in `sks dollar-commands`, manifests, policy, quick reference, and generated dollar-command output instead of only as a hidden Team picker alias.

## [0.6.50] - 2026-04-28

### Changed

- Add explicit `$From-Chat-IMG` / `From-Chat-IMG` Team alias for chat-history screenshot plus original attachment intake.
- Gate chat-image analysis behind the explicit From-Chat-IMG signal so ordinary image prompts are not treated as chat captures.
- Require From-Chat-IMG intake to list chat requirements first, use Computer Use/browser visual inspection to strengthen attachment matching, and produce a client modification work order before continuing the normal Team pipeline.
- Raise the package size gates to 168 KiB packed and 644 KiB unpacked for the added command alias, generated skill, and route-gating selftests.

## [0.6.49] - 2026-04-28

### Changed

- Raise the package size gates to 166 KiB packed and 642 KiB unpacked so the stack-current-docs and final-summary policy surfaces remain publishable.
- Require final answers to omit dirty-worktree boundary wording that the Honest Mode hook treats as an unresolved gap.

## [0.6.48] - 2026-04-28

### Changed

- Require every pipeline final answer to include a user-visible completion summary explaining what changed, what was verified, and what remains unverified or blocked.
- Block Honest Mode final stop when the completion summary is missing, with selftest coverage for the new stop-gate behavior.

## [0.6.47] - 2026-04-28

### Changed

- Route question-shaped implicit directives, policy complaints, and mandatory workflow statements to Team instead of Answer.
- Require Team roster confirmation before implementation by materializing `team-roster.json` and enforcing `team_roster_confirmed=true` in Team gates.
- Raise the packed size gate to 165 KiB and unpacked gate to 640 KiB for the added stack-current-docs and Team roster guidance.

## [0.6.46] - 2026-04-28

### Changed

- Require current Context7 or official-doc evidence whenever stack, framework, package, runtime, or deployment-platform versions change, then record the guidance as high-priority TriWiki claims before coding.
- Add current-doc TriWiki examples for hosted Supabase keys, Next.js 16 proxy files, and Vercel Function duration limits.
- Require the latest coordinate+voxel TriWiki pack shape in validation and pipeline guidance; coordinate-only legacy TriWiki packs now fail validation and must be regenerated before use.
- Keep the package size gate bounded while allowing the required TriWiki voxel validation metadata.

### Fixed

- Treat successful Honest Mode phrases like `No active blocking route gate detected` and verified expected blocking as resolved, so loopback does not reopen on closure evidence.

## [0.6.45] - 2026-04-28

### Added

- Add chat-history screenshot intake guidance so SKS extracts visible text, matches screenshot image regions to attachments, and carries the evidence through the normal Team pipeline.
- Raise the package size gate slightly for the added pipeline guidance while keeping the tarball bounded under 628 KiB unpacked.

### Fixed

- Block full-route completion when Team work continues after `reflection-gate.json` was passed, forcing reflection to be refreshed before final Honest Mode.

## [0.6.44] - 2026-04-28

### Changed

- Use a GitHub raw logo URL in README so npm can render the image.

## [0.6.43] - 2026-04-28

### Changed

- Make QA-LOOP dogfood real UI/API flows as a human proxy, immediately apply safe contract-allowed fixes, and require focused rechecks before passing the QA gate.

## [0.6.42] - 2026-04-28

### Changed

- Add full-route reflection with generated `reflection` skill, stop-gate enforcement, and TriWiki lesson recording.
- Add Team `team-session-cleanup.json` as a required pre-reflection gate.
- Require QA-LOOP reports to use `YYYY-MM-DD-v<version>-qa-report.md`.
- Treat verified expected-block evidence as resolved in Honest Mode gap detection.
- Add `sks bootstrap` plus `sks deps check/install` for first-install readiness, and make postinstall point to bootstrap instead of mutating projects by default.
- Reduce Ralph questions for setup work by inferring non-target DB/UI fallback slots from local context.
- Count user request topics in TriWiki packs and prioritize repeated or strongly frustrated feedback as high-weight context for future inference.
- Raise the npm unpacked size budget to 620 KiB so the richer setup, reflection, QA, and TriWiki priority pipeline remains releasable.

## [0.6.41] - 2026-04-28

### Fixed

- Preserve custom Codex App skills during `sks doctor --fix`.

## [0.6.40] - 2026-04-28

- Preserve user-owned non-generated skill aliases during upgrade/repair while removing obsolete SKS aliases.
- Add selftest coverage for custom skill preservation.

## [0.6.39] - 2026-04-28

- Restore fuller README guidance while keeping package size under the gate.

## [0.6.38] - 2026-04-28

- Seed SKS dollar-command skills into `$HOME/.agents/skills` during package install.
- Report project-local and global dollar-command readiness in `sks codex-app check` and `sks doctor`.
- Add the minimal `ㅅㅋㅅ` README mark.

## [0.6.37] - 2026-04-28

- Add Korean `ㅅㅋㅅ` branding, tmux/setup guidance, Team live event logging, Codex CLI readiness handling, design/image skills, and Team-default execution routing.
- Fix Korean execution-prompt routing, Team continuation after ambiguity gates, Context7 readiness checks, changelog release checks, and Honest Mode loop-back/no-gap handling.
