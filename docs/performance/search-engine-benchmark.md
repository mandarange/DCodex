# Search Engine Benchmark

Generated: 2026-07-25T08:22:16.071Z
Root: /Users/weklem/Desktop/devs/Sneakoscope-Codex

| ID | Scenario | OK | Provider | p50ms | p95ms | Spawns | Matches |
|----|----------|----|----------|-------|-------|--------|---------|
| 1 | files_cold | true | sks-rs/ignore | 37.4 | 37.4 | 1 | 3285 |
| 2 | files_warm | true | sks-rs/ignore | 34.3 | 35.4 | 1 | 3285 |
| 3 | text_simple | true | sks-rs/grep-searcher | 72.0 | 73.8 | 1 | 11 |
| 4 | text_unicode_korean | true | sks-rs/grep-searcher | 29.5 | 29.9 | 1 | 50 |
| 5 | text_case_insensitive | true | sks-rs/grep-searcher | 34.4 | 35.6 | 1 | 10 |
| 6 | text_bounded_bytes | true | sks-rs/grep-searcher | 24.0 | 24.0 | 1 | 5 |
| 7 | files_ignore_node_modules | true | sks-rs/ignore | 31.0 | 31.0 | 1 | 0 |
| 8 | structure_function_declaration | true | typescript-ast/typescript-compiler-api | 48.5 | 172.6 | 1 | 1 |
| 9 | structure_unsupported_language | true | typescript-ast/typescript-compiler-api | 0.1 | 0.1 | 0 | 0 |
| 10 | symbol_confidence | true | mixed/typescript-ast+text | 192.4 | 192.4 | 2 | 88 |
| 11 | context_triwiki | true | triwiki/triwiki+codepack+local-search | 598.6 | 598.6 | 2 | 20 |
| 12 | batch_20_text | true | sks-rs/batch | 23.3 | 23.3 | 1 | 200 |
| 13 | rg_cli_compare | true | external/rg-cli | 37.4 | 37.4 | 1 | 11 |
| 14 | files_skip_dot_git_objects | true | sks-rs/ignore | 34.4 | 34.4 | 1 | 0 |
| 15 | context_token_budget | true | triwiki/triwiki+codepack+local-search | 157.0 | 157.0 | 2 | 10 |

## Summary

- OK: 15/15
- Total process spawns across scenarios: 17
- Batch-20 process spawns: 1
- RSS bytes: 191774720
- JS fallback is valid when sks-rs is not built.
- rg CLI comparison is optional and not a core dependency.
- Structure never falls back silently to text.
