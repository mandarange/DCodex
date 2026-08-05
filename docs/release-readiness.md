# 8.1.3 Release Readiness

## Current decision

**BLOCKED — final evidence pending.** The 8.1.3 documentation records the
Desktop Bridge contract and its required checks. It does not assert that a
real macOS service, user credential, Codex Desktop session, WebSocket frame
round trip, or deep feature has passed.

## Product contract checklist

- [ ] One managed runtime: Desktop Bridge for managed Codex Desktop and CLI
  routing.
- [ ] Codex-LB and OpenRouter profiles can coexist without credential loss.
- [ ] Combined catalog and explicit route index are atomically activated.
- [ ] Route fallback is `none`; missing or ambiguous routes are explicit
  blockers.
- [ ] Capability reports use v3 scope/state/stage/level semantics.
- [ ] Transport readiness is independent of unattempted deep verification.
- [ ] A WebSocket probe reports one terminal root cause at its first failed
  stage.
- [ ] User-owned/ambiguous configuration fails closed.
- [ ] Migration is receipt-backed and idempotent; rollback restores metadata
  without overwriting newer OAuth or credentials.
- [ ] The removed `sks codex-lb` command is unknown and has no alias.
- [ ] Naruto normalizes a persisted preference of 1000 to an effective maximum
  of 256 child threads / 257 total threads without rewriting that preference;
  explicit `--agents` or `--max-threads` values above 256 are rejected.

## Required checks

Run the final checks from a clean, integrated tree and retain the actual output
or result artifact:

```sh
npm run typecheck
npm run build
node --test dist/cli/__tests__/router-codex-lb-removed.test.js
node --test dist/cli/__tests__/bridge-command-registration.test.js
node --test dist/core/codex-lb/__tests__/desktop-bridge-single-runtime-contract.test.js
node --test dist/core/codex-lb/__tests__/credential-coexistence-contract.test.js
node --test dist/core/codex-lb/__tests__/combined-catalog-conflict.test.js
node --test dist/core/codex-lb/__tests__/desktop-bridge-unification-rollback.test.js
node --test dist/core/subagents/__tests__/official-subagent-config.test.js
npm run release:version-truth
```

The final runner may add focused v3 capability, transport, route, native UI,
and secret-redaction tests. Test selection must follow the final source paths,
not an old release plan.

## Real-environment acceptance

The following must be marked `not-run-real` until actually exercised with
redacted evidence. They cannot be inferred from the required checks above:

| Item | Required proof |
| --- | --- |
| macOS bridge lifecycle | install/start/restart/repair plus process read-back |
| Codex Desktop | restart and current Providers UI state |
| OAuth | before/after semantic and byte-preservation evidence |
| Codex-LB | live authenticated catalog and bounded text route |
| OpenRouter | live authenticated catalog and bounded text route |
| coexistence | both configured credentials remain intact through operations |
| WebSocket | live stage-aware upgrade/protocol/frame/close evidence |
| deep capabilities | per-feature, provider-bound artifact/evidence |

## Documentation and package closure

- [ ] Package, lockfile, runtime/Rust metadata, README, and changelog all name
  8.1.3.
- [ ] CHANGELOG contains exactly one 8.1.3 section.
- [ ] Public docs advertise only `sks bridge` for bridge operations.
- [ ] Public docs contain no direct provider-activation or direct routing-config
  writer instructions.
- [ ] The implementation report maps R01–R50 and S01–S22 with an honest
  evidence status.
- [ ] Release proof declares missing real evidence instead of converting it
  into a pass.
