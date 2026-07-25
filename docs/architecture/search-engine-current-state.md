# Search Engine Current State (Inventory)

Schema lock: `sks.search-provider.v1` / `schemaVersion: 1`  
Inventory date: 2026-07-25  
Package version at inventory: 7.1.3

## Executive summary

SKS historically split discovery/search across Node recursive walks, optional
external `rg` / `ast-grep` CLIs, `git ls-files`, TriWiki code packs, and
Super Search (web/source intelligence). Responsibilities were not separated into
files / text / structure / symbol / context engines. Hot paths could spawn
external processes per query. This document inventories real call paths before
the modernization that routes:

| Mode | Target engine |
|------|---------------|
| files | Rust `ignore` via `sks-rs` (+ JS ignore-aware fallback) |
| text | Rust grep crates via `sks-rs` (+ JS scanner fallback; no `rg` on hot path) |
| structure | In-process TypeScript AST (no required `ast-grep` install) |
| symbol | TriWiki code index + TS syntactic analysis with confidence levels |
| context | TriWiki + Wiki Code Pack (no new vector DB) |

Super Search remains a **distinct** web/source-intelligence provider.

## Data flow (authoritative)

```text
Caller (CLI / verification / TriWiki / Review / DFix / QA / release)
  -> SearchProvider.search(request)
       mode=files|text|structure|symbol|context
  -> cache key (root, HEAD, worktree fingerprint, query, mode, globs, engine+schema)
  -> engine:
       files/text: prefer sks-rs IPC (one process), else JS fallback labeled provider=js
       structure: typescript createSourceFile patterns (capability error otherwise)
       symbol: TriWiki index + syntactic/text_candidate confidence
       context: TriWiki hydrate + code pack metadata
  -> SearchResponse (schemaVersion:1, deterministic match order)
```

## Call-path inventory

### 1. File discovery

| File / function | Purpose | Tool today | External process? | Call frequency | gitignore? | Symbol/AST? | Result format | Cache? | Duplicate? | Replace? | Recommended engine |
|-----------------|---------|------------|-------------------|----------------|------------|-------------|---------------|--------|------------|----------|--------------------|
| `src/core/fsx.ts` `listFilesRecursive` | Generic recursive file list | Node `readdir` walk | No | High (retention, verification, feedback) | Prefix ignore list only (not full gitignore) | No | `string[]` abs paths | No | Shared utility | Prefer migrate hot callers to `search files` | files / Rust ignore |
| `src/core/triwiki/code-index-scanner.ts` `listSourceFiles` / `tryGitLsFiles` | Source inventory for TriWiki code index | `git ls-files` or walk fallback | Yes (`git`) when repo | Medium (wiki refresh --code) | Via git exclude-standard | Export line regex | Rel paths | Index artifact | Overlaps fsx walk | Keep git for tracked set; supplement with search files for untracked | files + TriWiki |
| `src/core/triwiki/triwiki-cache-key.ts` `collectInputFiles` | Cache-key input inventory | Node walk | No | Medium | Partial | No | records | Cache key | Related to code pack | Keep for key hashing; discovery via search files | files |
| `src/core/verification/machine-feedback.ts` test discovery | Find test files | `listFilesRecursive` | No | Medium | Hardcoded ignores | No | paths | No | Uses fsx | Migrate to search files | files |
| `src/core/verification/mistake-rule-compiler.ts` | Changed/default file set | `listFilesRecursive` | No | Low | Hardcoded | Optional ast-grep later | paths | No | Uses fsx | Migrate listing | files |
| `src/core/retention.ts` (multiple) | Mission/report size scans | `listFilesRecursive` | No | Low/medium | Often empty ignore | No | paths | No | Uses fsx | Keep fsx for mission trees (not repo discovery) | retain fsx |
| Release pack scanners (`release-pack-content-scanner`, `npm-pack-proof`, etc.) | Pack content enumeration | `readdirSync` walks | No | Release gates | .npmignore/.gitignore aware in places | No | pack lists | Fixture cache | Release-specific | Keep (not interactive search) | retain |
| Scripts (`check-architecture`, `runtime-*-check`, etc.) | Gate filesystem scans | `readdirSync` | No | CI | Ad hoc | No | lists | No | Many one-offs | Keep for gates; do not unify into SearchProvider | retain |

### 2. Text / content search

| File / function | Purpose | Tool today | External process? | Call frequency | gitignore? | Symbol/AST? | Result format | Cache? | Duplicate? | Replace? | Recommended engine |
|-----------------|---------|------------|-------------------|----------------|------------|-------------|---------------|--------|------------|----------|--------------------|
| `src/core/verification/impact-scan.ts` `ripgrepReferences` | Find symbol text hits for impact | `rg` CLI | **Yes** | Medium (impact/cochange) | Glob excludes only | No (word regex) | ImpactReference[] | No | Falls back from ast-grep | **Migrate to search text**; confidence `text_candidate` | text |
| `src/core/verification/impact-scan.ts` `builtinReferences` | Fallback content scan | `listFilesRecursive` + RegExp | No | When rg/ast-grep missing | Hardcoded | No | ImpactReference[] | No | Duplicate of text engine | Collapse into SearchProvider text | text |
| `src/core/code-structure.ts` signal regexes | Lean/sanity text heuristics on changed files | In-process regex | No | Release/review | Diff-scoped | Heuristic | findings | No | Not a search API | Keep as analysis, not SearchProvider | retain |
| Super Search local fetch | HTTP/local URL acquisition | HTTP | N/A | Research routes | N/A | N/A | source records | Cache | Distinct product | **Do not merge** into local code search | retain Super Search |

