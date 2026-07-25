# Search Engine Target Architecture

Companion to `search-engine-current-state.md`.

## Separation of modes

| Mode | Engine | Packaging |
|------|--------|-----------|
| files | Rust `ignore` (`sks-rs search files`) + JS/`git ls-files` fallback | Optional Rust; npm install never requires cargo |
| text | Rust grep crates (`sks-rs search text\|batch`) + JS regex scanner | Same |
| structure | TypeScript compiler API | Always available for TS/JS; capability errors otherwise |
| symbol | TypeScript LanguageService for `exact_definition` / `exact_reference`; syntactic + `text_candidate` supplements | Text never promoted to `exact_*`; non-TS/JS → capability error |
| context | TriWiki + Wiki Code Pack + local search metadata | No vector DB |

Super Search remains web/source intelligence and is not merged into this provider.

## IPC contract

- JSON request on stdin, JSON/JSONL machine response on stdout
- stderr for diagnostics
- Exit `0` ok, `1` runtime failure, `2` invalid input / unknown mode

## Cache policy

Keys include: root, HEAD, dirty fingerprint, query, mode, include/exclude, language, engine+schema version.  
Allowed caches: dir snapshot, compiled ignore, compiled AST patterns, file hash, symbol extract, TriWiki codepack, repeated-search candidate sets. Invalidate on dirty/unknown git state.

## Process spawn policy

- Hot path: at most one `sks-rs` process for files/text/batch (or zero when using JS)
- `rg` / `ast-grep` / `fd` are not core runtime dependencies
- Optional `ast-grep` for mistake-rule detectors remains optional; absence is an explicit capability skip
