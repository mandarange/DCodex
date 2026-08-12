# CRK2 Baseline Summary — CG2-00

Measured before any Context Retrieval Kernel v2 code exists, so every later claim
of improvement is paired against a recorded starting point rather than a
remembered one.

| | |
|---|---|
| Commit | `9fadd4e232d93611792bce1cdad4ac8534bd4b84` (8.7.0) |
| Work-order base | `9bbc8b80` — ancestor of this commit, 9 commits back |
| Node | v24.0.2 |
| Host | Apple M1 Max, 10 cores, macOS 26.5.2 arm64 |
| Generated artifact | `.sneakoscope/bench/context-graph-v2-baseline.json` (gitignored) |

## Entry condition

All four context gates pass on this commit, so implementation may begin:

```
context-graph:contract         ok   blockers []
context-graph:quality          ok   blockers []
context-graph:performance      ok   blockers []
context-graph:legacy-closure   ok   blockers []
```

Canonical suite on this commit: 2929/2929, zero failures.

## The graph is 2.5× larger than the work order recorded

The work order's analysis (2026-08-10) described a ~31 MB snapshot with ~10,793
nodes and ~46,572 edges. This repository is now well past that, which raises the
cost of every JSON-shaped step the work order targets:

| | Work order | Measured |
|---|---:|---:|
| Snapshot | ~31 MB | **55.7 MB** |
| Nodes | ~10,793 | **26,973** |
| Edges | ~46,572 | **70,832** |
| `JSON.parse` | ~80 ms | **119 ms** |

`context-graph.prev.json` adds a further 52.6 MB, so the JSON runtime store is
**108 MB on disk** for one workspace. Parsing the current snapshot alone costs
175 MB heap and 368 MB RSS.

## Warm query latency

32 runs per case, first 2 discarded, `implementation` profile, one process.

| Case | p50 | p95 | p99 |
|---|---:|---:|---:|
| exact-symbol | 5.95 | 15.00 | 21.90 |
| exact-path | 3.56 | 5.11 | 5.59 |
| basename | **17.16** | **19.75** | **26.51** |
| acronym | **15.01** | 16.56 | 16.88 |
| jargon | 1.36 | 2.75 | 2.78 |
| korean | 1.20 | 2.04 | 2.12 |
| planning | 1.96 | 4.30 | 7.65 |

Two readings matter here, and they point in opposite directions:

**`basename` and `acronym` are the slowest cases by a wide margin.** That is the
signature of the query-time key scan in §2.2.B — neither has a posting list, so
both fall through to iterating `nodesByLabel` and `nodesByPath` and substring
matching every key. They are the cases the lexical index is meant to make fast.

**`korean` and `jargon` are the fastest cases, and that is not a win.** A query
that finds nothing returns quickly. These numbers are a floor to beat on
*quality*, not a latency budget to preserve; treating them as a performance win
would be reading the benchmark backwards. CG2-14 must report recall for these
cases before any latency comparison is quoted.

## Not captured, and why

- **`npm ci`** — the work order lists it, but this repository's postinstall
  writes the real `~/.codex`. It must be run with `HOME` redirected to a temp
  directory. `node_modules` was already installed from a clean tree, so the
  baseline does not depend on re-running it.
- **`sks align run` cold/warm compile timings** — needed before CG2-12 can claim
  the 50% incremental-compile target. To be captured with the compiler work.
- **GC count/time and allocation proxy** — needed for the CG2-14 allocation
  target; requires a run under `--expose-gc`.

None of these block the format, lexicon, or reader work, which is where the
critical path starts.
