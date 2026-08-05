# Desktop Bridge provider guide

## 8.1.3 contract

SKS has one managed Desktop and CLI routing runtime: the local **Desktop
Bridge**. Codex-LB and OpenRouter are independent provider profiles registered
with that bridge; neither is a runtime mode or a global Codex provider
selection.

ChatGPT OAuth remains owned by Codex. SKS does not copy, rewrite, or send that
OAuth authorization to either provider upstream. Codex-LB and OpenRouter
credentials may coexist, and enabling, disabling, validating, or rotating one
profile must not delete or overwrite the other profile's credential.

The old `sks codex-lb` command family has been removed. It has no compatibility
alias: invoking it returns `unknown_command`. Use `sks bridge` exclusively.

## Configure and inspect profiles

```sh
sks bridge status --json
sks bridge ensure --json

# Read the key from standard input; never put it in argv.
read -r -s codex_lb_key
printf '\n'
printf '%s\n' "$codex_lb_key" | \
  sks bridge provider configure codex-lb --host lb.example.com --api-key-stdin --json
unset codex_lb_key

read -r -s openrouter_key
printf '\n'
printf '%s\n' "$openrouter_key" | \
  sks bridge provider configure openrouter --api-key-stdin --json
unset openrouter_key

sks bridge provider validate codex-lb --json
sks bridge provider validate openrouter --json
sks bridge provider list --json
```

`provider disable` stops the profile from being used but preserves its
credential. Credential deletion is separate, destructive, and requires an
explicit confirmation:

```sh
sks bridge provider disable codex-lb --json
sks bridge provider remove-credential codex-lb --confirm --json
```

Bridge results expose secret-free credential metadata only: state, source,
redacted fingerprint, and check time. They never serialize provider keys,
OAuth tokens, or a complete endpoint query.

### Credential persistence classes

The status contract reports the credential persistence class without exposing
the credential. `durable_env_file` is the owner-only CLI store,
`durable_keychain` is available only through an explicit signed-app reconnect,
`shell_profile` identifies an operator-owned shell source that SKS does not
rewrite, and `process_only_ephemeral` means the value disappears with the
process. A profile containing a **base URL only** is configured-incomplete, not
ready. None of these classes authorizes automatic authentication UI or copying
ChatGPT OAuth into a provider profile.

## Catalog and routing

The bridge builds one combined catalog and one explicit route index. A model is
routed by an index entry, not by a model-name convention or by the currently
selected profile. A conflicting public model ID is blocked with
`catalog_model_route_ambiguous`; an unknown model is blocked with
`catalog_model_route_missing`. The fallback policy is always `none`.

```sh
sks bridge catalog sync --json
sks bridge catalog status --json
sks bridge route list --json
sks bridge route set-default codex-lb --json
sks bridge route explain <model> --json
```

The default provider helps with uniquely resolvable aliases and new-selection
UI filtering. It is never a silent request fallback. A session pin records the
provider, public/upstream model, catalog generation, and route-policy
generation, so a running thread cannot drift to another provider when a
profile or catalog changes.

## Verification levels

```sh
sks bridge verify --level shallow --json
sks bridge verify --level transport --json
sks bridge verify --level deep --json
```

`shallow` inspects ownership, service state, profile configuration, and route
metadata. `transport` validates the applicable bridge and active-route path;
it distinguishes TCP, HTTP health, WebSocket upgrade, protocol, frame round
trip, and clean close. `deep` additionally needs feature-specific evidence,
such as a validated image artifact.

Command execution and readiness are different fields. A non-strict report can
be generated successfully even when readiness is false. Only `--strict` or
`--require-ready` turns unmet readiness into a non-zero exit. A missing deep
probe is `not_attempted`, not a transport blocker and not evidence that the
feature is available.

## Migration, ownership, and rollback

Current migration privately recognizes only SKS-authored historical routing
markers. It converts them into the Desktop Bridge, provider profiles, combined
catalog, and route policy without creating a legacy runtime directory. A
user-owned or ambiguous provider/catalog/base-URL configuration fails closed
with a recovery action; it is not edited automatically.

Migration writes a restricted receipt containing hashes, ownership-safe
metadata, migrated profile IDs, and rollback metadata. It never includes a
secret. Running migration again records an already-migrated/no-op result.
Rollback uses that receipt to restore bridge/config metadata only; it does not
overwrite a newer OAuth state, a rotated key, or a newly added provider
credential.

```sh
sks bridge unmanage --confirm --json
sks bridge rollback <receipt-id> --confirm --json
```

`unmanage` is an explicit removal/rollback operation, not a provider switch.
After it, the state is unmanaged/native rather than another SKS mode.

## Real-environment boundary

Local schema checks and hermetic tests do not prove a real macOS service,
credential validation, Desktop restart, WebSocket frame round trip, or deep
feature artifact. Those items stay `not-run-real` until a target-bound,
redacted runtime receipt is collected for the release.
