# Codex App

SKS uses Codex App as the app-facing control surface for dollar-command skills, managed hooks, image generation, Codex Chrome Extension web verification, and native macOS Computer Use evidence.

## Current Compatibility Baseline

SKS 7.4.0 prefers the OpenAI Codex CLI/App channel `rust-v0.145.0` as the package-tracked latest, with the 0.145.0 SDK/CLI dependency graph, active release manifest, and App Server v2 schemas kept in lockstep for release proof. Runtime policy remains version-agnostic: feature routes capability-gate, and Menu Bar / Center induce updates to preferred latest. Hook output validation uses the vendored OpenAI Codex `latest` generated schemas plus the SKS zero-warning strict subset documented in [codex-cli-compat.md](codex-cli-compat.md). Codex 0.134-0.139 notes remain inherited historical compatibility evidence; they are not an exclusive product lock.

## Chat, Pro Models, And Fast UI Preservation

SKS repairs native Desktop selection when an SKS-owned global
`model_provider`, `model`, or `model_reasoning_effort` lock suppresses the Chat
entry, Pro model access, or Fast picker. The repair is provenance-scoped: it
does not delete unmarked user settings, provider definitions, provider URLs,
credential references, `service_tier = "fast"`, or `[features].fast_mode`.

SKS reports the active nonsecret auth class, but codex-lb routing is not an auth
mode. Codex Desktop keeps the real ChatGPT OAuth identity and built-in OpenAI
provider in **Desktop Full Capability** mode. The local loopback bridge adds the
separate codex-lb gateway credential only on the outbound gateway hop. Setup,
repair, update, enable, and disable operations do not write `auth.json`.
The selected codex-lb authentication or routing mode is not a feature flag:
the native model picker, Fast, image generation, Browser Use, Computer Use,
voice, plugins/apps, and other Codex App surfaces remain App-owned and are not
disabled by SKS. A blocked codex-lb capability row describes missing evidence
for that data path, not removal of the native feature.

The separately stored CLI provider uses `name = "codex-lb"`,
`env_key = "CODEX_LB_API_KEY"`, and `requires_openai_auth = false`; it is not
selected globally. The explicit compatibility mode uses exact provider name
`OpenAI`, preserves OAuth, and sends the gateway key through
`X-Codex-LB-API-Key`. Legacy installations that placed the gateway key in the
shared Codex auth slot are blocked until
`sks codex-lb migrate-legacy-desktop --restart-app` can restore a valid OAuth
backup, restart Codex App, verify the stable OAuth account identity, and write a
rollback receipt.

Fast is treated as a service tier independent from reasoning effort. The SKS
menu bar exposes authoritative Fast status plus direct On/Off actions and shows
Unavailable if status cannot be verified. A restarted ChatGPT/Codex Desktop
and user-visible post-restart observation are still required before claiming
that the native picker is visible on a particular machine.

Useful checks:

```bash
sks codex-app check
sks codex-app set-openrouter-key --api-key-stdin
sks codex-app use-openrouter --model z-ai/glm-5.2
sks codex-lb status
sks codex-lb use-desktop-full
sks codex-lb use-cli
sks codex-lb disable
sks codex-lb capabilities --level transport --json
sks codex-lb migrate-legacy-desktop --restart-app
sks codex-app chrome-extension --json
sks codex compatibility --require rust-v0.145.0 --json
sks codex 0.144 --json
sks codex schema --json
sks codex update-status --json
sks fast-mode status --json
sks computer-use status --json
sks computer-use require --route '$sks-qa-loop' --json
sks computer-use smoke --json
```

Web/browser/webapp verification uses the official Codex Chrome Extension path first: https://learn.chatgpt.com/docs/chrome-extension. If the extension is not installed/enabled, QA-LOOP, UX review, and browser verification must halt rapidly and ask the user to set it up before continuing. Computer Use is reserved for native Mac, desktop-app, OS-settings, and non-web visual targets. MAD-SKS can explicitly authorize these target-project scopes (`computer_use`, `browser_use`, `generated_assets`, and file permission changes), but it cannot fake host capability availability.

The generated `sks-fast-high` profile intentionally omits `sandbox_mode`. Codex App and IDE permission settings own the sandbox choice, including Full Access vs workspace-write, while SKS supplies the model, Fast service tier, approval, and reasoning defaults. High-power MAD launches continue to use the explicit `sks-mad-high` profile and `danger-full-access` launch arguments after the user opens the MAD-SKS permission gate.

`sks codex-app check` prints Provider UI, OpenRouter/GLM Model, and codex-lb Key rows. OpenRouter setup uses `sks codex-app set-openrouter-key --api-key-stdin`, `sks codex-app openrouter-models --json`, `sks codex-app openrouter-test --model <id> --json`, and `sks codex-app use-openrouter --model <id>`; the stored 0600 key is supplied to Codex Desktop by command-backed authentication and is never written into TOML.

