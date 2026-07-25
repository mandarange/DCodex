# codex-lb Evidence

SKS keeps codex-lb separate from ChatGPT OAuth. The codex-lb proxy key is stored and redacted as `CODEX_LB_API_KEY`; ChatGPT OAuth remains the official Codex login path.

## Commands

```bash
sks codex-lb setup
sks codex-lb setup --host lb.example.com --api-key-stdin --plan --json
sks codex-lb setup --host lb.example.com --api-key-stdin --yes --json
sks codex-lb status --json
sks codex-lb metrics --json
sks codex-lb doctor --deep --json
sks codex-lb circuit reset
sks codex-lb circuit record-fixture test/fixtures/codex-lb/5xx.json --json
sks codex-lb proof-evidence --json
```

## Setup Wizard

SKS 1.0.8 keeps `sks codex-lb setup` as a two-phase plan/apply repair path for missing codex-lb keys and reports whether the chosen persistence is durable or `process_only_ephemeral`. Codex 0.133 remote executor standard-auth registration is recorded as a P1 policy review item; SKS does not invent credential fallback behavior. Interactive setup asks for:

- codex-lb domain or base URL
- API key with hidden input
- whether to use the proxy as the default Codex launch target
- whether to write the shell env loader
- whether to store the key in macOS Keychain when available
- whether to sync the macOS `launchctl` environment
- whether to install a shell profile snippet
- whether to run a health check

Non-interactive setup accepts `--host`, `--domain`, `--base-url`, `--api-key-stdin`, `--plan`, `--apply`, `--yes`, `--use-default-provider`, `--no-default-provider`, `--write-env-file`, `--no-env-file`, `--keychain`, `--no-keychain`, `--launchctl`, `--no-launchctl`, `--shell-profile zsh|bash|fish|all|skip`, `--health`, `--no-health`, and `--json`.

Plan mode prints the exact files and commands that would change and writes nothing. Apply mode records the plan, applied actions, and drift list in the result. `--yes` applies without an interactive confirmation.

Persistence modes:

- `durable_env_file`: `~/.codex/sks-codex-lb.env` was written with `0600`.
- `durable_keychain`: macOS Keychain storage succeeded.
- `shell_profile`: a managed shell profile snippet was installed.
- `process_only_ephemeral`: all durable persistence choices were disabled, so the supplied credentials live only in the current process.
- `none`: no credential source is effective.

`--launchctl` is no longer a credential persistence mode. It may sync the non-secret base URL only and removes `CODEX_LB_API_KEY` / `OPENROUTER_API_KEY` from the user launchd environment.

The combination `--no-env-file --no-keychain --no-launchctl --shell-profile skip` is process-only. Non-interactive process-only setup requires `--yes`; interactive setup asks for a separate `process-only` confirmation. JSON output includes:

```json
{
  "persistence": {
    "effective_mode": "process_only_ephemeral",
    "durable": false,
    "warning": "process_only_ephemeral",
    "warnings": [
      "process_only_ephemeral",
      "next_shell_requires_setup_or_env",
      "Codex App GUI launch may not see credentials"
    ]
  }
}
```

Recovery command for durable persistence:

```bash
sks codex-lb setup --host lb.example.com --api-key-stdin --yes --write-env-file --keychain --launchctl --shell-profile zsh
```

Base URL normalization:

```text
lb.example.com -> https://lb.example.com/backend-api/codex
https://lb.example.com -> https://lb.example.com/backend-api/codex
https://lb.example.com/backend-api/codex -> unchanged
```

The fallback env file is `~/.codex/sks-codex-lb.env` with mode `0600`. Metadata lives at `~/.codex/sks-codex-lb.json` and stores only `base_url`, `updated_at`, `source`, and a SHA-256 key fingerprint. Status and doctor report only redacted key presence:

```json
{
  "configured": true,
  "repair_available": false,
  "api_key": {
    "present": true,
    "source": "env-file",
    "redacted": true
  },
  "env_loader": {
    "configured": true,
    "source_priority": ["process.env", "keychain", "env-file", "legacy-env-file"]
  },
  "env_auto_load": true
}
```

SKS must never print raw CODEX_LB_API_KEY missing-env text. It reports setup guidance instead and records wrongness if a fixture ever exposes the raw missing-env message or a secret.

Provider auth invariant:

- `[model_providers.codex-lb]` uses `name = "openai"`, `wire_api = "responses"`, `env_key = "CODEX_LB_API_KEY"`, `supports_websockets = true`, and `requires_openai_auth = true`.
- `CODEX_LB_API_KEY` is SKS's persisted key source. When the user selects codex-lb auth, SKS also writes Codex's OpenAI-style `auth.json` API-key entry so Codex App actually authenticates through the codex-lb key. ChatGPT OAuth can be preserved as a backup and restored by `sks codex-lb use-oauth`.
- Codex App Chat/Pro account features require the ChatGPT OAuth auth class. Center exposes **Restore Chat / Pro (OAuth)** for that explicit switch and keeps the codex-lb provider definition and stored credentials ready for later `sks codex-lb use-codex-lb --restart-app` reuse.
- `sks update` is mode-preserving: active codex-lb remains selected with the same model/reasoning/catalog/routing state, while an existing OAuth/unselected state remains OAuth. Only explicit `use-oauth`, `release`, or `use-codex-lb` actions may change the provider/auth class.
- Imagegen capability checks may record codex-lb as configured routing, but codex-lb is not official Codex App `$imagegen` evidence and must not be used for full generated-image verification unless a separate non-Codex API fallback task is explicitly requested.

