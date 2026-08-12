# TriWiki Context Graph

`sks search context` used to be a name without the thing. It ran a path search
and a text search, merged the two result sets, stamped every hit
`confidence: context_pack`, and reported `hydrated: true` whenever a pack file
happened to exist on disk. No traversal, no reverse dependencies, no
claim-to-source hydration, no code → test → gate → proof path, and no way to say
*why* a file was returned.

The Context Graph replaces that with one compiled, typed, evidence-backed graph
that sits between repository truth and every consumer.

```text
Repository Truth
  ├─ source files / symbols / imports / exports
  ├─ command, route, pipeline manifests
  ├─ release-gates.v2.json / infra-harness-gates.json
  ├─ tests / schemas / config
  ├─ TriWiki claims / sources / context pack
  ├─ proof cards / invalidation material
  └─ git HEAD + dirty fingerprint
          │  deterministic extractors
          ▼
   ContextGraphFragment[]
          │  compiler: stable ids, entity resolution, reverse index,
          │            provenance lint, freshness, SCC, snapshot hash
          ▼
  .sneakoscope/wiki/context-graph.json (+ .meta.json, .prev.json, events.jsonl)
          │  bounded query: seeds → profile traversal → scoring →
          │                 redundancy suppression → token packing → explanations
          ▼
  SearchProvider context · TriWiki attention · code/context pack projections ·
  Naruto scope advisory · affected test/gate recommendation · benchmark
```

## Non-negotiables

1. **The graph is a cache, never truth.** Repository files, schemas, manifests,
   gate definitions, proof cards, and test results are the truth. Every node and
   edge carries provenance back to one of them.
2. **No edge without provenance.** An edge missing `{ path, hash, extractor }`
   never reaches a snapshot; the lint treats it as a hard error.
3. **No silent fallback.** A missing or stale graph produces
   `context_graph_missing` / `context_graph_stale` plus the repair command
   `sks align run`. It never quietly degrades to text search.
4. **No model-authored facts.** Only mechanically observed relations, or claims
   that cite a source, become edges.
5. **Nothing leaks.** No secrets, environment values, raw prompts, raw tool
   output, SQL rows, API bodies, or absolute/home paths in any artifact. Every
   path is a workspace-relative POSIX path.
6. **No new product surface.** No new top-level command, no external graph
   database, no daemon, no extra scheduler. The graph lives inside the existing
   `wiki` / `triwiki` / `search` / `naruto` / gate surfaces.

## Contract: `sks.context-graph.v1`

`v1` is a machine schema revision. It is not a recommendation to run a
particular product version — see
[latest-version-guidance-policy.md](latest-version-guidance-policy.md).

**Node kinds** — `file`, `symbol`, `module`, `command`, `route`, `pipeline`,
`test`, `gate`, `schema`, `config`, `wiki_claim`, `source`, `proof`,
`risk_domain`.

**Edge types** — `contains`, `defines`, `imports`, `reexports`, `references`,
`calls`, `depends_on`, `routes_to`, `owns`, `tests`, `verified_by`, `gated_by`,
`affected_by`, `cites`, `derived_from`, `supports`, `contradicts`, `supersedes`,
`invalidates`, `cochanged_with`, `conflicts_with`.

Adding a kind or a type requires all three of: a real fixture the existing set
cannot express, benchmark evidence that it helps, and lint plus serialization
support.

### Stable identity

IDs never contain a timestamp or an array position, so three compiles of the
same repository state produce the same snapshot hash:

```text
file:<relative-path>            module:<module-id>
symbol:<path>#<kind>:<name>@<start-offset>
command:<name>                  route:<name>            pipeline:<id>
test:<path>#<name>              gate:<gate-id>          schema:<schema-id>
config:<path>#<key-path>        claim:<hash>            source:<hash>
proof:<proof-id>                risk:<domain>
```

An edge id is a digest of `(type, from, to)` only. Two extractors that observe
the same relation therefore produce the same id and merge rather than duplicate.

## Extraction

| Extractor | Source of truth | Notes |
| --- | --- | --- |
| `code` | TypeScript compiler API | Parses with `ts.createSourceFile` and resolves specifiers with `ts.resolveModuleName` + the parsed `tsconfig`, so path aliases, package `exports`, index resolution, NodeNext `.js` → `.ts` mapping, and barrel re-export chains are the compiler's answer rather than a regex guess. Never executes project code and never loads TS plugins. |
| `topology` | command/route/pipeline manifests, `release-gates.v2.json`, `infra-harness-gates.json`, `runtime-required-scripts.json` | Imports the manifest APIs; never regex-scrapes registry source and never runs a workspace command to discover topology. |
| `evidence` | TriWiki context pack, proof bank | Bounded projections only. An invalidated, expired, or corrupt proof never produces a strong `verified_by` edge and is never marked fresh. |

Unsupported languages, binaries, oversized files, and symlinks escaping the
workspace produce an explicit `ContextGraphSkip` with a reason — never a silent
drop and never a relation labelled more confidently than it was observed.

## Compile, store, lint

