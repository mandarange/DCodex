# Sneakoscope Codex performance and leak policy

Sneakoscope Codex v0.6 is designed to keep runtime, package size, RAM, and storage bounded.

## Speed

- `codex exec` output is streamed to files and only a bounded tail is retained in memory.
- Ralph cycles run under a timeout and bounded max cycles.
- TriWiki claim selection uses bounded top-K selection plus the latest RGBA/trig wiki anchors and required voxel overlay metadata instead of sorting unbounded context into prompts.
- GX visual context renders deterministic SVG/HTML from JSON sources, avoiding external image-generation latency, cost, and nondeterminism. Rendered nodes expose the same RGBA wiki-coordinate anchors used by TriWiki.
- `sks gc` runs after Ralph cycles by default.

## Evaluation metrics

`sks eval run` creates a deterministic JSON report in `.sneakoscope/reports/` unless `--no-save` is used. The built-in scenario compares an uncompressed all-claims baseline with a TriWiki compressed context capsule.

Tracked metrics:

- `estimated_tokens`: deterministic chars/4 prompt-size estimate for local regression tracking
- `token_savings_pct`: prompt-size reduction versus baseline
- `accuracy_proxy`: evidence-weighted context-selection quality score
- `required_recall`: required claim coverage
- `relevance_precision`: selected required claims divided by selected claims
- `support_ratio`: selected claims that are supported or weakly supported
- `unsupported_critical_selected`: critical/high unsupported claims that survived compression
- `context_build_ms_per_run`: local context construction runtime
- `meaningful_improvement`: true only when token savings, accuracy delta, recall, unsupported-critical filtering, and runtime thresholds pass

Default meaningful-improvement thresholds are intentionally explicit: at least 10% token savings with the required voxel overlay included, at least +0.03 accuracy-proxy delta, at least 0.95 required recall, zero unsupported critical claims selected, and candidate context construction under 25 ms per run. `sks eval compare --baseline old.json --candidate new.json` compares saved reports across implementations.

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

- The npm package has zero runtime dependencies.
- `@openai/codex` is no longer bundled. Users install Codex separately or set `SKS_CODEX_BIN`.
- Optional Rust source is in `crates/` for the Git repo, but is excluded from the npm package by the `files` allowlist.
- GX rendering uses only built-in Node.js APIs and ships as source in the npm package.
- `npm run sizecheck` enforces package limits during `release:check`, `publish:dry`, and publish: `<=96 KiB` packed, `<=320 KiB` unpacked, `<=40` package files, and `<=256 KiB` per tracked file by default.

## Memory leaks

- Child process stdout/stderr never accumulate unbounded strings.
- Large outputs are written to log files and returned as tails.
- Recursive file walking has file/depth caps.
- No long-lived global caches are used.

## Storage leaks

- `.sneakoscope/policy.json` controls retention.
- Old missions, old Ralph cycle directories, arenas, temp files, and oversized JSONL logs are removed or rotated by `sks gc`.
- `sks stats` reports package/state size.

## Rust decision

Rust is useful for CPU-heavy long-running kernels, but not for the default npm package yet: native binaries increase package size and create OS/architecture install failure modes. Sneakoscope Codex therefore ships a zero-dependency Node runtime by default and includes an optional zero-dependency Rust helper source at `crates/sks-core` for future builds or users who want to compile locally.

## Database safety resource policy

Sneakoscope Codex v0.3 adds a DB Safety Guard without adding runtime dependencies. It scans hook payloads and CLI commands with bounded string traversal and blocks high-risk database operations before Codex can execute them.

Blocked classes include destructive SQL, direct remote SQL mutation, `supabase db reset`, `supabase db push`, migration history repair/squash, and project/branch destructive commands. The guard is intentionally conservative: when unsure, it blocks or warns rather than allowing a potentially destructive database operation.

## GX visual context policy

Sneakoscope Codex v0.4 replaces model-rendered visual cartridges with deterministic code-rendered context sheets. `vgraph.json` and `beta.json` are the inputs, `render.svg` and `render.html` are reproducible outputs, and `drift.json` records whether the rendered source hash still matches the current graph.

This keeps visual context cheap to regenerate, diffable in normal tooling, and safe to validate during npm packaging without network calls or model access.

GX snapshots include `wiki_coordinates`, and `render.svg` nodes include `data-wiki-rgba` and `data-wiki-coord` attributes. This makes the visual context sheet and LLM Wiki pack share one deterministic coordinate system.
