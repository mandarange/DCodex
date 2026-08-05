# Plan: Codex LB auth root-cause + Center clarity → 8.1.1

```yaml
slug: codex-lb-auth-center-clarity-811
route: $sks-plan
implementation_allowed: true
handoff: $sks-work
created: 2026-08-05
target_version: 8.1.1
status: implemented
```

## Goal

After 8.1.0, SKS Center still shows a dead **Use Codex LB** path: vague “codex lb auth rejected”, a false **Legacy … migration required** badge, and Connection Proof stuck at “Configuration · failed” with no actionable diagnosis. Fix the **real gateway auth failure**, stop mislabeling modern CLI selection as legacy, make every failure show a stable error code + next action, remove redundant Center chrome, then cut **8.1.1**.

**Done when:**
- Live Hyper-Lab-style gateways that require `Authorization: Bearer` are diagnosed and recoverable from Center without guessing.
- Active Provider never says “Legacy … migration required” for `desktop_mode: cli-provider`.
- Auth / connect / use-cli failures show `E-LB-*` code, HTTP status, transport, gateway message (redacted), and one primary next action.
- Providers page drops duplicate/low-value controls listed below.
- Package cut to **8.1.1** with changelog + publish-ready prep (work route).

**Non-goals:** inventing fake physical gate receipts; changing OpenRouter/Telegram product scope; silent auto-publish; keeping both transports forever without operator consent.

## Evidence (this machine, 2026-08-05)

`sks codex-lb status --json` / `connect-test --json`:

| Field | Value |
|---|---|
| `desktop_mode` | `cli-provider` |
| `legacy_codex_lb_selected` | `false` |
| `gateway_auth_transport` | `x-codex-lb-api-key` |
| `routing_truth.status` | `auth_rejected` |
| `routing_truth.http_status` | `401` |
| `routing_truth.auth_outcome` | `rejected` |
| connect-test `error` | `Missing API key in Authorization header` |

Screenshot matches: vague “Reason: codex lb auth rejected”, Connection Proof not run, Active Provider “Legacy … migration required” even though mode is modern CLI.

## Root causes

### R1 — Transport mismatch (functional)

Gateway expects **Bearer**; stored transport is **custom header**. 401 body already says so. Center setup *can* choose bearer at reconnect time, but:

1. Existing installs stay on wrong transport until full Reconnect (host + transport + key again).
2. Status/connect-test emit generic `codex_lb_auth_rejected`, so guidance falls through to “run use-cli” instead of transport switch (`desktop-controller` only special-cases `codex_lb_gateway_auth_rejected_for_transport:<transport>`).

### R2 — Active Provider badge lies (UX)

`renderActiveProviderSummary` treats any `codexLbSelectedNow` (including `measuredRoute.selected` for cli-provider) as:

> Legacy Codex LB provider selection · migration required

That is wrong for `desktop_mode == cli-provider`. Operators chase a non-existent migration.

### R3 — Failure copy collapses diagnosis (UX)

`structuredPublicDetail` turns blockers into underscored prose and a generic “review the key, model id, and network” next step. It drops `http_status`, `auth_transport`, gateway `error`, and stable codes. Connection Proof then says “did not run” without saying **why use-cli/status failed closed**.

### R4 — Center Providers clutter

On one page today: Authentication Recovery (duplicates reconnect CTAs), Provider Apply Stages, Active Provider, Credentials, Advanced Desktop Bridge, Capability Matrix, OpenRouter, Role Models, Fast. Failures are buried; advanced surfaces compete with the primary path.

## Scope

**In**
- `src/core/codex-lb/routing-truth.ts` — classify 401/403 + Authorization-missing body → transport-specific blocker
- `src/core/codex-lb/desktop-controller.ts` (+ connect-test path) — same classification; guidance for `codex_lb_auth_rejected` when transport known; optional metadata-only transport update command
- Center Swift: Active Provider badge, Credentials status/Connection Proof, error formatting, declutter
- Tests: routing-truth, desktop-controller, menubar template / Swift where applicable
- Version cut **8.1.1** (patch) after green gates

