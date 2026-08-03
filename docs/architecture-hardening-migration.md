# Architecture-hardening migration

This migration replaces legacy external custom-provider injection and mixed
catalog/session metadata with the native `openai` loopback architecture. It is
explicit and provenance-preserving; inspection alone never writes.

## Status vocabulary

- `policy`: the accepted native identity, exclusive modes, immutable pins, and
  no-fallback invariants.
- `implemented`: source exists and is connected to the bridge/CLI/Center choke
  points.
- `contract-tested`: unit, generated Swift, or hermetic mock evidence passed.
- `live-verified`: an approved real provider or signed app was exercised.

Current migration code is implemented and contract-tested. No user Codex
configuration was migrated and no live provider was used in this worktree.

## What is superseded

New Desktop setup must not inject `sks-router`, `openrouter`, or `codex-lb` as
an unsealed external transport identity. Those tables and command aliases may
remain readable so the migrator can identify ownership and prepare rollback,
but they are superseded by built-in `openai` plus a loopback endpoint. Legacy
CLI-only consumers remain a compatibility lane and are not silently rewritten.

## Inspect, plan, apply

[`migration.ts`](../src/core/architecture-hardening/migration/migration.ts)
implements three boundaries:

1. Inspect the exact configuration text and session metadata. Classify custom
   provider injection, mixed catalogs, missing session pins, obsolete aliases,
   unsupported options, and unmarked user edits.
2. Produce a plan with fixed reason codes, target mode, removable-path proof,
   and ambiguity blockers. Ambiguous ownership returns `migration_required`;
   it is never guessed.
3. Apply only with explicit authorization and confirmed removable paths. The
   writer creates a mode-preserving backup receipt, uses guarded atomic replace,
   re-reads the result, and rolls back on failure. It does not store secret
   values in the receipt.

Unmarked user edits and referenced provider tables are retained. Missing
session metadata is not fabricated: the old session stays blocked for explicit
migration while new sessions use a freshly sealed pin.

## Runtime transition

The desired four-stage result is:

1. configuration saved;
2. proxy applied;
3. native catalog refreshed;
4. new session ready.

A failed stage leaves last-known-good unchanged. Existing sessions keep their
original mode/model/child snapshot. The operator may discard only the draft or
restore the recorded pre-apply configuration; a migration failure never
deletes an older credential or graph snapshot automatically.

Current Codex Desktop does not yet send the sealed session and parent snapshot
headers needed for strict per-request pin enforcement. The compatibility bridge
therefore leaves `require_session_pin` off unless the caller supplies that
verified protocol. Do not enable it by deriving identity from model names or
ambient account state.

## Verification and rollback

Run the focused contracts and hermetic matrix after migration changes:

```bash
npm run typecheck --silent
npm run build:incremental --silent
node --test dist/core/architecture-hardening/__tests__/integration.test.js
node --test test/e2e/architecture-hardening/hermetic-sandbox.test.mjs
```

Production claims additionally need the real LB probe and signed menu-bar QA
described in [Hermetic E2E Testing](testing-hermetic-e2e.md). If those inputs
are absent, record `not_verified`; do not read the user's saved credentials or
promote a mock pass.
