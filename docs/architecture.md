# Architecture

The active architecture keeps user-facing commands lazy-loaded through `src/cli/command-registry.ts` and keeps `src/core/pipeline.ts` as the single compatibility facade.

Core trust modules:

- `src/core/trust-kernel/`
- `src/core/evidence/`
- `src/core/managed-paths.ts`
- `src/core/bench.ts`

Release architecture gates:

```bash
npm run architecture:check
npm run route-modularity:check
npm run command-budget:check
npm run pipeline-budget:check
npm run pipeline-runtime:check
```

`config/architecture-budgets.v1.json` is the single source of truth for architecture line budgets. `architecture:check` computes committed changes from `git merge-base HEAD <base-ref>` (preferring `origin/main`) and also includes staged, unstaged, and untracked files. This keeps a clean feature checkout observable instead of relying on `git diff HEAD`. Use `--base-ref <ref>` to seal a comparison target and `--strict-all` for release-wide enforcement.

Hard thresholds in the budget SSOT:

- Menu Bar TypeScript modules: `450` lines.
- Menu Bar AppDelegate: `250` lines.
- Other Menu Bar Swift modules: `500` lines.
- Command modules: `900` lines.
- Pipeline, trust-kernel, evidence, and proof modules: `1200` lines.
- Other handwritten source: `1800` lines.
- Any handwritten file at `3000` lines enters the split-review gate.

Every over-budget waiver is `shrink-only`: it records the merge-base line ceiling, cannot be used for a new file, and fails as soon as the file grows. A waiver never raises the shared budget. Waivers carry no expiry version — an expiry pinned to one release is either unenforced or a cliff, whereas shrink-only ratchets on every change.
# Architecture Gates

Architecture warnings are release failures.

Hard thresholds are read from the budget SSOT:

- any handwritten file above `1800` lines fails;
- core pipeline/trust-kernel/evidence/proof files above `1200` lines fail;
- command modules above `900` lines fail;
- files that directly import five or more unrelated route domains fail unless they are explicit route-domain aggregators.

The pipeline runtime compatibility surface stays split: `src/core/pipeline-internals/runtime-core.ts` remains under the 1200-line pipeline gate, while stop/gate evaluation lives in `src/core/pipeline-internals/runtime-gates.ts`.

## OpenRouter Desktop Provider

OpenRouter for Codex Desktop is centered on key save + explicit model activation (not a separate GLM MAD CLI):

- `src/core/providers/openrouter/openrouter-secret-store.ts` owns the user-scoped OpenRouter key lifecycle outside project files.
- `src/core/providers/openrouter/openrouter-client.ts` is the only OpenRouter network adapter.
- `src/core/codex-app/openrouter-activate.ts` selects `model_provider = "openrouter"` and the chosen model via `sks codex-app use-openrouter --model` (and SKS Center Providers).
- `src/core/codex-app/glm-profile-installer.ts` strips retired Desktop GLM picker profiles and ensures the OpenRouter provider table used by `use-openrouter`.

The former GLM MAD CLI (`sks --mad --glm`, `sks glm`) and `src/core/providers/glm/` runtime were removed; ordinary `sks --mad` is unchanged.

## Codex Desktop Multi-Provider Router

The accepted provider architecture is now defined in
[`docs/architecture/native-openai-exclusive-provider-modes.md`](architecture/native-openai-exclusive-provider-modes.md).
Codex Desktop keeps the built-in `openai` identity and a loopback transport;
SKS enforces one exclusive upstream mode inside the proxy. The custom-provider
`multi-provider-router` path below is legacy migration context, not the target.

`src/core/codex-app/multi-provider-router.ts` is a legacy configuration and verification adapter, not a proxy implementation. It permits a single loopback-only Responses endpoint (default `http://127.0.0.1:10100/v1`), reads an external JSON catalog of `provider/model` slugs, probes the router's `/v1/models` without following redirects or buffering an unbounded response, and writes the selected user-level `$CODEX_HOME/config.toml` provider/model/catalog settings only after the requested model appears in both sources.

The configured provider is `sks-router`, a custom provider table using `wire_api = "responses"` and explicit `requires_openai_auth = false`. Its security contract is deliberately unauthenticated from SKS's point of view: the table must not contain `env_key`, bearer-token values, credential headers, or a provider auth table. Router process lifecycle, upstream provider credentials, provider registration, and upstream policy remain outside SKS. The loopback restriction prevents a remote router URL and rejects URLs with embedded credentials, query strings, or paths other than `/v1`; it does not authenticate the local peer.

