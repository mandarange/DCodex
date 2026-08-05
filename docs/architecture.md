# Architecture

## Desktop Bridge routing (8.1.3)

The only SKS-managed Desktop/CLI routing runtime is the local **Desktop
Bridge**. It separates five concerns that older designs coupled together:

```text
Codex identity (OAuth) ── preserved by Codex
                                 │
Codex Desktop / CLI ── loopback Desktop Bridge
                                 │
        ┌────────────────────────┴────────────────────────┐
        │                                                 │
Codex-LB profile                                  OpenRouter profile
credential + endpoint + catalog                    credential + endpoint + catalog
        │                                                 │
        └──────── combined catalog + explicit route index ┘
                                      │
                         provider/model session pin
```

The bridge does not infer a provider from a model spelling or the current
profile. It resolves a canonical public model through the route index, checks
that provider's enabled/readiness state, applies that provider's header
policy, and sends the request. Missing or conflicting mappings are explicit
errors; fallback is always `none`.

Codex-LB and OpenRouter profiles may coexist. ChatGPT OAuth remains in the
Codex identity plane and is removed from provider-bound upstream requests.
Provider secrets are not stored in route policy, catalog, receipts, status, or
logs. The retired command family is not a bridge façade: `sks codex-lb` is
unknown, with no compatibility alias.

## Status and capability contracts

`sks.desktop-bridge-status.v3` presents management/service state, provider
profile states, routing/session-pin state, combined-catalog state, the latest
HTTP/WebSocket probe results, and readiness. The management runtime is either
`desktop-bridge` or unmanaged/native; there are no active legacy modes.

`sks.desktop-capabilities.v3` keeps results scoped to `bridge`,
`native-identity`, each provider, or the combined catalog. Every probe records
its requested level, stage, state, one terminal root cause, recovery action,
and evidence source. Transport verification does not claim deep feature
evidence. Deep rows that were not run are `not_attempted`, and an inactive
provider failure does not independently block an active route.

WebSocket probes are staged: TCP connect, upgrade, protocol, frame round trip,
and clean close. A failure produces the first applicable terminal cause only;
the bridge does not add a duplicate generic transport failure.

## Catalog and migration boundaries

Provider catalogs are normalized into a combined catalog and explicit route
index, written as one atomic generation. A failed build keeps the earlier
verified generation active. A catalog-sync object is mandatory in a v3 report;
missing data is a schema error, not an unreported normal state.

Migration reads historical SKS-owned routing markers only in its private
migration path. It never installs a legacy runtime directory or reactivates a
historical mode. User-owned or ambiguous configuration fails closed. Receipt
backups and guarded rollback restore configuration/bridge metadata without
overwriting newer OAuth state or credentials.

## Naruto capacity boundary

Naruto preserves an operator's persisted configuration even when it requests
more capacity than SKS can execute. At runtime, a persisted preference of
1000 is normalized to 256 child threads and 257 total threads (children plus
parent) and reported as a warning; it is not rewritten. Explicit
`--agents`/`--max-threads` values above 256 are rejected. The 256 ceiling is a
hard frame cap, not a claim that a host ran 256 agents concurrently.

## Architecture gates

Architecture checks fail release verification when module boundaries,
ownership, generated/runtime parity, or the current command surface drift.
They must inspect the actual source and callers. A fixture or a static diagram
does not prove live bridge, credential, Desktop, or deep-feature behavior.

The machine-readable budget SSOT is
[`config/architecture-budgets.v1.json`](../config/architecture-budgets.v1.json).
Its current line ceilings are `250` for the Menu Bar AppDelegate, `450` for
Menu Bar TypeScript, `500` for Menu Bar Swift, `900` for command modules,
`1200` for pipeline/trust/evidence/proof modules, and `1800` for other
handwritten source. Files at `3000` lines require split review. Run
`npm run architecture:check -- --strict-all` to apply the full repository
policy; `--strict-all` is the explicit full-surface flag. Waivers are
**shrink-only**: an already oversized file may not grow,
and a refactor must reduce or split it instead of raising its ceiling.
