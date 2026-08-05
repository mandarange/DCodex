# codex-lb Evidence

> The native Desktop target is now the built-in `openai` identity plus the
> loopback bridge described in
> [native OpenAI transport with exclusive modes](architecture/native-openai-exclusive-provider-modes.md).
> Custom top-level `codex-lb` provider selection described below is retained for
> CLI and legacy migration compatibility and is superseded for new Desktop
> architecture work.

SKS keeps the codex-lb gateway key separate from ChatGPT OAuth. The key is
stored and redacted as `CODEX_LB_API_KEY`; `~/.codex/auth.json` remains
byte-preserved. With codex-lb off, ChatGPT OAuth is the official path. In the
hardened Desktop path, Codex keeps `openai` while the loopback bridge chooses
the exclusive upstream and replaces the outbound credential. Legacy/CLI
**Use codex-lb** may still select the custom provider and is migrated
explicitly; neither path may consume OAuth as a gateway fallback.

## Key storage & keychain

The canonical store is `~/.codex/sks-codex-lb.env` with mode `0600`. Key
resolution is env-file first and then `CODEX_LB_API_KEY`; this deliberate
inversion prevents a stale ambient shell export from overriding SKS Center
credentials. The CLI store remains the canonical non-App store. SKS Center
additionally uses its native stable Keychain namespace for non-interactive
readiness and explicit reconnect, and considers the reconnect complete only
when both the CLI configuration and Keychain write succeed. The public CLI
`--keychain` option remains fail-closed because an interpreter is not granted
general Keychain access.

Legacy handling is one-time only: transfer a legacy Keychain key only when the
env file lacks a valid key, or, when the env file is valid, verify then delete
the legacy item without reading it. SKS stamps a migration attempt, so a
failure or cancellation is not automatically re-prompted. Menu Bar signing
stability is no longer keychain-load-bearing.

## Commands

```bash
sks codex-lb setup
sks codex-lb setup --host lb.example.com --api-key-stdin --plan --json
sks codex-lb setup --host lb.example.com --api-key-stdin --yes --json
sks codex-lb status --json
sks codex-lb use-desktop-full
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
- Desktop Full Capability or CLI-only routing
- custom gateway header or explicit bearer-compat transport where supported
- whether to write the shell env loader
- whether to sync the non-secret base URL to the macOS `launchctl` environment
- whether to install a shell profile snippet
- whether to run capability diagnostics

Non-interactive setup accepts `--host`, `--domain`, `--base-url`,
`--api-key-stdin`, `--plan`, `--yes`,
`--desktop-mode desktop-full|cli-only`,
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
- `durable_keychain`: reserved for an identity-verified, dedicated signed SKS
  helper. The public CLI currently fails closed instead of granting a reusable
  interpreter or `/usr/bin/security` generic access to the gateway secret.
- `shell_profile`: a managed shell profile snippet was installed.
- `process_only_ephemeral`: all durable persistence choices were disabled, so the supplied credentials live only in the current process.
- `none`: no credential source is effective.

`--launchctl` syncs the non-secret base URL only and removes API-key variables
from the GUI launch environment. The retired `desktop-dual-auth-compat` mode is
detected for migration but cannot be activated because it requires a global GUI
secret. Stale twin files such as `~/.codex/codex-lb.env` and
`~/.codex/sks.env` are quarantined or reported according to provenance.

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
sks codex-lb setup --host lb.example.com --api-key-stdin --yes --write-env-file --launchctl --shell-profile zsh
```

Base URL normalization:

```text
lb.example.com -> https://lb.example.com/backend-api/codex
https://lb.example.com -> https://lb.example.com/backend-api/codex
https://lb.example.com/backend-api/codex -> unchanged
```

The fallback env file is `~/.codex/sks-codex-lb.env` with mode `0600`. Metadata lives at `~/.codex/sks-codex-lb.json` and stores `base_url`, `updated_at`, `source`, and a SHA-256 key fingerprint; one-time legacy migration also records a short redacted preview. Status and doctor report only redacted key presence:

On explicit setup or reconfiguration, SKS checks for the retired generic
Keychain service `sks-codex-lb`. It removes only the exact legacy
service/account after the new env file and metadata have been committed and
revalidated as owner-only regular files with matching URL and key digests.
SKS then reads Keychain back and requires an item-not-found result. If deletion
or readback is indeterminate, the verified replacement store is retained,
setup reports the cleanup failure, and the provider key should be rotated.
Both `setup` and `set-key` print the rotation warning in ordinary terminal
output as well as returning it in JSON.
Background status and credential synchronization do not perform this migration.

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
    "source_priority": ["env-file", "process.env"]
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
- Shared ChatGPT OAuth in `~/.codex/auth.json` is preserved across setup,
  repair, enable, disable, update, and ordinary launch preparation. It is used
  only when the official provider is selected; a selected codex-lb route must
  not read it as fallback authentication.
- **Use codex-lb** commits `[model_providers.codex-lb]` and top-level
  `model_provider = "codex-lb"` as one guarded transaction. The provider uses
  the configured remote `base_url`,
  `env_http_headers = { "X-Codex-LB-API-Key" = "CODEX_LB_API_KEY" }`, and
  `requires_openai_auth = false`, without an additional `env_key` Bearer path.
  A provider definition without its requested
  active selection is drift, not an enabled state.
