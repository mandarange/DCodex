# Official Codex Subagent Scaling

`$sks-naruto` uses Codex official subagents as its default execution workflow.
SKS no longer treats native child-process count, PID overlap, Zellij pane count,
or a custom active pool as Naruto completion evidence.

The canonical policy is:

- parent: GPT-5.6 Sol with `model_reasoning_effort="max"`
- tiny short-context mechanical worker: GPT-5.6 Luna with `model_reasoning_effort="max"`
- ordinary implementation: GPT-5.6 Sol with `model_reasoning_effort="high"`
- review, debugging, planning, architecture, security, database, research,
  release, ambiguity, and judgment: GPT-5.6 Sol with `model_reasoning_effort="max"`
- long-context, Computer Use, Browser/Chrome, and image-generation execution:
  GPT-5.6 Terra with `model_reasoning_effort="medium"`
- mixed work is split by execution versus judgment when possible; an
  unsplittable mixed slice uses Sol Max
- automatic requested children start at 4 for bounded non-trivial work, 6 for explicit parallel work, 8 for large-scale work, and 16 for mass Luna/Terra work; after decomposition either lane may expand to 256 only when ready DAG width, disjoint ownership, verifier/tool capacity, real host slots, and positive marginal usefulness all permit it
- reviewer-only fan-out: at most 2 for ordinary work and 3 for critical multi-domain review
- explicit `--agents N` and `--max-threads N` values from 1 through 256 remain authoritative when the operator supplies them
- default `agents.max_concurrent_threads_per_session`: 256 child slots for fresh SKS-owned project config when Codex multi-agent V2 is available
- `features.multi_agent_v2.max_concurrent_threads_per_session`: 257 total session slots (root + 256 children)
- concurrency is a hard cap, not a utilization target; the parent is accounted outside the child cap and reviewer reservations are demand-driven
- `agents.max_depth`: 1 (V1-only; ignored by MA v2, still fail-closed in SKS)
- hard SKS child-frame safety cap: 256, with a measured lower Codex host or provider/API allowance remaining authoritative and returned capacity reused across waves

Completion requires matched thread evidence from official `SubagentStart` and
`SubagentStop` events, zero failed requested threads, and a trustworthy
`sks.subagent-parent-summary.v1` object with one explicit outcome per thread.
`delegation_context_ready` is preparation only and cannot pass the gate.

Canonical artifacts are:

```text
subagent-plan.json
subagent-events.jsonl
subagent-parent-summary.json
subagent-evidence.json
naruto-summary.json
naruto-gate.json
```

The historical Naruto process runtime and its environment opt-in are removed.
Legacy backend, scheduler, pool, and model flags fail closed. A standalone
terminal invocation launches at most one Sol Max `codex exec` parent, and a
Codex App/Desktop invocation returns official delegation context to the current
parent without nesting another Codex process.

The parent reuses only bounded TriWiki `attention.use_first` anchors and hydrates
their source hints on demand. It does not inject the full context pack into each
child or require repeated repository-wide context discovery.

The legacy release-gate ids `agent:native-cli-worker-runtime-scaling` and
`agent:fast-mode-policy` are retired. `naruto:canonical-stop-gate` validates
the official event-evidence contract once.
