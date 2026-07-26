# Context Graph — Production Readiness Audit

Read-only audit of the Context Graph work order after Waves 0–3 and integration.
No production source was modified to produce this document; every finding below
was either fixed during integration (and is recorded here with what the fix was)
or is listed as an accepted, explained limitation.

Base: `main` at the start of the work order. Head: the integration branch.
Scope: 176 files changed, ~30.8k insertions, ~0.9k deletions.

## 1. Legacy closure

The work order's required greps, run with `CHANGELOG.md` and work-order docs
excluded:

| Pattern | Result |
| --- | --- |
| `triwiki_codepack_local` | 0 |
| `simple counts avoid needing a real dependency graph` | 0 |
| `attentionRelevance` | 0 |
| `scanCodebaseIndex` | 0 |
| `searchFilesJs\|searchTextJs` in `src/core/search/context.ts` | 0 |

`src/core/triwiki/code-index-scanner.ts` is deleted, not parked. There is no
`legacy/`, `compat/`, `_old` or `deprecated` copy, no dead alias, no `catch`
branch calling an old engine, and no environment flag that revives one. The only
`legacy`-shaped paths remaining are inside benchmark fixtures and query test
fixtures, where they are deliberate fixture *content* (a file named
`src/legacy/old.ts` that a stale-claim case points at), not a code path.

`context-graph:legacy-closure` encodes all of the above so it stays true.

## 2. Findings fixed during integration

| ID | Severity | Where | Observed | Expected | Fix |
| --- | --- | --- | --- | --- | --- |
| CG-01 | blocker | `contracts.ts` vs `ids.ts` | Sort order checked with `localeCompare`, produced with codepoint order; real snapshots failed their own sortedness lint on 145 id pairs | One total order | Both use the shared codepoint `compareContextGraphIds`. `localeCompare` is ICU-dependent, so it could also have made two machines hash identical input differently |
| CG-02 | blocker | `lint/rules.ts` | Node fields were joined before scanning, inventing secrets: a symbol named `BEARER` followed by its own path read as `Bearer <token>`; the real `secret:preservation` gate id read as a key assignment | Only real key material fails | Values scanned individually; a value with no high-entropy run is a structural identifier. Raw environment values still fail closed |
| CG-03 | high | `extractors/code` | 44 MB snapshot; 11,288 of 18,067 symbols were neither exported nor touched by any edge but their own `contains` | Bounded artifact | Prune unreachable symbols with their containing edge → 31 MB |
| CG-04 | high | `.gitignore` | 31 MB of generated cache was about to be committed | Generated artifacts are not source | Snapshot, meta, prev and event log gitignored |
| CG-05 | high | `profiles.ts` | `routes_to` appeared in no profile, so every `command` and `route` node was unreachable by any query | Command→gate paths answerable | Added to implementation, review and planning |
| CG-06 | high | `benchmark/fixtures` | Fixtures declared gates in `sks.fixture-gates.v1` at `config/gates.json`, which no extractor reads → gate recall 0 for *both* adapters, i.e. the gate floor measured nothing | Fixtures exercise the real extractor | Fixtures emit real `release-gates.v2.json`; a gate may declare `protected` outright |
| CG-07 | high | `benchmark/adapters` | Conflicts derived from an `owns` fan-in proxy no extractor emits → conflict recall floor unmeasurable | Measure the production path | Candidate calls `narutoContextGraphAdviceFromIndex`, passing the advisor its declared `writePaths` |
| CG-08 | medium | `package.json` | Benchmark corpus, fixtures and tuning optimizer shipped in the tarball | Dev instruments do not ship | Excluded from the packlist; budgets raised only for the runtime surface |
| CG-09 | medium | `benchmark/fixtures` | Fixture data generated `dist/scripts/<id>-check.js` strings, read by the closure check as runtime references | Fixtures do not impersonate this package | Fixture commands use `tools/` |
| CG-10 | medium | `extractors/topology/shared.ts` | A 5th copy of the `sha256` helper (limit 3) | One shared helper | Uses `fsx.sha256` |
| CG-11 | medium | `release-gate-contract.ts` | New release-preset gates absent from the frozen contract | Contract covers the preset | Five ids added |
| CG-12 | low | `official-subagent-prompt.test.ts` | Test asserted the deleted lexical promotion | Test asserts the current contract | Rewritten to assert pack trust order plus hint attachment |

## 3. Findings from the parallel workers, resolved

- **J01** reported nine committed `.ts` files that contain raw NUL bytes as key
  separators inside template literals. A git-style "NUL in the first 8 KB means
  binary" heuristic silently refused all of them; binary detection is now
  "undecodable UTF-8, or ≥4 control bytes at ≥1% density", with a regression test.
- **J06** reported that the live snapshot contains no `wiki_claim`, `source` or
  `proof` nodes for this workspace, so the `answer` profile currently traverses
  little here. That is a property of this workspace having no sealed context pack
  or proof bank, not of the engine: the evidence extractor returns an empty
  fragment plus explicit skips, and the behaviour is covered by fixtures.
- **J07** noted a tension between "0 process spawns" and preflighting through
  `contextGraphStatus`, whose cache key runs `git`. Resolved by attribution: the
  query itself spawns nothing, and the preflight is memoized per workspace for a
  short window. A fully spawn-free probe is available and now reachable as
  `sks triwiki graph-status --fast`.
- **J05b** flagged that `project_code_execution_zero` sums project-code execution
  and process spawns for *all* adapters, and the pre-graph search providers shell
  out to `git ls-files`. No scored corpus case uses a git-backed fixture today, so
  it does not bite; recorded as a latent coupling rather than silently zeroed.

## 4. Accepted limitations

1. **Snapshot size.** ~31 MB / 10,793 nodes / 46,572 edges for this repository.
   Parse is ~80 ms and the artifact is gitignored and unshipped, but it is large
   for a per-project cache. `limits` bounds it; a compact on-disk encoding (id
   interning) is the obvious next step and is not in this change.
2. **Gate recall 0.60 on the locked corpus.** Protected-gate recall is 1.00,
   which is the floor; ordinary gate recall is not, and is reported honestly
   rather than tuned by editing the corpus.
3. **Corpus ceiling on one case.** `command-handler-route-pipeline-gate` caps the
   candidate at 0.75 because its gold set names a `.json` file no extractor nodes.
   The gold set was deliberately **not** edited to raise the score.
4. **`cochanged_with` / `conflicts_with` have no extractor.** Section 4.4 makes
   the git-observation extractor explicitly optional and post-benchmark; it is not
   implemented, so those edge types exist in the contract with no producer.
5. **`context-graph/optimizer` has no production referrer.** It is a manually
   invoked development tool documented in
   `docs/architecture/context-graph-optimization-loop.md`, and it is excluded
   from the tarball.

## 5. Safety properties verified

- No secret, raw environment value, raw prompt, raw tool output, or absolute or
  home path in any graph artifact; every path is workspace-relative POSIX.
- No project code executed and no dynamic import of workspace code during
  extraction; no process spawn on the query hot path.
- Missing, stale and corrupt graphs return an explicit `context_graph_*` code
  with the repair command and no results. There is no lexical fallback branch.
- Atomic write with exactly one previous generation; a corrupt current snapshot
  never resolves to the previous one; concurrent compilers cannot both commit.
- Deterministic snapshot hash across repeated compiles of identical input.
- Publish authority unchanged; nothing in this change can publish.
- The release affected selector is augmented additively and asserts that it never
  drops a gate the exact changed-file selector chose.

## 6. Blockers

**None.** Every blocker found during the work order is in section 2 with its fix.
