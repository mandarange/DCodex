# Naruto Worktree Parallelism

`$sks-naruto` fans out work through the native agent scheduler while keeping writes lease-based and non-overlapping. The allocation policy assigns work items by role, path, and domain hints, then the scheduler consumes the allocation-backed work graph.

Git projects use worktree-per-write-worker when capability checks pass. Dirty worker worktrees can produce checkpoint commits, and integration prefers checkpoint cherry-pick before falling back to diff apply.

Non-Git projects and read-only work use patch-envelope-only fallback. The fallback is explicit in mission artifacts and must not be described as Git worktree proof.

Worktree-derived candidate output is draft material until GPT Final approves or modifies it. Missing GPT Final keeps patch application in dry-run or blocked mode.
