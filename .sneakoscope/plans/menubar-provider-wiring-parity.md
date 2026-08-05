# Plan: Menu Bar provider wiring / copy / inventory parity sweep

```yaml
slug: menubar-provider-wiring-parity
route: $sks-plan
implementation_allowed: true  # executed via follow-on work; do not re-plan
handoff: $sks-work
created: 2026-08-05
status: implemented-pending-release
```

## Goal

Find every Control Center / Menu Bar case in the same failure class as the fixed **Use Codex LB** bug (label / inventory / status copy promises one backend, code or guidance points at another), then make label → selector → argv → status surface → reliability catalog → contract tests consistent end-to-end.

**Done when:** no provider primary control or status CTA steers the user to the wrong mode button; reliability `backend` strings match real `processClient.run` / `perform*` argv; template + Swift inventory tests lock the correct mappings; product source remains unchanged until `$sks-work`.

**Non-goals:** Codex LB 401 auth, Telegram cellular gates, npm OTP/publish, physical release receipts, redesign of provider UX, inventing new routing modes.

## Problem class (reference case)

Already fixed (keep; do not regress):

| Surface | Was wrong | Correct |
|---|---|---|
| Button `Use Codex LB` | `performDesktopRouting(... use-desktop-full ...)` → Desktop card only | `performCliCommand(... use-cli ...)` → Credentials / Connection Proof |
| Inventory `sks-provider-activate-codex-lb` | backend `use-desktop-full` | backend `use-cli` |
| Template test | forbade `use-cli` on that button | requires `use-cli` |

## Findings from inspection (read-only)

### A. High — Desktop status copy still names the wrong button

File: `native/sks-menubar/Sources/ProvidersViewController.swift` (`describeDesktopStatus`)

When Desktop routing is disabled / not enabled, copy says **“Choose Use Codex LB to switch.”** After the CLI fix, **Use Codex LB** means `sks codex-lb use-cli` (CLI provider path). Enabling Desktop bridge is **Desktop Bridge Mode (keeps ChatGPT sign-in)** → `use-desktop-full`.

Affected strings (same class as the dead-button bug: user follows CTA → wrong mode / wrong status surface):

- Legacy destructive: “choose Use Codex LB for migration guidance…”
- `desktop-native-bridge` + missing OAuth: “then Use Codex LB”
- `disabled` + OAuth present: “Choose Use Codex LB to switch.”
- Fallback + OAuth present: “Choose Use Codex LB to switch.”
- Fallback + missing OAuth: “then Use Codex LB if needed.”

**Intended copy direction (implementation):** point Desktop-mode CTAs at **Desktop Bridge Mode…** (or “Advanced · Desktop Bridge”), and CLI-only CTAs at **Use Codex LB** / **Reconnect Codex LB credential…** / **Run Connect Test** as appropriate.

### B. Medium — CLI status CTA names a retired button

Same file (`describeCliStatus`): “choose **Configure / Update…**” but the live button is **Reconnect Codex LB credential…**. Docs (`docs/codex-lb.md`) still mention Configure / Update for Center transport prompt — treat as related copy drift in scope if touched for consistency.

### C. Medium — Reliability catalog backends drift from real argv

File: `native/sks-menubar/Sources/ProvidersReliability.swift` vs actual Swift callers:

| Inventory id | Catalog `backend` (stale) | Actual argv |
|---|---|---|
| `sks-provider-reconnect-openrouter` / `…-save-openrouter-key` | `sks codex-app save-openrouter-key` | `codex-app set-openrouter-key` |
| `sks-provider-test-openrouter` | `sks codex-app test-openrouter` | `codex-app openrouter-test` |
| `sks-provider-restore-previous` | `sks codex-app restore-provider` | `codex-app restore-desktop-routing` |

Handlers and OpenRouter/MultiProvider `processClient.run` paths for activate/router look correct; inventory text is the lie.

### D. Medium — Misleading inventory id for Desktop Bridge

- `sks-provider-use-codex-lb` is registered on **Desktop Bridge Mode** → `enableDesktopFull` / `use-desktop-full`
- Real **Use Codex LB** is `sks-provider-activate-codex-lb` → `useCliProvider` / `use-cli`

Id naming invites the same wiring mistake again. Rename Desktop inventory id (e.g. `sks-provider-desktop-bridge-mode`) and update Swift tests + any string consumers. Keep activate id or rename to `sks-provider-use-codex-lb` only if a single rename pass can do it without breaking external receipts — prefer rename Desktop id + leave activate id stable unless grep shows no external dependency.

### E. Low / already OK (verify only under $sks-work)