OpenRouter activation also keeps the full Codex Desktop feature surface enabled for third-party models. Codex gates per-model feature UI on ModelInfo catalog rows (uncataloged models fall back to metadata with the reasoning picker, list visibility, and multi-agent V2 disabled) and gates global feature UI on the `[features]` table, where `features.multi_agent_v2` defaults to off upstream. `use-openrouter` therefore writes an SKS-managed owner-only catalog at `~/.codex/sks-openrouter-catalog.json` — one full ModelInfo row per activated model with `visibility = "list"`, the selectable reasoning levels, `multi_agent_version = "v2"`, and the vendored Codex fallback base instructions — binds `model_catalog_json` to it unless an unmanaged user catalog is configured, and re-runs the `[features]` normalization. After catalog writes, SKS merges activated catalog rows into `$CODEX_HOME/models_cache.json` by slug and marks `fetched_at` stale while preserving the Codex `{ fetched_at, client_version, models }` wrapper so OpenRouter activation cannot wipe the prior Desktop list. Switching providers scopes Desktop's thread sidebar by `model_provider`; SKS remaps `local_thread_catalog` display tags from the previous provider onto `openrouter` (without rewriting `state_5.sqlite` resume identity), snapshots prior routing to `~/.codex/sks-previous-desktop-routing.json`, and exposes `sks codex-app restore-desktop-routing` plus Center **Restore previous provider**. Re-activating OpenRouter while it is already selected never overwrites that snapshot with a self-referential openrouter→openrouter one (the existing cross-provider snapshot is preserved, and `previous_routing_restore_available` reports only genuinely restorable snapshots), and the Fast UI repair preserves an active contract-shaped OpenRouter selection (`model_provider = "openrouter"` plus its top-level `model` line) instead of stripping it as a lock leftover under `# SKS moved machine-local Codex config` migration markers. When the restore's reverse sidebar remap fails — typically `SQLITE_BUSY` because Codex Desktop still holds the thread catalog — `restore-desktop-routing` reports `status: "restored_sidebar_blocked"` with a `thread_sidebar_restore_failed:<error>` blocker and keeps the snapshot file (`snapshot_retained: true`) so the operator can quit Desktop and re-run the same command; only a clean remap consumes the snapshot. Center gates its **Restore previous provider** button on `previous_routing_restore_available`, so it is disabled when no cross-provider snapshot exists. Codex Desktop may still label third-party models as Custom because of upstream picker filtering; restart Codex App when the UI still shows old rows. Role-model preferences that match catalog slugs are stamped into the top picker priorities (0–4) so Desktop/`spawn_agent` can advertise them. `use-router` re-runs the same cache invalidation and `[features]` normalization on activation and warns when a routed catalog row does not advertise `multi_agent_version = "v2"`. Doctor and install repair the OpenRouter catalog whenever OpenRouter is the selected provider, so `sks update` heals older activations automatically. Features that upstream hard-gates on OpenAI account auth (for example image generation and ChatGPT-account surfaces) remain unavailable on `requires_openai_auth = false` providers by Codex design. Legacy Desktop GLM picker profiles (`sks-glm-52-*`) are stripped on update/doctor. codex-lb key setup uses `sks codex-lb setup --host <domain> --api-key-stdin --yes` or `sks codex-lb set-key --api-key-stdin`. These checks report only redacted presence/source states, never raw keys.

## Multi-Provider Router (experimental)

SKS can configure Codex Desktop to use one external, loopback-only, Responses-compatible router and its advertised `provider/model` catalog slugs. The default endpoint is `http://127.0.0.1:10100/v1`; only loopback `http` or `https` URLs ending in `/v1` are accepted. The router itself must already be running and own its upstream-provider credentials. SKS neither implements that proxy nor writes, imports, or reports router credentials.

The integration writes only the user-level Codex configuration at `$CODEX_HOME/config.toml` (normally `~/.codex/config.toml`), not a project `.codex/config.toml`. It selects the `sks-router` custom provider, `wire_api = "responses"`, `requires_openai_auth = false`, a catalog file (by default `$CODEX_HOME/opencodex-catalog.json`), and the chosen main model. The provider contract intentionally has no `env_key`, bearer-token field, HTTP-header credential field, or provider `auth` table.

At the referenced commit, OpenCodex uses port `10100` by default and atomically writes that exact owner-only catalog path, so no separate SKS catalog-sync command is needed. For role-specific mixed-provider routing, start the router and ensure routed catalog rows advertise Codex multi-agent V2 before refreshing SKS:

```bash
ocx start
# Ensure catalog models used for role overrides stamp multi_agent_version = "v2"
ocx status
```

If OpenCodex falls back to a different free port, enter the live port shown by `ocx status` in the Providers page or pass it with `--base-url`. Other routers remain supported, but they must export their own complete Codex `ModelInfo` catalog and expose the matching model ids from `GET /v1/models`.

