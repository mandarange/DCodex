# Feature Fixtures

`sks all-features selftest --mock --execute-fixtures --strict-artifacts --json` promotes the feature registry from metadata-only coverage into release-gated mock/static fixture validation. The canonical release wrapper is `npm run feature-quality:check`; no separate fixture alias is required.

The fixture gate checks:

- every feature has a fixture contract;
- mock/static fixtures have commands;
- deterministic safe allowlist commands execute successfully;
- expected artifacts are declared as arrays;
- every feature has an explicit fixture; unknown features return `missing` instead of implicit static pass;
- fixture quality is recorded as `runtime_verified`, `runtime_mock_verified`, `integration_optional`, `static_contract`, or `missing`;
- runtime route features cannot be `static_contract`;
- runtime fixtures default to `hermetic_temp_project` roots unless explicitly marked `source_checkout_required`;
- expected artifacts are resolved from the mission id emitted by the command output, not from placeholder materialization;
- fixture pass count is at least 90;
- `not_required` count is at most 16;
- mock fixture blocked count is zero;
- expected artifacts exist where the command generated them and expose declared schemas or route gate pass fields.
- `cli-naruto` executes `sks naruto run "fixture" --agents 4 --max-threads 4 --json` and validates the official-subagent preparation contract: `subagent-plan.json`, `subagent-events.jsonl`, `subagent-evidence.json`, `naruto-summary.json`, `naruto-gate.json`, and `work-order-ledger.json`.
- preparation fixtures prove argument parsing, bounded role selection, mission creation, and artifact shape. They do not claim that official child threads completed.
- completion fixtures require correlated official lifecycle events plus a trustworthy `subagent-parent-summary.json` with one outcome for every requested thread.

External dependency routes remain honest: a mock fixture can pass while the real dependency path remains `blocked`, `not_verified`, or `verified_partial` until real evidence exists.

## Quality Boundary

- `runtime_verified`: actual command executed and generated artifacts validated.
- `runtime_mock_verified`: mock route command executed and generated artifacts validated.
- `integration_optional`: real dependency may be absent, but a blocker is recorded.
- `static_contract`: docs/skill/manifest-only; no runtime behavior claim.
- `missing`: invalid release state.

`npm run feature-quality:check` fails when runtime route features are static-only or when quality counts are missing from the registry.

## Release Quality Target

The TypeScript-built registry and the current `feature-quality:check` report are
the source of truth for thresholds and observed counts. A stable release
requires `missing = 0`, zero blocked deterministic mock fixtures, and no
runtime-capable command or route represented as a documentation-only static
contract. Do not copy an older release's count snapshot into current readiness
evidence.

<!-- sks-release-version: 8.4.0 Architecture Map (AMG/ADR) -->
