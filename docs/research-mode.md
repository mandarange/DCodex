# Research Mode

Research and AutoResearch now use Super Search for evidence acquisition and the Codex official subagent facade for adversarial manuscript review.

## Official Research Reviewers

Three composite, persona-inspired Astra Max lenses independently attack the manuscript through the project-scoped `research_reviewer` custom agent. The lenses combine first-principles explanation and experiment design, formal systems and adversarial strategy, and counterevidence and base-rate scrutiny. Their structured thread outcomes are stored in `research-adversarial-review.json`; bounded revisions are recorded in `research-revision-ledger.json`; convergence is recorded in `research-adversarial-convergence.json`.

`agent-ledger.json`, `debate-ledger.json`, and `genius-opinion-summary.md` are compatibility projections derived from those structured outcomes. They no longer create synthetic unanimous consensus.

## AutoResearch

AutoResearch inherits the same policy: it uses only official subagent reviewers, does not recursively invoke Research, and cannot finalize until all three structured reviewers approve with zero critical, major, minor, or required revisions. Every successful revision is followed by a fresh full three-thread review.

Mock runs exercise artifact and fail-closed contracts only. They do not prove live source quality, model intelligence, novelty, or publication readiness.
