# Gate Policy

Release gates protect user-visible trust concerns, not harness implementation details.

## Budget

- The `release` preset in `release-gates.v2.json` must stay at or below 200 gates.
- Total release-manifest gates should stay in the 150-200 range.
- Harness infrastructure gates live in `infra-harness-gates.json` with the `harness` preset.
- `package.json` scripts are user entry points only and must stay at or below 100. Gate commands execute the manifest command directly.

## Addition Rule

Add at most one gate for one distinct user concern. A new gate needs a short justification covering:

- the user concern it protects;
- why an existing comprehensive gate does not cover it;
- expected runtime and side effects;
- the command and artifact that prove the concern.

Variants that re-read the same artifact fields, rerun the same QA ledger checks, or test terminal harness rendering must be folded into a comprehensive gate or moved to the `harness` preset.

## Release Checklist

Every release update touching `package.json`, `release-gates.v2.json`, `infra-harness-gates.json`, or `src/scripts/**` must include a gate audit:

- release preset count is at or below 200;
- npm script count is at or below 100;
- repeated route families are represented by comprehensive gates.
- split-review target files from the 2026-07-02 cleanup (`research.ts`, `ppt.ts`, `init.ts`, `hooks-runtime.ts`, `recallpulse.ts`) remain at or below 1200 lines.
