# Sneakoscope Codex performance and leak policy

Sneakoscope Codex 10.0.0 is designed to keep runtime, package size, RAM, and storage bounded.

## Speed

- `codex exec` output is streamed to files and only a bounded tail is retained in memory.
- `sks perf run --json` records structured startup and package-payload measurements and writes `.sneakoscope/perf/budgets.json`.
- Codex native `/goal` workflows exclusively own persisted goals; SKS creates no Goal mission, bridge artifact, compatibility loop, or fallback state.
- `sks wiki sweep` records intentional forgetting and promotion candidates so default recall stays top-K instead of becoming an unbounded memory dump.
- `sks code-structure scan` flags 1000/2000/3000-line handwritten source files before new logic is added to oversized modules.
- TriWiki claim selection uses bounded top-K selection plus the latest RGBA/trig wiki anchors and required voxel overlay metadata instead of sorting unbounded context into prompts.
- Voxel TriWiki code indexing uses full-content cache hashes, excludes cache/worktree mirrors, enforces a dedicated token budget, and serializes wrongness-ledger updates so fast recall cannot trade correctness for partial hashes or lost concurrent writes.
- GX visual context renders deterministic SVG/HTML from JSON sources, avoiding external image-generation latency, cost, and nondeterminism. Rendered nodes expose the same RGBA wiki-coordinate anchors used by TriWiki.
- `sks gc` keeps mission/runtime artifacts bounded.
- Desktop Bridge performance is measured, not assumed: record local routing
  overhead, provider-registry cold/warm load, combined-catalog build time,
  status/transport-verification duration, first native render, and resource
  stability under repeated mixed-provider requests before making a speed claim.
- Naruto treats a persisted 1000-thread preference as configuration input, not
  an execution entitlement. Runtime capacity is capped at 256 child threads
  and 257 total threads; explicit CLI requests above 256 are rejected.

## Evaluation metrics

`sks eval run` creates a deterministic JSON report in `.sneakoscope/reports/` unless `--no-save` is used. The built-in scenario compares an uncompressed all-claims baseline with a TriWiki compressed context capsule.
`sks perf run --json` is the lightweight runtime probe for CLI startup and package payload budgets.
`sks perf cold-start --json` and the release `perf:gate` use 20 process-spawn samples by default so p95 is not just the single slowest run. The release gate also retries once when every command exited successfully and only the timing budget missed, which keeps transient OS scheduling noise from blocking publish while still failing persistent regressions.

Tracked metrics:

- `serialized_size_bytes`: deterministic UTF-8 JSON size used as a non-token payload-size proxy; it never proves token usage
- `token_count`: actual tokenizer or API-reported count, accepted only with a nonempty `token_evidence.source`
- `token_savings_pct`: actual token reduction, available only when baseline and candidate use the same `token_evidence.source` measurement identity
- `accuracy_proxy`: evidence-weighted context-selection quality score
- `required_recall`: required claim coverage
- `relevance_precision`: selected required claims divided by selected claims
- `support_ratio`: selected claims that are supported or weakly supported
- `unsupported_critical_selected`: critical/high unsupported claims that survived compression
- `context_build_ms_per_run`: local context construction runtime
- `meaningful_improvement`: true only when comparable actual-token evidence, token savings, accuracy delta, recall, unsupported-critical filtering, and runtime thresholds pass

Default meaningful-improvement thresholds are intentionally explicit: at least 10% measured token savings with matching evidence identity, at least +0.03 accuracy-proxy delta, at least 0.95 required recall, zero unsupported critical claims selected, and candidate context construction under 25 ms per run. Without comparable actual-token evidence, token savings are `null` and meaningful improvement cannot pass. `sks eval compare --baseline old.json --candidate new.json` compares saved reports across implementations; legacy estimated-token reports remain readable but do not become token evidence.

The accuracy metric is not a live model task score. It is a deterministic proxy for whether the context handed to a model is smaller, better supported, and less contaminated by unsupported critical claims.

## LLM Wiki coordinate continuity

TriWiki does not treat compression as permanent deletion. The visible context pack includes selected claim text plus the latest compact LLM Wiki coordinate index and required voxel overlay metadata:

```text
R channel -> domain angle
G channel -> layer radius via sin()
B channel -> phase angle
A channel -> concentration/confidence
```