Use the guarded sequence below. A router test checks that the requested slug is both in the local configured catalog and returned by the live `GET /v1/models` endpoint before activation writes configuration.

```bash
sks codex-app router-status --json
sks codex-app router-test --model anthropic/claude-sonnet --json
sks codex-app use-router --model anthropic/claude-sonnet --json
```

### OpenCodex Design B coexistence

Official Codex Advanced Config allows redirecting the built-in `openai` provider with user-level `openai_base_url` (OpenCodex “Design B”). That keeps ChatGPT thread history tags on `openai` while traffic hits the loopback Responses proxy. SKS does **not** switch to Design B by default: Center activation keeps the credential-free `sks-router` provider table.

When OpenCodex already owns Design B (`openai_base_url` → loopback `/v1` plus OpenCodex inject marker and/or `opencodex-catalog.json`), `router-status` reports `routing_ownership.classification = "opencodex_design_b"` and `use-router` fails closed unless `--force-routing-override` is explicit. Prefer one routing owner at a time: stop OpenCodex inject before SKS takes `sks-router`, or keep OpenCodex as owner and only use Center for status/role prefs against that catalog.

Provider, `openai_base_url`, and `model_providers` remain **user-level only**; project `.codex/config.toml` cannot override them (official Codex ignores those host-owned keys in project config).

`use-router` restarts Codex Desktop by default. Its success result means the guarded configuration write and requested restart completed; it deliberately reports `runtime_verified = false`. `router-status` is also a disk/configuration readback, not proof that App Server adopted the provider. A real App Server `model/list`, bounded Responses turn, and routed official-subagent round trip remain the runtime proof. If restart is blocked, reopen Codex Desktop manually and then run the relevant live checks. Existing unmarked user `model_catalog_json` selections are protected: configuration stops with a catalog-conflict result unless `--replace-catalog` is passed. Use that flag only when intentionally replacing the user's catalog.

The catalog must be an owner-only regular JSON file with a top-level `models` array containing current Codex `ModelInfo` rows; SKS no longer synthesizes missing reasoning metadata or accepts alternate loose container shapes. Each usable routed role entry must advertise `multi_agent_version = "v2"`. Operators who stamp that field accept any OpenCodex cross-provider native multi-agent V2 task-body risk; SKS no longer offers a v1 catalog compatibility path for role overrides. Bare `features.multi_agent` is stripped from managed configs; Naruto and Desktop use `[features.multi_agent_v2]` only.

This is deliberately narrower than the OpenCodex reference at commit `9e68ed67303580ecf0bcde0a56b71b874304fc54`. That project supplies a local multi-provider proxy and documents routing Codex through its built-in OpenAI loopback setting (`openai_base_url`). SKS currently chooses an unauthenticated custom-provider table instead, so that router credentials stay outside Codex config and SKS. It is compatible with a router that exposes the required loopback Responses API and catalog, but it does not install, start, configure, authenticate, supervise, or roll back the external router. To roll back the Desktop selection, restore the prior user config backup or choose another provider/model; stop the external router separately only if the router's own operator intends that change.

The Providers page also manages official subagent role preferences with `sks codex-app role-models`, `set-role-model --role <name> [--provider <id>] --model <catalog-slug> --reasoning <effort>`, and `reset-role-model --role <name>`. Preferences are owner-only and apply to new official custom-agent starts. Routed preferences require `model_provider = "sks-router"`, an exact v2 catalog model (`multi_agent_version = "v2"`), and one of that model's advertised reasoning efforts; `--provider` is optional but, when supplied, must match the catalog entry. Non-routed OpenAI preferences are limited to SKS's managed role profiles so a typo cannot be persisted as a plausible model.

`spawn_agent` accepts model and reasoning-effort overrides but has no provider argument. For a routed preference, the parent passes the exact catalog slug as `model`; the logical provider is encoded by the active router/catalog. Custom `agent_type` selection or a model/reasoning override must use `fork_turns="none"` (or a positive bounded turn count) with the complete slice contract in the message. Do not combine those overrides with an omitted/default or explicit `fork_turns="all"` full-history fork.

Imagegen/gpt-image-2 remains a Codex App capability first. UX-Review/PPT require generated gpt-image-2 callout evidence before verified visual claims. `npm run imagegen:capability` checks that the official Codex App `$imagegen` surface is visible, but full visual verification still needs an actual generated output file with hash/dimensions/provider metadata. Direct OpenAI API, Responses image-generation, codex-lb, or `CODEX_LB_API_KEY` fallback paths are non-Codex API fallbacks and do not satisfy Codex App imagegen evidence unless a separate API task is explicitly requested. When the official app, Chrome Extension, or OS blocks required capabilities, SKS records the external block and marks live verification unverified instead of substituting browser automation or prose-only critique.

Secrets such as `CODEX_ACCESS_TOKEN`, `OPENAI_API_KEY`, and `CODEX_LB_API_KEY` are reported only as redacted presence states.