**Out**
- Fabricating success without a green connect-test against the real host
- Redesigning non-Providers tabs unless a dead control is clearly Providers-adjacent duplicate

## Files to inspect / edit (work)

1. `src/core/codex-lb/routing-truth.ts`
2. `src/core/codex-lb/desktop-controller.ts` (status guidance, connect-test blockers)
3. `src/core/codex-lb/codex-lb-env.ts` / setup — transport update without wiping host if already supported
4. `native/sks-menubar/Sources/ProvidersOpenRouter.swift` (`renderActiveProviderSummary`)
5. `native/sks-menubar/Sources/ProvidersViewController.swift` / `ProvidersConnectTest.swift` / `ProvidersReliability.swift`
6. `native/sks-menubar/Sources/ProvidersOpenRouter.swift` (`structuredPublicDetail` / `publicError`)
7. `src/core/codex-app/__tests__/sks-menubar-template.test.ts`
8. `src/core/codex-lb/__tests__/routing-truth.test.ts`, `desktop-controller.test.ts`
9. `CHANGELOG.md` / version bump via `sks versioning bump patch`

## Implementation steps ($sks-work)

### A. Auth classification + guidance (root)

1. When models/connect probe gets **401/403** and body/message matches Authorization-header missing (or equivalent), emit:
   - `codex_lb_gateway_auth_rejected_for_transport:<current>`
   - keep `http_status`, `auth_transport`, public gateway message (no secrets)
2. Ensure status `guidance` uses the existing transport-switch copy (bearer-compat ↔ custom-header).
3. Add Center action **“Fix gateway auth transport…”** (or fold into Reconnect):
   - If host+key already stored: choice sheet only → persist transport → re-run connect-test (prefer metadata update / `setup --gateway-auth …` without forcing domain re-entry when safe).
4. Do **not** auto-flip transport without operator confirmation (security/intent).

### B. Active Provider truth

Map modes explicitly:

| Condition | Badge |
|---|---|
| `cli-provider` + measured verified | `Codex LB · CLI · verified` |
| `cli-provider` + auth_rejected | `Codex LB · CLI · E-LB-AUTH-TRANSPORT (HTTP 401)` (or E-LB-AUTH) |
| `cli-provider` + other degraded | `Codex LB · CLI · degraded · <code>` |
| true `legacy_codex_lb_selected` / migration blocker | Legacy migration (keep) |
| desktop-native-bridge | existing Desktop Bridge copy |
| OpenRouter / Router / OAuth | existing |

Never use Legacy copy solely because `measuredRoute.selected == true`.

### C. Error codes + Connection Proof

Stable public codes (examples):

| Code | Meaning |
|---|---|
| `E-LB-AUTH-TRANSPORT` | 401/403 + wrong transport / Authorization missing |
| `E-LB-AUTH-KEY` | 401/403 after correct transport (bad/revoked key) |
| `E-LB-UNREACHABLE` | network / DNS / TLS |
| `E-LB-HTTP-<n>` | other HTTP |
| `E-LB-LEGACY-MIGRATE` | real legacy desktop config |

Status lines must include: **code · HTTP · transport · gateway message · Next: \<one CTA\>**.

Connection Proof on use-cli failure: stage 1 shows the **code + reason**, not only “failed / not run”.

### D. Providers UI declutter (8.1.1)

Remove or demote (default collapsed / Advanced disclosure):

1. **Authentication Recovery** card — duplicate of Credentials / OpenRouter / Open Codex sign-in row; keep single reconnect row on Credentials + OpenRouter only.
2. **“One-off command: codex”** detail line — low value; keep Copy CLI Command only.
3. **Provider Apply Stages** — hide until a mutation runs (or Diagnostics); do not occupy cold start.
4. **Latest Codex Feature Compatibility** matrix — keep behind Advanced / Verify Capabilities result only (not always-on wall).
5. **Advanced Desktop Bridge** card — keep but below fold / disclosure; primary path stays Credentials + Use Codex LB.
6. Fast / Role Models / OpenRouter — keep; no duplicate Fast On/Off elsewhere on this page.