The compiler fingerprints its inputs (workspace identity, HEAD, tracked dirty
fingerprint, untracked fingerprint, schema revision, tsconfig hash, command and
gate manifest hashes, proof index hash, wiki context hash), extracts only what
changed plus its reverse closure, resolves entities by stable id, merges exact
and manifest edges before derived ones, builds the reverse index, computes
strongly connected components for cycle metadata, propagates freshness from
source hashes, lints, serializes deterministically, hashes, and writes
atomically. `generated_at`-style fields are excluded from the hash input.

Storage stays inside the existing `.sneakoscope` boundary:

```text
.sneakoscope/wiki/context-graph.json
.sneakoscope/wiki/context-graph.meta.json
.sneakoscope/wiki/context-graph-events.jsonl   (bounded append-only)
.sneakoscope/cache/context-graph/fragments/    (content-hash fragment cache)
```

A corrupt current snapshot is a blocker naming the repair command, not an excuse
to serve the previous generation as if it were current.

**Hard lint failures** block the write entirely: duplicate node id with
conflicting content, dangling edge, edge without provenance, absolute or
escaping path, symlink escape, secret-like or raw environment value, unsupported
node/edge type, non-deterministic serialization, protected gate without a source
relation, manifest DAG cycle, hash mismatch, snapshot/meta mismatch, and a
`fresh` marking that disagrees with the current source hash.

**Warnings** are reported but do not block: orphan wiki claim, single-source
low-trust synthesis, unknown freshness, high fan-in module with no test or gate
edge, and a node unreachable in every query profile.

## Query

```text
normalize query
  → exact symbol/path/command/gate/claim seeds
  → lexical seeds only when exact seeds are insufficient
  → profile-specific bounded traversal
  → trust / freshness / provenance scoring
  → duplicate and redundant node suppression
  → token budget packing
  → explanation path generation
```

Profiles select which edges are traversed at all:

| Profile | Priority edges |
| --- | --- |
| `implementation` | `defines`, `contains`, `imports`, `reexports`, `references`, `calls`, `tests`, `verified_by` |
| `review` | `affected_by`, `tests`, `gated_by`, `verified_by`, `invalidates`, `conflicts_with` |
| `planning` | `depends_on`, `owns`, `affected_by`, `conflicts_with`, `cochanged_with`, `gated_by` |
| `answer` | `derived_from`, `cites`, `supports`, `contradicts`, `supersedes` |

Scoring is deterministic weighted traversal — no embeddings, no vector database,
no LLM reranker, no PageRank in the base implementation. All weights live in
`src/core/triwiki/context-graph/query/ranking-config.ts`; all traversal caps live
in `profiles.ts`. Those two files are the only surfaces the bounded optimizer may
change.

Depth is capped at 2 for ordinary queries and 3 for protected/high-risk review.
Hitting a cap or a timeout returns `truncated` / `timeout` plus omission reasons;
a partial answer is never dressed up as a complete one.

The token packer guarantees at least one exact seed, at least one provenance
source per seed, a test or gate for implementation queries where one exists, no
missing protected gate on a high-risk query, structural diversity so one module
cannot monopolize the budget, a reason path for every selected node, and that the
budget is respected.

## What each consumer gets

- **`sks align run`** compiles the graph incrementally, lints it,
  writes the snapshot atomically, and projects `code-pack.json` from it. The old
  scanner is not kept running alongside — one source of truth, one projection.
- **`sks wiki validate`** additionally checks graph schema/lint, snapshot/meta
  parity, source-hash freshness, projection parity, proof invalidation
  propagation, and the latest-version guidance policy.
- **`sks triwiki graph-status|graph-lint|graph-query`** are read-only
  diagnostics. Rebuilds belong to `sks align run`.
- **`sks search context`** answers from the graph. Symbol/path/text search is
  used only to acquire seeds, and each seed keeps its own confidence — a text hit
  never becomes an exact reference. `hydrated` is true only when selected nodes
  actually resolved to a source.
- **TriWiki attention** returns `reason_path`, `trust_score`, `freshness`,
  `token_cost`, and `provenance` per anchor instead of lexical token overlap.
- **Naruto** receives *advice only*: candidate slices, reachable write scope,
  overlap detection, protected risk domains, affected tests and gates, and the
  reasons behind them. It never spawns agents, never skips a protected gate, and
  goes conservative when the graph is stale.
- **The release affected selector** uses the graph as an additional signal. It
  may add gates; it may never reduce the set the existing exact changed-file
  selector produces.

## Gates

| Gate | What it proves |
| --- | --- |
| `context-graph:contract` | Contract, ids, path safety, schema parity, determinism |
| `context-graph:quality` | Retrieval floors and hard safety floors on the locked corpus |
| `context-graph:performance` | Warm/cold latency and token budget floors |
| `context-graph:legacy-closure` | The replaced lexical paths are gone, with no alias or fallback left behind |
| `latest-version:guidance` | No user-facing pinned version guidance |

The first four share one implementation, `src/scripts/context-graph-check.ts`,
selected by `--mode`.
