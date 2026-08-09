# Mermaid Architecture Atlas

The Architecture Map is a TriWiki projection that turns the compiled context
graph into layer-bounded Mermaid views. Policy for layers, allow-list edges,
budgets, and blocking codes lives in `config/architecture-map-policy.v1.json`.
Projection and analysis live under
`src/core/triwiki/context-graph/architecture/` and
`src/core/triwiki/context-graph/projections/mermaid/`. Align publishes the
global cache to `.sneakoscope/wiki/architecture-map/`.

The map is a derived view, never repository truth. Context graph snapshots,
source modules, and the architecture-map policy file remain authoritative.

## Non-negotiables

1. **Policy is SSOT.** Layer membership and edge rules come only from
   `config/architecture-map-policy.v1.json`.
2. **No Mermaid runtime in production paths.** Compatibility and parser suites
   may use the `mermaid` **devDependency**; production Architecture Map sources
   must not import the package.
3. **Provisional atlas SSOT stays closed.** Retired
   `src/core/triwiki/atlas/**`, `atlas-check.ts`, and `atlas:*` gate ids must not
   reappear.
4. **One check implementation.** All gate ids share
   `src/scripts/architecture-map-check.ts`, selected by `--mode`.

## Global views

Align publishes these Mermaid views under
`.sneakoscope/wiki/architecture-map/views/`:

- `project-topology`
- `module-dependency`
- `public-surface`
- `ssot-provenance`
- `runtime-control`
- `verification-coverage`
- `risk-domains`

## CLI (read-only)

```text
sks triwiki atlas-status [--mission <id>] [--json]
sks triwiki atlas-lint [--mission <id>] [--json]
sks triwiki atlas-list [--mission <id>] [--json]
sks triwiki atlas-show <view-id> [--mission <id>] [--format mermaid|json]
sks triwiki atlas-why <finding-id> --mission <id> [--json]
```

There are no write commands. Global rebuild is `sks align run`.

## Gates

See [architecture-map-gate.md](./architecture-map-gate.md).
