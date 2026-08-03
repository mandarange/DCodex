# Parallel Write With Official Subagents

Parallel implementation uses the Codex official subagent workflow:

```bash
sks naruto run "update independent packages" --agents 8 --max-threads 12
```

`--agents` is the requested total thread count. `--max-threads` bounds concurrent
official threads, and larger requests run in waves. Project configuration keeps
`max_depth = 1`, so a delegated child cannot delegate again.

## Ownership

The parent decomposes work before spawning threads. Parallel write slices must
have independent objectives and disjoint file ownership. Overlapping paths are
serialized. Children do not integrate one another's work; the parent collects
every result, resolves conflicts, applies the final integration, and runs the
verification appropriate to the affected risk.

Each write-capable mission keeps these parent-owned artifacts current:

- `subagent-plan.json`
- `subagent-events.jsonl`
- `subagent-parent-summary.json`
- `subagent-evidence.json`
- `work-order-ledger.json`

## Completion

Flags, pane count, or process count do not prove completion. A parallel run
passes only when official start/stop events correlate to unique thread IDs,
every requested thread has a trustworthy parent outcome, no thread remains
open or failed, the parent integration is complete, and scoped verification
passes.

Displayed thread state never substitutes for the official event and parent
summary contract.
