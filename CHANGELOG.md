# Changelog

## [Unreleased]

## [0.6.70] - 2026-04-30

### Changed

- Make `sks --mad` reuse its named cmux workspace and close duplicate SKS-named MAD workspaces instead of creating another workspace on every launch.
- Add pipeline, Team inbox, generated agent, auto-review, and MAD/MAD-SKS policy text that blocks unrequested fallback implementation code.

## [0.6.69] - 2026-04-30

### Changed

- Add `sks team lane` per-agent monitoring for cmux Team panes, showing agent status, assigned runtime tasks, recent agent events, and a fallback global tail.
- Promote explicit `$From-Chat-IMG` work-order analysis to xhigh temporary reasoning and generated skill metadata.
- Allow runtime commands to work outside any project by falling back to a per-user global SKS root, with `sks root` showing the active project/global root.

## [0.6.66] - 2026-04-29

### Changed

- Make `sks --mad` check npm for a newer Sneakoscope release before launch and prompt y/n for updating in interactive terminals.
- Make MAD dependency repair install missing Codex CLI with `@latest`, install or upgrade cmux through Homebrew, and re-probe real cmux app bundle binaries after cask installation.
- Update README MAD/cmux troubleshooting docs for update prompts, `--yes`, and direct cmux app bundle discovery.

## [0.6.65] - 2026-04-29

### Changed

- Make `sks --mad` launch the cmux MAD profile as full-access high reasoning with Codex automatic approval review enabled via `approvals_reviewer = "auto_review"`.
- Align SKS auto-review profile generation with current OpenAI Codex docs by using `auto_review` instead of the legacy `guardian_subagent` reviewer value.

## [0.6.64] - 2026-04-29

### Changed

- Expand the README into a fuller open-source CLI guide with quick start, requirements, installation modes, terminal CLI usage, Codex App `$` commands, common workflows, troubleshooting, and release checks.

## [0.6.63] - 2026-04-29

### Changed

- Make `sks --mad --high` attempt Homebrew cmux installation and re-probe before launch when cmux is missing, with a concise launch blocker if installation cannot complete.
- Replace the first cmux banner box with a stronger SKS/cmux ASCII mark for the CLI workspace header.

## [0.6.62] - 2026-04-29

### Changed

- Make plain `sks --mad --high` wake the cmux app before creating the `sks-mad-high` Codex CLI workspace, so the command opens the cmux UI path directly.

## [0.6.61] - 2026-04-29

### Changed

- Replace the SKS terminal runtime with a cmux-based Codex CLI workspace flow, including cmux dependency checks, help/discovery surfaces, setup guidance, and Team cmux live lanes.
- Add `sks --mad --high` as an explicit one-shot cmux launch that writes and uses the `sks-mad-high` full-access high-reasoning Codex profile without changing the normal default route.

## [0.6.60] - 2026-04-29

### Changed

- Add `$MAD-SKS` as an explicit scoped database authorization modifier that can compose with other dollar-command routes while keeping the widened permission limited to the active invocation.
- Require table-removal operations to pause for short user confirmation even under MAD-SKS, and close the override when the active mission gate is complete.

## [0.6.57] - 2026-04-29

### Changed

- Add active TriWiki attention ranking so context packs expose compact `attention.use_first` recall and `attention.hydrate_first` source-check queues for higher-signal route and worker handoffs.

## [0.6.56] - 2026-04-29

### Changed

- Infer predictable ambiguity-gate contract answers from the prompt/default safety policy so SKS asks only unresolved behavior or safety questions instead of static `GOAL_PRECISE` and `ACCEPTANCE_CRITERIA` templates.
- Add a Team runtime graph compiler that remaps symbolic plan nodes to concrete task ids, writes scope-aware worker inboxes, and stop-gates the runtime graph artifacts before executor handoff.

## [0.6.55] - 2026-04-29

### Changed

- Require From-Chat-IMG completion to include scoped QA-LOOP evidence after the customer-request work is implemented, with every work-order item covered, post-fix verification complete, and zero unresolved QA findings.
- Raise the tracked-file size gate to 288 KiB for the enlarged From-Chat-IMG scoped QA-LOOP selftest while retaining the existing package size gates.

## [0.6.54] - 2026-04-29

### Changed

- Strengthen From-Chat-IMG completion gates with a required checked work checklist and temporary TriWiki-backed request snapshot, so chat screenshot text, image-region matches, work items, and verification steps are tracked before Team completion.
- Add From-Chat-IMG temporary TriWiki retention handling so session-scoped image-analysis claims can be pruned after the configured later-session TTL.

## [0.6.53] - 2026-04-29

### Changed

- Add a stop-gated From-Chat-IMG coverage ledger so every visible customer request, screenshot image region, and attachment must be mapped to work-order item(s) with `unresolved_items=[]` before Team completion.
- Teach Team plans, generated skills, prompt context, inferred acceptance criteria, and selftests to require the From-Chat-IMG no-omission work-order coverage pass.
- Add a compliance-loop guard so repeated identical stop-gate blocks produce an evidenced `hard-blocker.json` instead of looping indefinitely, re-evaluate normal gates after later repairs, and bound route runner `--max-cycles` values.
- Raise the tracked-file size gate to 272 KiB for the enlarged CLI selftest and Team plan coverage logic while retaining the 256 KiB packed tarball limit.

## [0.6.52] - 2026-04-28

### Changed

- Expand README with feature coverage for route commands, Codex App surfaces, workflow rules, release checks, and requirements.
- Raise package size gates to 256 KiB packed and 1 MiB unpacked so shipped README documentation has practical headroom while npm dry-run packaging remains verified.

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

- Add Korean `ㅅㅋㅅ` branding, cmux/setup guidance, Team live event logging, Codex CLI readiness handling, design/image skills, and Team-default execution routing.
- Fix Korean execution-prompt routing, Team continuation after ambiguity gates, Context7 readiness checks, changelog release checks, and Honest Mode loop-back/no-gap handling.