- OpenRouter activate / restore / multi-provider router: status updates target `openRouterStatus` / `multiProvider.status` (not Desktop `providerStatus`).
- Fast On/Off, MCP, Overview navigation: no label→wrong-mode evidence found in this pass.
- Template test already requires Use Codex LB → `use-cli` and Desktop Bridge → `use-desktop-full`.

## Scope

**In**

- `native/sks-menubar/Sources/ProvidersViewController.swift` — desktop/CLI status CTAs
- `native/sks-menubar/Sources/ProvidersReliability.swift` — inventory backends + Desktop action id
- `native/sks-menubar/Tests/ProvidersViewControllerTests.swift` — required inventory ids
- `src/core/codex-app/__tests__/sks-menubar-template.test.ts` — wiring + copy + catalog parity assertions
- Optional tight docs touch: `docs/codex-lb.md` Configure / Update → Reconnect wording if still claiming Center button title

**Out**

- Auth/key configuration, LB connect-test product behavior
- Unrelated menubar sections without mismatch evidence
- Commits/publish (user-requested later)

## Files to inspect at implementation time

1. `ProvidersViewController.swift` — all user-facing “Use Codex LB” / “Configure” strings outside the primary button title
2. `ProvidersReliability.swift` — full `ProviderActionInventory.items` vs every `registerProviderAction` + argv
3. `ProvidersOpenRouter.swift`, `ProvidersMultiProvider.swift`, `ProvidersConnectTest.swift`, `ProvidersRoleModels.swift` — argv vs inventory
4. `sks-menubar-template.test.ts` — add negative tests that catch Desktop CTA → CLI button confusion
5. `ProvidersViewControllerTests.swift` — inventory id list
6. Grep repo for `sks-provider-use-codex-lb`, `save-openrouter-key`, `test-openrouter`, `restore-provider`, `Configure / Update`

## Implementation steps (for $sks-work only)

1. **Inventory matrix** — build a table in the work notes (or test): button title → `#selector` → argv → status label field → inventory id/backend. Fail any row that disagrees.
2. **Fix A** — rewrite `describeDesktopStatus` CTAs to name Desktop Bridge / ChatGPT OAuth buttons correctly; never tell users to press Use Codex LB when the intended mode is `desktop-native-bridge`.
3. **Fix B** — rewrite `describeCliStatus` CTAs to **Reconnect Codex LB credential…** / **Run Connect Test** / **Use Codex LB** as appropriate.
4. **Fix C** — align OpenRouter/restore inventory `backend` strings with real CLI actions (`set-openrouter-key`, `openrouter-test`, `restore-desktop-routing`).
5. **Fix D** — rename misleading Desktop inventory id; update Swift required-id list and any register site.
6. **Tests**
   - Template: Desktop status copy must not instruct “Choose Use Codex LB to switch” for Desktop bridge enablement; must mention Desktop Bridge Mode (or equivalent exact title).
   - Template: reliability catalog backends for OpenRouter/restore must match argv literals used in Sources.
   - Keep existing Use Codex LB → `use-cli` / Desktop → `use-desktop-full` assertions.
7. **Verify** — `node --test src/core/codex-app/__tests__/sks-menubar-template.test.ts`; Swift package tests if runnable; `sks menubar install` + restart only if user wants live UI check.
8. **Honest Mode** — no claim that auth/connect-test works; only wiring/copy/inventory parity.

## Acceptance checks

- [ ] No Desktop-mode status string tells the user to press **Use Codex LB** to enable Desktop bridge.
- [ ] CLI incomplete/not-configured status names the live reconnect / test / use-cli controls.
- [ ] Every `ProviderActionInventory` OpenRouter/restore backend matches Source argv.
- [ ] Desktop Bridge inventory id is not named like “use Codex LB” unless it truly calls `use-cli`.
- [ ] Template + Swift inventory tests green; prior Use Codex LB wiring tests still green.
- [ ] `implementation_allowed` remains false until `$sks-work`; this plan file is the only artifact written by `$sks-plan`.

## Rollback

- Revert the single work commit / patch that touches the Swift Sources + template/Swift tests (+ optional docs line).
- No schema/migration/data changes expected.
- Installed Menu Bar app: re-run prior `sks menubar install` from last known-good tree if a bad install was applied during work.

## Handoff

After user approval: run **`$sks-work`** against this plan (`menubar-provider-wiring-parity`). Do not nest planning inside work. Parent owns verification and final answer.

## Planned vs unimplemented

| Item | State |
|---|---|
| Plan artifact | **Done** (this file) |
| Source/copy/inventory fixes | **Done** in working tree for 8.1.0 |
| Contract/Swift test updates | **Done** (menubar template 30/30) |
| Menubar rebuild / live UI proof | Pending install after release prep |
| Auth / connect-test / publish | **Out of scope** until operator OTP / physical gates |
