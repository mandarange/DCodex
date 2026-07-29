# codex-lb Evidence

SKS keeps codex-lb separate from ChatGPT OAuth. The codex-lb proxy key is stored and redacted as `CODEX_LB_API_KEY`; ChatGPT OAuth remains the official Codex login path.

## Commands

```bash
sks codex-lb setup
sks codex-lb setup --host lb.example.com --api-key-stdin --plan --json
sks codex-lb setup --host lb.example.com --api-key-stdin --yes --json
sks codex-lb status --json
sks codex-lb use-desktop-full
sks codex-lb use-desktop-compat
sks codex-lb use-cli
sks codex-lb disable
sks codex-lb capabilities --level transport --json
sks codex-lb capabilities --level deep --evidence <capture.json> --trust-anchors <anchors.json> --json
sks codex-lb migrate-legacy-desktop --restart-app
sks codex-lb rollback <receipt-id>
sks codex-lb metrics --json
sks codex-lb doctor --deep --json
sks codex-lb circuit reset
sks codex-lb circuit record-fixture test/fixtures/codex-lb/5xx.json --json
sks codex-lb proof-evidence --json
```

## Setup Wizard

`sks codex-lb setup` stores a remote endpoint and gateway credential, then
reports whether the chosen persistence is durable or
`process_only_ephemeral`. The remote codex-lb instance remains independently
hosted and operated; SKS does not deploy, restart, reconfigure, or rotate
credentials on that machine. Interactive setup asks for:

- codex-lb domain or base URL
- API key with hidden input
- Desktop Full Capability, Desktop compatibility, or CLI-only routing
- custom gateway header or explicit bearer-compat transport where supported
- whether to write the shell env loader
- whether to store the key in macOS Keychain when available
- whether to sync the non-secret base URL to the macOS `launchctl` environment
- whether to install a shell profile snippet
- whether to run capability diagnostics

Non-interactive setup accepts `--host`, `--domain`, `--base-url`,
`--api-key-stdin`, `--plan`, `--yes`,
`--desktop-mode desktop-full|desktop-compat|cli-only`,
`--gateway-auth custom-header|bearer-compat`, `--write-env-file`,
`--no-env-file`, `--keychain`, `--no-keychain`, `--launchctl`,
`--shell-profile zsh|bash|fish|all|skip`, `--health`, `--no-health`, and
`--json`.

Plan mode prints the exact files and commands that would change and writes
nothing. Apply records the plan, applied actions, and drift list in the result.
`--yes` applies without an interactive confirmation. Credential-only setup
defaults to an unselected CLI provider and never changes Codex Desktop auth,
Fast state, model selection, or catalog binding.

Persistence modes:

- `durable_env_file`: `~/.codex/sks-codex-lb.env` was written with `0600`.
- `durable_keychain`: macOS Keychain storage succeeded.
- `shell_profile`: a managed shell profile snippet was installed.
- `process_only_ephemeral`: all durable persistence choices were disabled, so the supplied credentials live only in the current process.
- `none`: no credential source is effective.

