# DFix Evidence Loop

DFix is the bounded direct-fix route for tiny copy, config, docs, labels, spacing, translation, and simple mechanical edits. It remains the Extreme Speed Kernel: fast diagnosis, minimum root-cause scope, safe patch, minimum verification, proof/trust/wrongness, and rollback evidence stay in one direct-fix loop.

The command surface is:

```bash
sks dfix diagnose --json
sks dfix plan --json
sks dfix patch --dry-run --json
sks dfix verify --command "npm run typecheck" --run --json
sks dfix rollback-plan --json
sks dfix status --json
sks dfix fixture --json
```

The 1.14.1 artifact graph includes `dfix-error-signature.json`, `dfix-cache-hit.json` or `dfix-cache-miss.json`, `dfix-path-decision.json`, `dfix-root-cause-ranking.json`, `dfix-patch-template.json`, `dfix-codex-handoff.json`, `dfix-patch-runner-result.json`, `dfix-verification-selection.json`, `dfix-verification-runner.json`, `dfix-performance-report.json`, the legacy DFix gate artifacts, Completion Proof, and Trust Report evidence.

DFix paths:

- L0 deterministic: exact find/replace, simple version drift, missing import/path typo, schema required field, and other high-confidence tiny patches.
- L1 local static: stack path, changed files, package metadata, and targeted source/test inspection within a tight budget.
- L2 bounded Codex patch handoff: dry-run by default, schema-bound, blocked for broad refactors and unsafe operations.
- L3 human review: high-risk files, auth/payment/security, DB/migration, broad ambiguity, or low root-cause confidence.

Patch application requires explicit `--apply`; Codex handoff application requires `--apply-codex-patch` or `--apply`. Verification runs only the selected command first and requires `--run` or `--verify-auto`. Full verification is reserved for `--full-verify` or release paths.
