# Paseo Companion and Telegram Removal Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use the repository's SKS Naruto official-subagent workflow. Follow TDD for behavior changes and keep the two write scopes below disjoint.

**Goal:** Remove the first-party Telegram integration, add a safe Paseo workspace contract and official recommendation, and prepare version 8.3.0 for release verification without publishing.

**Architecture:** The runtime slice deletes Telegram-owned CLI, Doctor, native, feature, and release-gate paths while retaining only historical or retired-migration evidence. The companion/release slice adds a declarative `paseo.json`, updates user-facing guidance, and advances every current version authority to 8.3.0. The parent integrates and runs the release gates.

**Tech Stack:** TypeScript/Node.js, Swift menu-bar sources, Rust crate metadata, npm release tooling, Paseo `paseo.json`.

## Global Constraints

- Paseo is an external recommended companion, not a bundled dependency or runtime wrapper.
- `sks telegram` must be absent from the current command surface.
- Preserve historical changelog entries and guarded retired-bridge migrations.
- Use `npm ci --ignore-scripts` in Paseo worktree setup.
- Set the release version to exactly `8.3.0`.
- Do not publish npm, create tags, push, dispatch workflows, revoke tokens, or run `sks doctor --fix`.
- Preserve unrelated user-authored changes.

---

### Task 1: Remove the Active Telegram Runtime

**Files:**

- Create: `test/unit/removed-telegram-surface.test.mjs`
- Delete: `src/core/telegram/**`
- Delete: `src/core/commands/telegram-command.ts`
- Delete: active Telegram-only TypeScript, Swift, and test files discovered by `rg -l -i telegram`
- Modify: `src/cli/command-registry.ts`, `src/cli/command-manifest-lite.ts`, `src/commands/doctor.ts`
- Modify: `src/core/codex-app/**`, `src/core/feature-registry.ts`, `src/core/feature-fixtures.ts`
- Modify: `native/sks-menubar/Sources/**`, `native/sks-menubar/Tests/**`
- Modify: `src/core/release/**`, `src/scripts/**`, `release-gates.v2.json`, `runtime-required-scripts.json`, `safety-mutation-allowlist.json`, `.github/workflows/**`

**Interfaces:**

- Consumes: the current CLI registry, Doctor result, menu-bar source manifest, feature registry, and release-gate manifests.
- Produces: a buildable product in which Telegram is not a command, readiness signal, resident poller, native settings page, package requirement, or release-evidence requirement.

- [ ] **Step 1: Write the failing removal regression test**

  Exercise the built CLI in a hermetic home. Assert that `sks telegram status
  --json` follows the ordinary unknown-command path, `sks doctor --json` has no
  `telegram_remote` result, and the public feature inventory has no Telegram
  transport. Extend the packed-artifact contract so a release tarball cannot
  reintroduce a Telegram runtime. Keep native compilation and installer tests
  as the consumer-level proof for the menu-bar source set.

- [ ] **Step 2: Run the test and confirm RED**

  Run: `node --test --test-concurrency=1 test/unit/removed-telegram-surface.test.mjs`

  Expected: FAIL because the current command, Doctor field, feature, and packed
  runtime still exist.

- [ ] **Step 3: Remove the minimal active runtime and its obsolete tests**

  Delete Telegram-owned modules and registrations, then remove their callers
  from Doctor, native app construction, readiness, feature, package, workflow,
  and release proof paths. Replace the native Remote Coding controller with a
  static accessible Paseo recommendation linking to `https://paseo.sh/` and
  its docs, while explicitly keeping Paseo independent. Do not delete or
  weaken unrelated remote-worker, Codex session, security, or retired-migration
  behavior.

- [ ] **Step 4: Run GREEN checks**

  Run:

  ```sh
  npm run build:clean
  node --test --test-concurrency=1 test/unit/removed-telegram-surface.test.mjs
  node --test --test-concurrency=1 dist/cli/__tests__/command-help-contract.test.js
  ```

  Expected: all commands exit 0 with no Telegram compile or manifest reference.

---

### Task 2: Add Paseo Compatibility and Prepare 8.3.0

**Files:**

