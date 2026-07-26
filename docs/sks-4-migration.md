# SKS 4.0.0 Migration

SKS 4.0.0 is a destructive verification-pipeline release. The default foreground path is affected-scope, release-equivalent proof backed by TriWiki proof cards, gate packs, resource budgets, and SLA certificates.

## Operational Changes

- Use `sks check --tier confidence --sla 5m` for normal foreground verification.
- Use `sks task run --sla 5m` for task-shaped affected verification.
- Use `sks release affected` for release-equivalent changed-scope proof.
- Use `sks release full` for the full foreground release graph.
- Use `sks check --tier real-check` only for explicit real environment, app, browser, network, OAuth, or registry verification.
- Use `sks triwiki index`, `sks triwiki affected`, and `sks proof bank status` to inspect the new proof bank surface.

## Removed Runtime Migration

Removed runtime migration is explicit. Retired runtimes and command names are absent from the public command surface and resolve as unknown input. SKS does not silently route removed runtimes, old compatibility aliases, or legacy fallback command names to replacement behavior.

## No Silent Legacy Fallback

No silent legacy fallback is allowed. Users must call the canonical command names (`sks naruto`, `sks computer-use`, `sks image-ux-review`, `sks dollar-commands`, `sks gc`, and related first-class commands) rather than relying on compatibility aliases.

Structured legacy exceptions are removed;
release selection no longer permits those compatibility gates through an expired
allowlist.

## Release Proof

The 4.0.0 release graph requires:

- TriWiki proof cards and proof bank reuse checks.
- Affected graph and gate impact map checks.
- Gate-pack manifest and runner checks.
- Extreme parallel scheduler and five-minute SLA checks.
- Build-once, probe memoization, and `sksd` cache-warming checks.
- Doctor dirty repair and transaction skip checks.
- Legacy gate inventory, legacy purge, orphan detection, and all-feature regression checks.
