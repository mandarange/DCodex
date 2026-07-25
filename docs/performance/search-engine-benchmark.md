# Search Engine Benchmark

Generated: 2026-07-25T07:52:17.517Z
Root: /Users/weklem/Desktop/devs/Sneakoscope-Codex

| ID | Scenario | OK | Provider | p50ms | p95ms | Spawns | Matches |
|----|----------|----|----------|-------|-------|--------|---------|
| 1 | files_cold | true | sks-rs/ignore | 36.3 | 36.3 | 1 | 3284 |
| 2 | files_warm | true | sks-rs/ignore | 34.1 | 37.3 | 1 | 3284 |
| 3 | text_simple | true | sks-rs/grep-searcher | 66.1 | 74.9 | 1 | 11 |
| 4 | text_unicode_korean | true | sks-rs/grep-searcher | 30.1 | 31.9 | 1 | 50 |
| 5 | text_case_insensitive | true | sks-rs/grep-searcher | 30.1 | 32.4 | 1 | 10 |
| 6 | text_bounded_bytes | true | sks-rs/grep-searcher | 26.2 | 26.2 | 1 | 5 |
| 7 | files_ignore_node_modules | true | sks-rs/ignore | 31.3 | 31.3 | 1 | 0 |
| 8 | structure_function_declaration | true | typescript-ast/typescript-compiler-api | 42.8 | 167.3 | 1 | 1 |
| 9 | structure_unsupported_language | true | typescript-ast/typescript-compiler-api | 0.1 | 0.1 | 0 | 0 |
| 10 | symbol_confidence | true | mixed/typescript-ast+text | 185.2 | 185.2 | 2 | 88 |
| 11 | context_triwiki | true | triwiki/triwiki+codepack+local-search | 507.9 | 507.9 | 2 | 19 |
| 12 | batch_20_text | true | sks-rs/batch | 25.6 | 25.6 | 1 | 200 |
| 13 | rg_cli_compare | true | external/rg-cli | 37.5 | 37.5 | 1 | 11 |
| 14 | files_skip_dot_git_objects | true | sks-rs/ignore | 38.1 | 38.1 | 1 | 0 |
| 15 | context_token_budget | true | triwiki/triwiki+codepack+local-search | 171.0 | 171.0 | 2 | 10 |

## Summary

- OK: 15/15
- Total process spawns across scenarios: 17
- Batch-20 process spawns: 1
- RSS bytes: 191086592
- JS fallback is valid when sks-rs is not built.
- rg CLI comparison is optional and not a core dependency.
- Structure never falls back silently to text.
