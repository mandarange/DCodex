# Goal Runtime Migration

SKS 3.1.0 temporarily compiled `sks goal` requests into SKS-owned Loop Graphs and wrote `goal-compat.json`. That runtime is historical and is not a supported execution path in SKS.

Codex native `/goal` is now the only persisted goal owner. `sks goal create|edit|pause|resume|clear|status` is a stateless helper that renders a detailed native Goal command; it creates no SKS mission, compatibility artifact, loop, or fallback state. Implementation work continues through the selected SKS execution route rather than through a Goal-owned runtime.

`--legacy-goal-runtime` and `SKS_LEGACY_GOAL_RUNTIME=1` no longer restore the old runtime; they fail with an instruction to use native `/goal`. Treat existing `goal-compat.json` and legacy Goal mission state as non-authoritative historical artifacts.