Imagegen under a selected codex-lb provider:

- Selecting `model_provider = "codex-lb"` is by itself enough to reach image generation. The Codex App `$imagegen` surface answers through this same proxy, so requiring `SKS_IMAGEGEN_ALLOW_CODEX_LB_API_FALLBACK=1` there left the only reachable path switched off. `SKS_IMAGEGEN_ALLOW_CODEX_LB_API_FALLBACK=0` (or `allowCodexLbApiFallback: false`) still disables it and keeps every request local.
- The request goes to `<base_url>/responses` with `tools: [{ type: "image_generation" }]`. That provider streams the image on `response.output_item.done` (`item.result`) and `response.image_generation_call.partial_image` (`partial_image_b64`) while closing `response.completed` with an empty `output`, so SKS folds the streamed image back into the completed envelope and marks it `image_output_recovered_from_stream`.
- The request model comes from the served catalog (`model_catalog_json`), not from `config.toml`'s `model`: a slug the codex-lb key cannot use is rejected with `403 model_not_allowed`. Precedence is `SKS_IMAGEGEN_RESPONSES_MODEL` → configured `model` when the catalog lists it → first catalog slug.
- The API key is resolved through `loadCodexLbEnv`, which selects the candidate whose fingerprint matches `~/.codex/sks-codex-lb.json`. A stale exported `CODEX_LB_API_KEY` therefore no longer shadows the SKS-managed env file and produces a `401` while every capability probe still reports ready.
- Evidence class is `codex_lb_provider_imagegen` with `output_source = codex_lb_provider_responses`, and it counts as full generated-image evidence. The taxonomy lives in `src/core/imagegen/imagegen-evidence.ts`; every gate (route gate, stop gate, PPT slide review, generated-image ledger) asks it rather than restating the accepted classes. codex-lb enabled as a *fallback* while another provider is selected stays `non_codex_api_fallback` and still blocks — only a selected provider earns the class.
- Callout extraction (reading the generated image back into an issue ledger) runs over the same provider when no Codex session id is passed, so `$sks-image-ux-review` completes without `OPENAI_API_KEY`. The provider answers SSE even for `stream: false` and again closes `response.completed` with an empty `output`, so `src/core/responses-stream.ts` recovers streamed items for both the image and the json_schema text.
- The Responses API rejects a few JSON Schema constructs that `schemas/codex/*.json` uses. `strictJsonSchemaFormat` now normalizes them: a `const`/`enum`-only property gets its inferred `type`, `$defs`/`definitions` are made strict like inline schemas, and a 2020-12 `prefixItems` tuple becomes a homogeneous `items` schema with `minItems`/`maxItems` keeping the arity. A mixed-type tuple is left alone rather than silently widened.

Exact setup-choice effects:

- `--use-default-provider` writes `[model_providers.codex-lb]` with the current App contract above, then selects top-level `model_provider = "codex-lb"`.
- `--no-default-provider` writes the provider block but does not select top-level `model_provider`.
- `--write-env-file` writes `~/.codex/sks-codex-lb.env` with mode `0600`.
- `--no-env-file` does not write the env file; the current process can still verify the supplied key.
- `--keychain` attempts macOS Keychain storage; `--no-keychain` never runs the `security` command.
- `--launchctl` syncs the GUI launch environment when available; `--no-launchctl` never runs `launchctl setenv`.
- `--shell-profile skip` modifies no shell profile.
- Action reports list only actions actually performed, and drift checks fail setup when requested choices do not match actual filesystem, Keychain, launchctl, or shell-profile effects.

Release gates:

```bash
npm run codex-lb:setup-fixture
npm run codex-lb:setup-truthfulness
npm run codex-lb:persistence-truth
npm run codex-lb:missing-env-regression
npm run codex-lb:fast-mode-truth
node --test test/blackbox/codex-lb-setup-stdin-no-secret-leak.test.mjs
```

## Circuit Policy

- `auth` rejection is a hard failure.
- Repeated `5xx` or timeout failures open the circuit.
- `previous_response_not_found` is a stateless-LB warning, not an automatic failure.
- Hard failures are surfaced and recorded in circuit health.
- SKS only bypasses codex-lb when the user chooses fallback or `SKS_CODEX_LB_AUTOBYPASS=1` is set.

Health summaries are written to `~/.codex/sks-codex-lb-health.json` and `<active-project>/.sneakoscope/reports/codex-lb-health.json` when launch health checks or metrics commands update the circuit. Completion Proof evidence includes a `codex_lb` summary from the active project root.

0.9.14 launch health integration records the same circuit state when the response-chain check runs:

- `previous_response_not_found` records a warning and keeps the circuit closed.
- auth rejection opens the circuit immediately.
- timeout, network, and 5xx failures open the circuit after three recent failures.
- `chain_ok` updates `last_ok_at` and closes a half-open/open circuit.

## Fast Mode Truth

codex-lb normalizes Codex `service_tier = "fast"` to upstream `priority`. SKS therefore separates three states:

- Configured intent: Codex config or launch args request Fast mode.
- Requested proof: the codex-lb request log shows `requestedServiceTier = "priority"`.
- Actual proof: codex-lb records `actualServiceTier = "priority"` or billable `serviceTier = "priority"`.

`sks codex-lb status` may report configured Fast intent, but it does not claim actual Fast mode. `sks codex-lb fast-check --json` sends a priority-tier probe and fails unless the response or supplied request log proves priority was actually requested and granted. Use `--request-log <json-or-jsonl>` to bind a codex-lb request-log export.
