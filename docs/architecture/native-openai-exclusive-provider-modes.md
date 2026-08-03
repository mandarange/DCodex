# Native OpenAI transport with exclusive SKS provider modes

Status: accepted target architecture. This document supersedes older guidance
that selected `sks-router`, `openrouter`, or `codex-lb` as a Codex custom model
provider. Legacy code remains until its callers and migrations are replaced and
verified; its presence is not evidence that the legacy path is still approved.

## Invariants

Codex Desktop always sees its built-in `openai` identity. Codex LB and
OpenRouter use a local loopback proxy configured through `openai_base_url`;
ChatGPT OAuth uses the native OpenAI path without a leftover loopback. The
upstream source remains visible in SKS Center and public metadata. Native
transport identity must never be presented as proof that an external model came
from OpenAI.

SKS has three explicit and mutually exclusive modes: `codex-lb`, `openrouter`,
and `chatgpt-oauth`. The proxy or local state service is the final enforcement
point for mode, credential class, model allowlist, child-agent policy, and
session snapshot. UI filtering is only a projection. A request that disagrees
with the proxy snapshot is rejected; it is never repaired by using another key,
account, provider, or model.

New sessions pin mode, model, allowed child policy, and account binding. Resume,
fork, and child work inherit that snapshot. A global default change does not
rewrite an existing session. If the restore contract changed or legacy metadata
is missing, the session remains resumable-but-blocked and Center shows the fixed
reason and recovery action.

Unsupported new Codex feature formats remain visible. A feature may use an
OAuth auxiliary path only when its protocol contract is verified, the proxy
cannot handle that exact feature, the user explicitly allows it, and OAuth is
connected. The event records feature, route, and failure reason only. It never
records a key, account identifier, request body, or OAuth token, and it does not
change the session mode.

## State and atomic application

The hardened state service owns two separate records:

- a draft edited by SKS Center;
- the last verified applied snapshot consumed by the proxy and new sessions.

Apply is a four-stage transaction: configuration saved, proxy applied, native
catalog refreshed, and new-session readiness verified. A failed stage leaves
the last verified snapshot active and reports the exact failed stage. Existing
sessions remain pinned. The menu bar renders a bounded last-good projection and
keeps settings/recovery available even when the proxy, network, catalog, or
backend is unavailable.

Compatibility checks run at startup, apply, explicit user verification, and a
low-frequency background cadence. Background checks never open authentication
UI, switch mode, recapture external evidence, or transmit a local reference.

## Credentials

SKS-owned API keys use stable service and logical account identifiers that do
not depend on username, hostname, install path, or process. Development and
production services must not share an item. Reads use a non-interactive
`LAContext`; missing, locked, damaged, access-control, and signing/access-group
failures become `Authentication Required` with an explicit reconnect action.
Only that action may write or trigger authentication UI. Official ChatGPT OAuth
tokens stay Codex-owned and are never copied into SKS receipts.

A stable Developer ID/helper signing requirement is still necessary to promise
access across binary updates. The current install-time ad-hoc menu-bar signature
cannot prove that production invariant; Center must report it as unavailable or
access mismatch rather than prompting repeatedly.

## Recovery and observability

Time budgets are diagnostic warnings, not termination conditions. Evidence,
file changes, test results, model responses, and tool responses are progress
signals. Only a classified transient network failure may automatically resume
the exact same retry-safe request, at most twice. Authentication, mode, account
binding, external configuration, unknown failures, and an exhausted network
retry budget remain `pausedResumable` until explicit user review.

The Center projection includes verification time, critical path, cache state
(`HIT`, `MISS`, `BYPASS`, or `EXPIRED`) and invalidation reason when available,
retry count, FAST/HEAVY reason, last progress signal, pause cause, recovery
attempt, and next action. Public and internal receipts use irreversible bounded
diagnostic codes; they exclude keys, account IDs, request bodies, and secret
fingerprints.

## Evidence isolation

The hardened evidence store uses a project-internal irreversible identifier that
is created once and is not derived from a public path. A filesystem clone is a
new project and cannot reuse the original evidence namespace.

EvidenceKey v2 contains criterion/check identity, direct target hashes, direct
dependency Merkle root, auth mode, model policy, validation rule/version, and
toolchain/environment contract. Only a changed dependency or rule invalidates
the receipts it can affect. Broad workspace hashes and unrelated rule changes
do not invalidate unrelated receipts.

Image and other external references store path/URI, SHA-256, and metadata only.
Missing or changed bytes produce `expired_reference`; they cannot pass or hit a
cache. Recapture, copying source bytes into a mission, and external transmission
require a separate explicit user action.

## Implementation status (2026-08-02)

| Area | Implemented | Contract-tested | Live-verified |
| --- | --- | --- | --- |
| Native OpenAI transport | Loopback URL validation, inbound credential stripping, upstream credential replacement, HTTP/WS metadata preservation | Yes | No |
| Exclusive routing | Mode, credential class, model allowlist, no-fallback, OAuth auxiliary opt-in | Yes | Yes, including negative matrix | No |
| Session and child policy | Create/fork/resume pins, parent snapshot hash, LB affinity hash, registered OpenRouter children, native OAuth ownership | Yes | Yes | Strict Desktop request-header integration is not verified |
| Draft and last-known-good | Atomic stage/commit/rollback and four receipts | Yes | Yes, including crash/partial failure | No |
| Catalog and features | Last-good catalog, key withdrawal, explicit direct/OAuth/unavailable projection, observable background failures | Yes | Yes | No |
| Keychain and Center | Stable development/production namespaces, non-interactive reads, explicit reconnect writes, action inventory, four-stage UI, persistent recovery menu | Yes | Yes with injectable Security and generated Swift harness | Production Developer ID repeated-relaunch QA not run |
| Intent/evidence/graph/image | Immutable IntentContract, EvidenceKey v2, affected-receipt invalidation, single writer + staging validation, reference-only image registry | Yes | Yes | No external evidence transfer was attempted |
| Recovery and observability | Progress signals, warning-only budgets, two same-cause network retries, manual resume, redacted projections | Yes | Yes | No long-running live route proof |
| Migration and command normalization | Inspect/plan/explicit apply, alias-first canonical contract, unsupported legacy option rejection | Yes | Yes | No user configuration was migrated |
| Hermetic sandbox | Temp HOME/CODEX_HOME/SKS_HOME, four mock servers, filesystem and secret scan | Yes | Yes | Real LB probe not run because approved credentials were absent |

The strict proxy path requires `x-sks-provider-mode`, session ID, child policy,
and parent snapshot metadata. The current Codex Desktop request protocol does
not provide those sealed session fields. Compatibility settings leave
`require_session_pin` disabled until that protocol is verified; tests inject
the fields directly and prove fail-closed enforcement. This is an external
protocol gap, not permission to infer a session or silently fall back.

The signed QA runner lives under
[`native/sks-menubar/UITests`](../../native/sks-menubar/UITests). It reports
`not_verified` unless an approved production-signed app and `.xctestrun` bundle
are injected. The hermetic live runner similarly requires approved
`CODEX_LB_API_KEY` and `CODEX_LB_BASE_URL` process variables and never reads the
user's saved Codex state as a substitute.
