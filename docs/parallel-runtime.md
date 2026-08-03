# Parallel Runtime

SKS 2.0.12 uses a worktree-per-write-worker model for Git projects. Write-capable workers receive isolated worktrees, export patch envelopes or checkpoint commits, and parent integration applies the result through the merge queue.

For non-Git projects, SKS falls back to patch-envelope-only execution. Workers can still produce scoped patch envelopes, but no Git worktree allocation, checkpoint commit, or cross-rebase claim is made.

Release DAG gates run hermetic checks in parallel. Runtime claims should be backed by blackbox artifacts, release gate reports, or real checks. Source-string checks can exist as guardrails, but public release claims require runtime proof.

Real environment checks are opt-in with `SKS_REQUIRE_*` variables; skipped optional real gates must not be presented as live evidence.