Each anchor stores id, RGBA key, `[domain, layer, phase, concentration]`, source path, status/risk, and a text hash. Each valid pack also includes `sks.wiki-voxel.v1` rows keyed by quantized domain/radius/phase with semantic, trust, freshness, priority, conflict, route, and cost metadata. Coordinate-only legacy packs are invalid and should be regenerated with `sks wiki refresh` or `sks wiki pack` before any pipeline uses them.

## Package size

- Runtime dependencies remain explicit in `package.json`; the package pins `@openai/codex-sdk` exactly and the lockfile must resolve its matching `@openai/codex` dependency without vendoring that CLI package inside the SKS tarball. `SKS_CODEX_BIN` may select a separately installed compatible CLI, which is accepted only after runtime capability checks.
- Optional Rust source is in `crates/sks-core/` and is included in the npm package as source only. Build artifacts under `target/` stay excluded.
- GX rendering uses only built-in Node.js APIs and ships as source in the npm package.
- `npm run sizecheck` enforces package limits during `release:check`, local pack verification, and authorized publish: `<=2870 KiB` (`2,938,880` bytes) packed, `<=13,200,000 bytes` unpacked, `<=2100` package files, and `<=384 KiB` per tracked file by default. The last baseline recorded beside the shared budget is `2,920,497` packed bytes and `13,151,730` unpacked bytes across `1,648` files, leaving `18,383` packed and `48,270` unpacked bytes of headroom.
- The packed and unpacked caps come from the shared release size-budget SSOT, matching sizecheck, publish dry-run performance, pack-receipt, runtime-script-closure, and packlist gates. The exact candidate byte counts remain bound to the generated release receipt; further changes still require measured justification.

## Memory leaks

- Child process stdout/stderr never accumulate unbounded strings.
- Large outputs are written to log files and returned as tails.
- Recursive file walking has file/depth caps.
- No long-lived global caches are used.

## Storage leaks

- `.sneakoscope/policy.json` controls retention.
- Old missions, old cycle directories, arenas, temp files, oversized JSONL logs, and terminal inactive worker runtime homes are removed or rotated by `sks gc`; `route_closed` records are inactive, while recently updated non-closed sessions receive a two-hour protection window.
- Mission compaction preserves durable JSON and review/image evidence in place and removes only known disposable runtime files. Existing legacy gzip archives are hydrated transparently only after their payload path and original SHA-256 are verified.
- Cleanup containment checks reject symlink or realpath escapes, and bounded scans report when the inspected set is incomplete instead of claiming a full cleanup.
- `sks stats` reports package/state size, while the full retention budget scan counts every `.sneakoscope` top-level directory and root file with a per-directory 1,000,000-file safety ceiling instead of silently stopping at the former partial scan.
- Release-gate run storage retains the five most recent run directories by default.

## Rust decision

Rust is useful for CPU-heavy long-running kernels, but the npm package does not ship a prebuilt native binary: binary packages increase package size and create OS/architecture install failure modes. The published runtime remains Node.js, and the package includes the minimal Rust helper source and lockfile at `crates/sks-core` for explicit local compilation and parity-checked acceleration. Absence of a local `sks-rs` binary must not be reported as native proof or silently bypass parity validation.

## Database safety resource policy

Sneakoscope Codex v0.3 adds a DB Safety Guard without adding runtime dependencies. It scans hook payloads and CLI commands with bounded string traversal and blocks high-risk database operations before Codex can execute them.

Blocked classes include destructive SQL, direct remote SQL mutation, `supabase db reset`, `supabase db push`, migration history repair/squash, and project/branch destructive commands. The guard is intentionally conservative: when unsure, it blocks or warns rather than allowing a potentially destructive database operation.

## GX visual context policy

Sneakoscope Codex v0.4 replaces model-rendered visual cartridges with deterministic code-rendered context sheets. `vgraph.json` and `beta.json` are the inputs, `render.svg` and `render.html` are reproducible outputs, and `drift.json` records whether the rendered source hash still matches the current graph.

This keeps visual context cheap to regenerate, diffable in normal tooling, and safe to validate during npm packaging without network calls or model access.

GX snapshots include `wiki_coordinates`, and `render.svg` nodes include `data-wiki-rgba` and `data-wiki-coord` attributes. This makes the visual context sheet and LLM Wiki pack share one deterministic coordinate system.