### 3. Structure search (AST)

| File / function | Purpose | Tool today | External process? | Call frequency | Notes | Recommended |
|-----------------|---------|------------|-------------------|----------------|-------|-------------|
| `impact-scan.ts` `astGrepReferences` | Prefer AST hits for symbols | `ast-grep` CLI | **Yes** (optional install) | Medium | Silent fallthrough to rg | structure (TS API) + symbol confidence |
| `mistake-rule-compiler.ts` ast-grep detectors | Rule validation / detection | `ast-grep` CLI | **Yes** | Low | Capability gated by `which` | structure with explicit capability errors |
| Tree-sitter | Not present as runtime dep | — | — | — | Would duplicate parsers if added beside TS API | Reject as permanent second parser for TS/JS |

**Comparison (Phase 4 decision):**

| Option | Packaging | Required external install? | TS/JS quality | Verdict |
|--------|-----------|----------------------------|---------------|---------|
| ast-grep CLI | Host binary | Yes | Good | Reject as core required path |
| `@ast-grep/napi` | Native npm addon | No CLI, but native build/publish cost | Good | Deferred; conflicts with "no prebuilt .node in package" boundary |
| Rust ast-grep lib in sks-rs | Optional accelerator | No for npm install | Good if linked | Optional future; not required |
| TypeScript compiler API | Already `typescript` dep | No | Best for TS/JS | **Selected** for structure mode |

### 4. Symbol / reference

| File / function | Purpose | Tool today | External process? | Confidence today | Recommended |
|-----------------|---------|------------|-------------------|------------------|-------------|
| `impact-scan.ts` `findReferences` | Cochange references | SearchProvider symbol mode (TS LanguageService) | No rg/ast-grep | `exact_*` / syntactic / text | Preserve LS-backed exact confidence; never promote text |
| `code-index-scanner.ts` export extraction | Module export summaries | Line regex | No | Implicit definition-ish | Feed `exact_definition` candidates via symbol mode |
| TriWiki proof bank / module cards | Bounded recall | Index artifacts | No | Provenance hashes | context + symbol hydrate |

### 5. AI context / code pack

| File / function | Purpose | Tool | External? | Recommended |
|-----------------|---------|------|-----------|-------------|
| `src/core/triwiki/code-pack.ts` | Wiki code pack | Index + pack writer | git/walk | context mode metadata |
| `src/core/hooks-runtime/code-pack-freshness-preflight.ts` | Freshness gate | HEAD fingerprint | No | Wire freshness into SearchResponse context |
| `src/core/subagents/triwiki-attention.ts` | Attention anchors | Context pack | No | Consume context mode; no vector DB |

### 6. Adjacent surfaces (not merged)

| Surface | Role | Keep distinct? |
|---------|------|----------------|
| Super Search | Web/source intelligence | Yes |
| `search-visibility` | SEO/GEO marketing kernel | Yes |
| Import graph budgets (`perf/import-graph-budget`) | Static import edges | Yes (may call files mode later) |
| Release affected selectors | Changed-file selection via git | Yes |
| `fsx:hotpath` | Perf budgets for fs helpers | Measure after migration |

## External process spawn sites (pre-modernization)

1. `rg` — `impact-scan.ripgrepReferences` (hot candidate)
2. `ast-grep` — `impact-scan.astGrepReferences`, `mistake-rule-compiler`
3. `git ls-files` — TriWiki code index (acceptable; not per-search content grep)
4. `sks-rs` — optional accelerator (hash/voxel/secret today; search added)

## Baseline benchmark lock

Baseline artifact path (post Phase 1 run):  
`.sneakoscope/reports/search-engine-benchmark.json`

Scenarios locked (1–15): cold/warm file discovery, text regex (simple/Unicode/Korean),
case fold, long line, binary skip, hidden/ignored/symlink, structure TS pattern,
symbol same-name / re-export, context pack hydrate, batch 20 queries, vs legacy
`rg` CLI (when present), process spawn count, RSS/CPU, AI token estimate for
context omissions.

## SearchProvider schema (locked)

See `src/core/search/types.ts`:

- `SearchMode`: `files` | `text` | `structure` | `symbol` | `context`
- `SearchRequest` / `SearchMatch` / `SearchResponse`
- Required: `schemaVersion: 1`, `provider`, `confidence`, `truncated`, `timeout`,
  `limits`, `scanned`/`skipped`, `cacheHit`, `warnings`, deterministic ordering

## Migration priority

1. `impact-scan` text/structure/symbol (removes rg/ast-grep hot path)
2. Verification file listing callers needing gitignore accuracy
3. CLI `sks search *` + doctor search surface
4. TriWiki context metadata enrichment
5. Leave retention/pack/gate walks on fsx unless they need repo gitignore fidelity

## Retained `rg` paths (intentional)

None as a **core runtime dependency**. Optional operator-side `rg` may still be
used in benchmarks for comparison only. Production SearchProvider paths must not
require `rg` or `ast-grep` to be installed.
