# Performance Budgets

SKS 1.14.1 records core hot-path budgets with:

```bash
sks bench core --json
```

Artifacts:

- `.sneakoscope/reports/performance/core-bench.json`
- `.sneakoscope/reports/performance/core-bench.md`

## Initial Budgets

| Metric | p95 Budget |
| --- | ---: |
| `sks --version` | 50ms |
| `sks help` | 80ms |
| `sks root --json` | 80ms |
| `sks commands --json` | 120ms |
| `sks proof validate --json` | 250ms |
| `sks trust validate latest --json` | 300ms |
| `sks wiki image-validate --json` | 300ms |
| `sks features check --json` | 1200ms |
| `sks naruto status --json` | 1000ms |

Budget misses are evidence, not marketing copy. README or release notes should only claim a speed win when the benchmark artifact exists and passes on the target environment.
# Tiered Budgets

Performance budgets are tiered by execution environment and stored in `src/core/performance-budgets.json`, which is copied as a non-code asset to `dist/core/performance-budgets.json` during the TypeScript build.

Tiers:

- `source-local`
- `source-ci`
- `packed-local`
- `global-shim`
- `npx-one-shot`

Use `sks bench core --tier source-ci --json` for release CI. `perf:gate` selects `source-ci` when `CI=true`; otherwise it uses the local tier unless `SKS_PERF_TIER` is set.

## 1.14.1 DFix Speed Budgets

DFix writes `dfix-performance-report.json` and release gates check these budgets:

| DFix Metric | Budget |
| --- | ---: |
| cold source-local diagnosis for simple error text | <= 500ms |
| path decision after diagnosis | <= 100ms |
| deterministic patch plan | <= 300ms |
| dry-run Codex handoff without Codex | <= 500ms |
| exact patch apply for a small file | <= 1000ms |
| verification selector | <= 300ms |
| no-Codex full loop fixture | <= 3000ms |
| Codex handoff timeout | <= 60000ms |

These budgets are evidence gates for SKS 1.14.1. They do not authorize skipping root-cause, diff, rollback, or verification evidence.
