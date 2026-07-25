# All-Feature Completion

SKS 1.17.0 treats all-feature completion as deep runtime coverage, not command presence. `sks features complete --json` writes `.sneakoscope/reports/all-feature-completion-<version>.json` and checks advertised features against command registry coverage, fixtures, artifact schemas, Evidence Router links, Completion Proof links, Trust Report links, Wrongness mappings, docs, blackbox coverage, mock/real guards, secret redaction, next actions, and recovery paths.

Required release scripts:

- `npm run all-features:completion`
- `npm run all-features:deep-completion`
- `npm run evidence:flagship-coverage`

Features that only expose a static contract must either fail the release gate or carry an explicit `integration_optional`/`not_applicable` reason. Mock fixtures remain useful for hermetic checks, but they cannot be reported as real verified execution.