- Remote base URLs, including a codex-lb Docker deployment on another machine,
  are first-class. No localhost-only assumption, implicit OAuth substitution,
  or unrelated `auth.json` API key can satisfy gateway authentication.
- The gateway auth transport is stored once by setup (`sks-codex-lb.json`, and
  the bridge settings for a running bridge). `status`, `capabilities`, and
  `use-desktop-full` honour that stored choice; `--gateway-auth` /
  `--compat-bearer` pin a different transport for a single invocation only. No
  command silently substitutes a default transport, so a gateway that only
  accepts `Authorization: Bearer` stays reachable from SKS Center without a CLI
  step. SKS Center asks for the transport in `Reconnect Codex LB credential…`.
- A gateway that answers `401`/`403` to the configured transport is reported as
  `codex_lb_gateway_auth_rejected_for_transport:<transport>` with guidance to
  re-run setup with the other transport. It is never reported as an
  unreachable gateway or as a generic bridge failure.
- Activation requires one measured request to the selected remote base URL.
  The durable RoutingTruth result records measurement time, target host,
  authentication class, and latency, and the same result is rendered by Doctor
  and the Menu Bar. Configuration, `/health`, and a provider block alone never
  turn the UI green. A gateway that does not proxy `/realtime` WebSocket
  upgrades leaves voice/realtime unverified and is reported in
  `transport_warnings` with `transport_capabilities_verified: false`; it does
  not rewrite the measured HTTP result.
- After SKS Center selects the CLI provider, it invokes
  `sks codex-lb connect-test --json`. This path sends exactly one Responses
  request with `store: false`, no tools or continuation ID, low reasoning, and
  a 32-token output cap. Center accepts success only when the structured result
  contains a completed non-error response, response ID, non-empty bounded text,
  HTTP success, model, latency, consistent token usage, and no blockers. A
  failed test leaves the selected mode intact and exposes a manual retry. The
  command refuses to send before provider selection and resolves its model from
  an explicit environment choice, the top-level Codex config, or the installed
  Codex model cache in that order.
- The retired **Desktop compatibility** marker remains recognizable only so
  status, Doctor, and migration can fail closed with
  `desktop_dual_auth_compat_unavailable`. It is never reported ready and cannot
  be activated through CLI, setup, Center, repair, or internal routing APIs.
- The codex-lb provider uses `name = "codex-lb"`,
  `env_http_headers = { "X-Codex-LB-API-Key" = "CODEX_LB_API_KEY" }`, and
  `requires_openai_auth = false`, with no `env_key` Bearer authentication.
  Credential-only setup may leave it stored and unselected; the explicit
  Center/CLI **Use codex-lb** action promotes that same definition to the active
  top-level selection atomically.
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
  reboot recovery, the separately hosted other-Mac runtime, authentication-mode
  independence, and one measured gateway-key request whose target equals the
  selected remote base URL. The standalone command remains
  fail-closed, while the cross-platform release runner records a missing
  capture as optional live coverage instead of making Linux CI or a CLI-only
  workstation claim native Desktop execution.

Exact setup-choice effects:

- Credential-only setup writes an unselected CLI provider and leaves Desktop
  routing unchanged.
- **Use codex-lb** writes the provider definition and top-level selection in one
  transaction, verifies key resolution and remote reachability, and becomes
  ready only after the measured request succeeds.
- **Use ChatGPT OAuth** removes the active SKS-owned codex-lb selection without
  consuming, replacing, or rewriting the preserved OAuth identity.
- `--desktop-mode cli-only` keeps the provider unselected; `sks codex-lb
  use-cli` returns the explicit CLI launch command.
- `--write-env-file` writes `~/.codex/sks-codex-lb.env` with mode `0600`.
- `--no-env-file` does not write the env file; the current process can still verify the supplied key.
- `--keychain` fails closed with `keychain_acl_helper_unavailable` until a
  dedicated signed helper is available; `--no-keychain` remains the normal
  public path.
- `--launchctl` syncs the non-secret base URL and removes API-key variables
  from the GUI launch environment.
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

Those hermetic checks do not satisfy the SKS 8.0.5 live routing gate. The
release evidence must include one current real request captured with codex-lb
selected, the destination matching the configured remote base URL, the
authentication class proving the issued gateway key rather than OAuth, and the
same measured host/time/latency record visible through Doctor and the Menu Bar.
Missing credentials or an unreachable host is a blocker; it is never converted
to an OAuth success or a fixture pass.

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

## Architecture-hardening verification

The bridge request choke point enforces provider mode, credential readiness,
model allowlist, optional session pin, child snapshot, parent snapshot, and
no-fallback policy for HTTP and WebSocket paths. Internal `x-sks-*` headers and
Desktop bearer credentials are stripped before the configured gateway
credential is attached. A 401, quota error, or 5xx is returned as a failure for
the selected upstream and never triggers cross-account/provider fallback.

The hermetic runner is:

```bash
npm run build:incremental --silent
node --test test/e2e/architecture-hardening/hermetic-sandbox.test.mjs
```

It uses mock services and proves contracts only. A real Responses request is
attempted only when `CODEX_LB_API_KEY`, `CODEX_LB_BASE_URL`, and
`SKS_ARCHITECTURE_LIVE_APPROVED=1` are all present in the runner process. The
credential is passed only through the child environment and is not written or
printed. Without those inputs the report is exactly `not_verified`, not a mock
success promoted to live evidence.