The catalog is part of the configuration contract rather than a UI-only picker. It must be an owner-only regular file containing a top-level `models` array whose rows satisfy the current Codex `ModelInfo` core fields; partial rows, symlinks, insecure modes, duplicate slugs, and oversized catalogs fail closed. Configuration refuses an unmarked user catalog replacement unless `--replace-catalog` is explicit, uses compare-before-write guarded commit, and validates the written TOML plus a guarded readback. A successful config write and Desktop restart are reported separately from runtime adoption: the adapter sets `runtime_verified = false` until App Server/model and Responses execution are proven externally.

This design takes catalog and Responses-protocol compatibility from OpenCodex reference commit `9e68ed67303580ecf0bcde0a56b71b874304fc54`, but does not embed OpenCodex or use its documented built-in `openai_base_url` loopback mode as the SKS default. That source uses port `10100` by default and atomically maintains `$CODEX_HOME/opencodex-catalog.json`; SKS's defaults intentionally consume those real outputs rather than inventing a parallel catalog sync. After SKS writes or binds a catalog, it also invalidates `$CODEX_HOME/models_cache.json` by rewriting the Codex wrapper with a stale `fetched_at` (and optional catalog-seeded `models`) so Desktop app-server pickers refresh; raw catalog bytes are never written as the cache file. OpenCodex users must stamp routed role entries with `multi_agent_version = "v2"` so they match Codex multi-agent V2. SKS currently uses the custom `sks-router` provider table so it never has to retain router credentials. When OpenCodex Design B already owns `openai_base_url`, SKS classifies that owner and refuses `use-router` without `--force-routing-override`. Compatibility therefore requires an independently operated router that exposes loopback `/v1/models` and Responses behavior; it is not evidence that every OpenCodex feature or provider works under Codex Desktop.

Role-model preferences in `src/core/subagents/role-model-preferences.ts` are a separate owner-only preference store. Routed preferences are accepted only while `sks-router` is the selected backend and the exact catalog row advertises the requested reasoning effort plus `multi_agent_version = "v2"`; the same binding is revalidated during mission preparation. SKS-managed OpenRouter catalogs also stamp matching role-model slugs into picker priorities `0..4` (Codex advertises at most five `spawn_agent` models). Since `spawn_agent` has no provider parameter, provider routing is resolved by the selected catalog/backend. Spawn-time custom agent, model, or reasoning overrides require bounded rather than full-history forking. Operators accept any OpenCodex cross-provider native multi-agent V2 task-body risk when using routed overrides (including encrypted native `NEW_TASK` bodies that external providers cannot decrypt); this is still not a substitute for a real routed official-subagent round trip.

## Architecture hardening status (2026-08-02)

The normative provider design is the built-in `openai` identity plus an SKS
loopback boundary. The older `sks-router`, `openrouter`, and `codex-lb` custom
provider descriptions above are retained only for compatibility and migration;
they are superseded for new Desktop architecture work.

| Level | Current status |
| --- | --- |
| Policy | Three exclusive modes, immutable session/child snapshots, no provider fallback, four-stage apply, reference-only images, and progress-based recovery are accepted. |
| Implemented | Versioned contracts/state, native transport, proxy enforcement, session/child/catalog policies, Keychain boundary, IntentContract, EvidenceKey v2, graph writer locking, reference evidence, migration, CLI normalization, and safe projection exist in source. |
| Contract-tested | Focused TypeScript, generated Swift harness, and hermetic mock E2E cover the implemented boundaries. Mock results are not live Desktop evidence. |
| Live-verified | Not verified in this worktree: no approved real Codex LB secret was injected and no production-signed menu-bar UI-test bundle was supplied. |

Source-of-truth entry points are
[`contracts.ts`](../src/core/architecture-hardening/contracts/contracts.ts),
[`state-service.ts`](../src/core/architecture-hardening/state/state-service.ts),
[`security.ts`](../src/core/codex-lb/desktop-bridge/security.ts),
[`session-pinning.ts`](../src/core/codex-app/session-policy/session-pinning.ts),
[`intent-contract.ts`](../src/core/safety/intent-contract/intent-contract.ts), and
[`evidence-key.ts`](../src/core/evidence/v2/evidence-key.ts).

One external integration boundary remains deliberate: current Codex Desktop
does not emit the sealed `x-sks-session-*` request metadata expected by strict
proxy pin enforcement. Managed bridge settings therefore default
`require_session_pin` to false for compatibility. Tests exercise the strict
path with explicit headers; enabling it in production requires a verified
native session-affinity protocol, not a guessed fallback.