- Create: `paseo.json`
- Modify: `README.md`, `CHANGELOG.md`, `docs/release-readiness.md`, `docs/release-proof-truth.md`
- Modify: `docs/PERFORMANCE.md`, `docs/AGENT-BRIDGE.md`
- Modify: `package.json`, `package-lock.json`, `crates/sks-core/Cargo.toml`, `crates/sks-core/Cargo.lock`, `src/core/version.ts`
- Modify: `plugins/sks/.codex-plugin/plugin.json`

**Interfaces:**

- Consumes: Paseo's documented repository configuration and existing npm build/test/release scripts.
- Produces: a valid root `paseo.json`, current Paseo onboarding guidance, and synchronized 8.3.0 release metadata.

- [ ] **Step 1: Record the failing Paseo artifact checks**

  Run `jq -e . paseo.json` and the repository's release metadata check before
  creating or changing those artifacts. Record the expected failures: missing
  `paseo.json` and current version `8.2.2` instead of `8.3.0`. Human README
  guidance is reviewed against the official Paseo docs, not asserted as source
  text in an automated test.

- [ ] **Step 2: Run the test and confirm RED**

  Run:

  ```sh
  jq -e . paseo.json
  npm run release:version-truth
  ```

  Expected: the first command fails because the file is absent; version truth
  reports the current 8.2.2 state before the bump.

- [ ] **Step 3: Add the declarative Paseo surface**

  Create `paseo.json` with setup, build, typecheck, test, affected-release, and
  confidence-release commands only. Replace the active Telegram README section
  with Paseo desktop/headless/Codex/worktree usage, clearly marking Paseo as an
  independent project and linking its official docs.

- [ ] **Step 4: Advance current release truth to 8.3.0**

  Update package, lockfile, Rust, runtime constant, current docs, and changelog.
  Rewrite the release-readiness and proof documents so they require no Telegram
  credential or cellular round trip and instead verify the removed surface and
  Paseo project contract. Keep registry publication operator-owned.

- [ ] **Step 5: Run GREEN checks**

  Run:

  ```sh
  jq -e . paseo.json
  node -e "const p=require('./package.json'),c=require('./paseo.json'); for (const row of Object.values(c.scripts)) { const name=row.command.replace(/^npm run /,''); if (!p.scripts[name]) throw new Error('missing package script: '+name) }"
  git diff --check -- paseo.json README.md CHANGELOG.md docs package.json package-lock.json crates/sks-core src/core/version.ts
  ```

  Expected: all commands exit 0. The parent performs the build-dependent
  version, docs, and release checks after the parallel write wave settles.

---

### Task 3: Parent Integration and Release Readiness

**Files:**

- Inspect: every changed file from Tasks 1 and 2
- Refresh: `.sneakoscope/wiki/context-pack.json` and generated navigation evidence through the repository's canonical wiki commands

**Interfaces:**

- Consumes: both disjoint task results.
- Produces: one integrated 8.3.0 candidate with current test, package, and SKS route evidence.

- [ ] **Step 1: Review the integrated diff and residual inventory**

  Run `git diff --check`, inspect `git diff --stat`, and use bounded `rg` checks
  to distinguish allowed historical/retired-migration Telegram references from
  prohibited current runtime, docs, and release references.

- [ ] **Step 2: Run focused and change-aware gates**

  Run:

  ```sh
  npm run typecheck
  npm run build:clean
  node --test --test-concurrency=1 test/unit/removed-telegram-surface.test.mjs
  npm run release:metadata
  npm run release:version-truth
  npm run release:check:affected
  npm run release:check:confidence
  npm pack --dry-run --ignore-scripts --json
  ```

  Expected: all hermetic commands exit 0. If a real-host gate is selected, its
  missing external evidence must remain an explicit blocker rather than being
  converted into a pass.

- [ ] **Step 3: Refresh and validate TriWiki, then run reflection**

  Run the canonical `sks wiki refresh`, pack/validation command required by the
  current CLI, then the mission reflection gate. Record any external or
  operator-owned gaps without expanding scope.

- [ ] **Step 4: Commit Naruto parent evidence**

  Submit the strict parent summary for mission `M-20260807-151744-0432`, listing
  both official thread outcomes, changed files, passed checks, and any blockers.
