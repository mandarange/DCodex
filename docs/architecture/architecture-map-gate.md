# Architecture Map gates

All Architecture Map release checks share one implementation:

```text
node ./dist/scripts/architecture-map-check.js --mode <mode>
```

| Gate | Preset | What it proves |
| --- | --- | --- |
| `architecture-map:contract` | release | Policy SSOT, schema files, Align output list parity, patch forbid-list, no Mermaid runtime import in production map sources |
| `architecture-map:legacy-closure` | release | Provisional atlas SSOT, `atlas-check.ts`, and `atlas:*` gate ids stay gone (depends on `architecture-map:contract`) |
| `architecture-map:quality` | confidence | Global views generate, grammar/header hold, no absolute-path leaks, deterministic hash runs |
| `architecture-map:performance` | confidence | Small-fixture cold/warm latency and byte budgets from architecture-map policy |
| `architecture-map:regression-fixtures` | confidence | Focused serializer / projection unit suites |
| `architecture-map:freshness` | confidence | Published map `graphHash` matches current context-graph snapshot hash; stale fails with `sks align run` |

Release-preset gates (`architecture-map:contract`,
`architecture-map:legacy-closure`) are part of the release gate contract.
Confidence-preset gates are not required for publish and are not listed in
`RELEASE_GATE_CONTRACT_IDS`.

## Modes

```bash
node ./dist/scripts/architecture-map-check.js --mode contract
node ./dist/scripts/architecture-map-check.js --mode quality
node ./dist/scripts/architecture-map-check.js --mode performance
node ./dist/scripts/architecture-map-check.js --mode regression-fixtures
node ./dist/scripts/architecture-map-check.js --mode legacy-closure
node ./dist/scripts/architecture-map-check.js --mode freshness
```
