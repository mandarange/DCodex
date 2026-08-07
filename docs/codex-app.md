# Codex App and Desktop Bridge

## Current routing model

In 8.1.3, SKS manages one local **Desktop Bridge** for Codex Desktop and CLI
routing. ChatGPT OAuth remains in Codex's identity plane. Codex-LB and
OpenRouter are simultaneous bridge provider profiles, each with its own
credential, endpoint policy, catalog state, and capability scope.

The app does not offer competing provider modes, a general “turn bridge off”
selector, or a direct provider-activation action. The removed `sks codex-lb`
surface is unknown, with no alias. Configure profiles through `sks bridge`.

```sh
sks bridge ensure --json
sks bridge provider configure codex-lb --host <host> --api-key-stdin --json
sks bridge provider configure openrouter --api-key-stdin --json
sks bridge catalog sync --json
sks bridge status --json
```

## What the Providers page shows

The native Providers view is organized around five independently truthful
cards:

1. **Desktop Bridge** — runtime/service state, loopback endpoint, HTTP probe,
   WebSocket upgrade/protocol/frame evidence, last verification, repair, and
   shallow/transport/deep verification actions.
2. **Provider Credentials** — one row each for Codex-LB and OpenRouter. Both
   may be ready at once. Each row shows configuration, redacted endpoint and
   credential metadata, catalog state, and provider-specific actions.
3. **Combined Model Catalog** — state, generation, model/provider counts,
   conflicts, and a refresh/report action.
4. **Routes** — default provider, selected-model route, session pin, and the
   explicit no-fallback policy.
5. **Capability Matrix** — scope, state, stage, root cause, evidence time,
   and allowed recovery action for each row.

`catalog_sync` is mandatory in a valid v3 report. If it is missing, the app
renders a schema error rather than treating “state not reported” as normal.

## Verification truth

The app uses non-strict `sks bridge verify` calls. A report can be generated
while readiness remains incomplete; the UI makes that distinction visible.
Deep-only rows that have not been probed are shown as `not_attempted`, not as a
global failure. A failure for an inactive provider is a warning for that
provider, not a reason to mark a usable active route unavailable.

WebSocket evidence is staged. HTTP health does not prove WebSocket upgrade;
upgrade does not prove a protocol or frame round trip. A single failed probe
path has one terminal root cause rather than a duplicate generic transport
blocker. A newer `correlation_id` wins over an older verification callback, so
a stale result cannot overwrite current UI state.

## Security and ownership

- Incoming ChatGPT OAuth authorization is removed before Codex-LB or
  OpenRouter forwarding.
- Provider secrets are accepted through stdin and are redacted in app/CLI
  state, errors, receipts, catalogs, and route indexes.
- Profile changes are provider-scoped; selecting or disabling one profile does
  not remove the other profile's credential.
- SKS only migrates configuration it can prove it authored. Ambiguous or
  user-owned settings fail closed with a recovery action.
- Emergency removal is explicit: `sks bridge unmanage --confirm --json`.
  Receipt-based rollback is explicit: `sks bridge rollback <receipt-id>
  --confirm --json`.

## Evidence boundary

The desktop UI can display a real report only after the local service and
target provider have been exercised. A built app, fixture, or static catalog
does not prove a live credential, a Desktop restart, a WebSocket frame round
trip, or a deep feature artifact. Those are release evidence items and remain
`not-run-real` until collected.

## Current Codex compatibility anchors

The exact SDK dependency in `package.json` selects the tested Codex graph, and
the resolved runtime generates the current App Server v2 contract before SKS interprets Desktop state. Browser
evidence depends on the Codex Chrome Extension, and image generation targets
`gpt-image-2` through the managed Desktop Bridge route. Those identifiers are
compatibility inputs only: their presence in source or configuration is not
live Desktop, browser, or image evidence.