`--launchctl` syncs the non-secret value (base URL only) outside Desktop
compatibility mode. In `desktop-dual-auth-compat`, SKS injects the official
Center store (`sks-codex-lb.env` / keychain `sks-codex-lb`) into the GUI launch
environment automatically so Codex Desktop can send `X-Codex-LB-API-Key`
without any `source ~/.codex/sks-codex-lb.env` step. Stale twin files such as
`~/.codex/codex-lb.env` and `~/.codex/sks.env` are purged on credential sync.

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
    "source_priority": ["env-file", "keychain", "process.env"]
  },
  "env_auto_load": true
}
```

SKS must never print raw CODEX_LB_API_KEY missing-env text. It reports setup guidance instead and records wrongness if a fixture ever exposes the raw missing-env message or a secret.

Provider and auth invariants:

- Codex App native features are not authentication-mode switches. Model picker,
  Fast, image generation, Browser Use, Computer Use, voice, plugins/apps, and
  other built-in surfaces remain owned by Codex App in every codex-lb routing
  mode. A codex-lb capability row may be unverified or blocked for that routing
  path without disabling the corresponding native App feature.
- Codex Desktop identity is always the real ChatGPT OAuth state in
  `~/.codex/auth.json`. Setup, repair, enable, disable, update, and ordinary
  launch preparation read it for validation but do not write it.
- **Desktop Full Capability** keeps the built-in OpenAI provider selected and
  writes only an SKS-owned loopback `openai_base_url`. It keeps the CLI
  `[model_providers.codex-lb]` block stored but unselected and does not bind a
  local `model_catalog_json`.
- The loopback bridge strips OAuth/cookies from gateway-bound requests and adds
  the separate codex-lb key as `X-Codex-LB-API-Key` by default. Explicit
  `authorization-bearer-compat` is supported only where the operator and
  gateway both require it.
- The gateway auth transport is stored once by setup (`sks-codex-lb.json`, and
  the bridge settings for a running bridge). `status`, `capabilities`, and
  `use-desktop-full` honour that stored choice; `--gateway-auth` /
  `--compat-bearer` pin a different transport for a single invocation only. No
  command silently substitutes a default transport, so a gateway that only
  accepts `Authorization: Bearer` stays reachable from SKS Center without a CLI
  step. SKS Center asks for the transport in `Configure / Update…`.
- A gateway that answers `401`/`403` to the configured transport is reported as
  `codex_lb_gateway_auth_rejected_for_transport:<transport>` with guidance to
  re-run setup with the other transport. It is never reported as an
  unreachable gateway or as a generic bridge failure.
- Desktop Full Capability activation requires a real loopback HTTP round trip —
  that is the path every Codex Desktop request takes, and it also proves the
  gateway accepted the configured transport. A gateway that does not proxy
  `/realtime` WebSocket upgrades leaves voice/realtime unverified and is
  reported in `transport_warnings` with
  `transport_capabilities_verified: false`; it does not roll back working HTTP
  routing.
- **Desktop compatibility** uses exact `name = "OpenAI"`,
  `requires_openai_auth = true`, no `env_key`, and
  `env_http_headers = { "X-Codex-LB-API-Key" = "CODEX_LB_API_KEY" }`.
- **CLI Provider** uses `name = "codex-lb"`,
  `env_key = "CODEX_LB_API_KEY"`, and `requires_openai_auth = false`. It is
  selected explicitly per CLI launch, not as the global Desktop provider.
- An API key found only in shared Codex auth is never assumed to be a codex-lb
  gateway credential. Supply the gateway key with setup. Legacy destructive
  routing is left unchanged until
  `sks codex-lb migrate-legacy-desktop --restart-app`. Migration cannot write
  a successful receipt without the required restart and post-restart identity
  verification.

Capability and evidence invariants:

- HTTP, SSE, multipart, WebSocket, redirects, image events, computer
  call/output, realtime events, browser surfaces, plugins/apps, model picker,
  and Fast metadata are evaluated separately.
- Config, manifests, mocks, and fixtures may establish
  `available_unverified`; they do not establish `verified`.
- Full image verification requires an actual image artifact. Full Computer Use
  verification requires the call/output feedback loop. Full voice verification
  requires create, rewritten Location, WebSocket upgrade, server event, and
  clean close evidence.
- Native mode consumes the gateway's catalog through the bridge and preserves
  unknown fields. It does not synthesize or bind a Desktop-local codex-lb
  catalog.
- `sks codex-lb capabilities --level shallow|transport|deep --json` reports
  `verified`, `available_unverified`, `blocked`, `unsupported`, or `skipped`
  without upgrading fixture evidence into real Desktop proof.
- Deep evidence is accepted only as
  `sks.codex-lb-trusted-deep-evidence.v1` together with an out-of-band
  `sks.codex-lb-deep-evidence-trust-anchor-set.v1`. Mode, loopback endpoint,
  producer, run id, freshness, payload hash, and anchor identity must match.
  Raw JSON, a self-hash without an anchor, stale captures, and fixtures cannot
  promote a capability.
- Full release proof additionally runs
  `npm run codex-lb:desktop-real-evidence`. It returns
  `real_required_missing` until a current real Codex Desktop capture covers
  native feature preservation, Fast effectiveness, image artifact creation,
  the Computer Use feedback loop, voice WebSocket lifecycle, plugins/browser,
  existing and new threads, disable/byte-exact rollback, App restart, Mac
  reboot recovery, the separately hosted other-Mac runtime, and
  authentication-mode independence. The standalone command remains
  fail-closed, while the cross-platform release runner records a missing
  capture as optional live coverage instead of making Linux CI or a CLI-only
  workstation claim native Desktop execution.

Exact setup-choice effects:

- Credential-only setup writes an unselected CLI provider and leaves Desktop
  routing unchanged.
- `--desktop-mode desktop-full` activates the managed loopback bridge only
  after ChatGPT OAuth and bridge startup checks pass.
- `--desktop-mode desktop-compat` activates the explicit dual-auth
  compatibility provider.
- `--desktop-mode cli-only` keeps the provider unselected; `sks codex-lb
  use-cli` returns the explicit CLI launch command.
- `--write-env-file` writes `~/.codex/sks-codex-lb.env` with mode `0600`.
- `--no-env-file` does not write the env file; the current process can still verify the supplied key.
- `--keychain` attempts macOS Keychain storage; `--no-keychain` never runs the `security` command.
- `--launchctl` syncs the non-secret base URL for non-compat modes. Desktop
  compatibility mode injects the Center store key into the GUI launch
  environment automatically and removes stale twin credential files.
- `--shell-profile skip` modifies no shell profile. Shell sourcing is not part
  of the Desktop happy path; use SKS Center or `sks codex-lb setup` /
  `set-key` so Desktop reads the official store.
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
- Ordinary launch preparation does not run an implicit chain/network probe and
  never changes Desktop auth or routing because a probe failed. Health and
  capability commands are explicit diagnostics.

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