Template tests must lock: no Authentication Recovery title on cold Providers page; Active Provider must not match Legacy string for cli-provider fixtures.

### E. Verify

- Unit: routing-truth 401 Authorization-missing → transport blocker; guidance lists bearer-compat.
- Template / Swift: badge + error format + declutter.
- Live (operator): after choosing Bearer on this host, `connect-test` returns ok (or honest E-LB-AUTH-KEY if key is wrong). Do not claim green without that probe.
- `sks versioning bump patch` → **8.1.1**; changelog; menubar install; release prep as for 8.1.0.

## Acceptance checks

- [ ] Screenshot-class state no longer shows Legacy migration when `desktop_mode` is `cli-provider`.
- [ ] Auth failure shows `E-LB-AUTH-TRANSPORT` (or AUTH-KEY) with HTTP 401, transport name, and Bearer/custom next action.
- [ ] Status guidance for this host recommends `--gateway-auth bearer-compat` (or Center Fix transport).
- [ ] Connection Proof explains the blocking stage with the same code.
- [ ] Authentication Recovery card and “One-off command” line gone from default Providers layout.
- [ ] Tests green; live connect-test evidence recorded as pass or explicit remaining key failure.
- [ ] Version **8.1.1** cut when work complete.

## Rollback

- Revert the 8.1.1 work commit(s); retag only if a bad tag was pushed (operator decision).
- Transport metadata changes are reversible by Reconnect with the other transport.

## Handoff

Run **`$sks-work`** against this plan after approval. Parent owns integration, live connect-test evidence, and 8.1.1 cut/publish prep.

## Planned vs implemented (final)

The implementation replaced the planned per-item transport diagnosis with a
stronger root-cause design — the **plane rule** — which removes the transport
ambiguity class entirely instead of diagnosing it:

| Planned | Implemented |
|---|---|
| Transport-specific blocker `codex_lb_gateway_auth_rejected_for_transport:` + Center “Fix gateway auth transport…” CTA | **Superseded.** CLI provider plane is structurally `Authorization: Bearer` (`env_key`); all probes of that plane (status, connect-test, doctor, capabilities, image) measure with Bearer unconditionally. No transport picker in Center; `setup` rejects `--gateway-auth custom-header` for `cli-only` fail-closed. Custom header remains a Desktop-Bridge-plane CLI escape only. |
| `E-LB-AUTH-TRANSPORT` / `E-LB-AUTH-KEY` distinction | **Simplified** to `E-LB-AUTH` + HTTP status + transport display (transport mismatch can no longer occur on the CLI plane). `E-OR-*` codes added so OpenRouter failures stop borrowing Codex LB codes/CTAs. |
| Active Provider badge truth table | **Done** — legacy migration badge only from true legacy markers; `Codex LB · CLI · verified` / `E-LB-AUTH · HTTP <n>` / `E-LB-DEGRADED`; proven state never downgraded by unrelated refreshes (single-writer decision ladder + proved flag). |
| Status guidance for 401 | **Done** — `codex_lb_auth_rejected` gets a credential-focused next action; unreachable gets a network-focused one. |
| Providers declutter | **Done** — Authentication Recovery card and one-off command line removed; Desktop Bridge / apply stages / capability matrix consolidated under **Advanced**; Advanced status line no longer claims “ChatGPT OAuth mode: active” while the CLI path routes. |
| Contract-shape convergence | **Done (beyond plan)** — every validator (desktop-controller, install-helpers, codex-app UI state, imagegen, provider-context, task runner, release-gate scripts) requires the single `env_key` shape; legacy `env_http_headers` is drift that repair rewrites. |
| 8.1.1 version cut | **Done** — version, changelog staged; publish prep pending operator release flow. |

Live connect-test evidence against the real gateway remains an operator step
before publish (Verify section E).
