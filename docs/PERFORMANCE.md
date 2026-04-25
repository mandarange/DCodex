# Sneakoscope Codex performance and leak policy

Sneakoscope Codex v0.4 is designed to keep runtime, package size, RAM, and storage bounded.

## Speed

- `codex exec` output is streamed to files and only a bounded tail is retained in memory.
- Ralph cycles run under a timeout and bounded max cycles.
- TriWiki claim selection uses bounded top-K selection instead of sorting unbounded context into prompts.
- GX visual context renders deterministic SVG/HTML from JSON sources, avoiding external image-generation latency, cost, and nondeterminism.
- `sks gc` runs after Ralph cycles by default.

## Package size

- The npm package has zero runtime dependencies.
- `@openai/codex` is no longer bundled. Users install Codex separately or set `SKS_CODEX_BIN`.
- Optional Rust source is in `crates/` for the Git repo, but is excluded from the npm package by the `files` allowlist.
- GX rendering uses only built-in Node.js APIs and ships as source in the npm package.
- `npm run sizecheck` enforces package limits before pack/publish: `<=96 KiB` packed, `<=320 KiB` unpacked, `<=40` package files, and `<=256 KiB` per tracked file by default.

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
