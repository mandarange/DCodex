# Gate Script Map

Generated from `release-gates.v2.json`; release gate IDs and commands are the manifest SSOT.
This is a command inventory, not evidence that any command has run or that a
release is authorized. Current 8.1.3 classifications live in
`docs/internal/8.1.3-requirement-traceability.md` and
`docs/release-readiness.md`.

| Gate | Preset | Command | Package Script |
|---|---|---|---|
| `agent:message-bus-reader` | `release` | `node ./dist/scripts/agent-message-bus-reader-check.js` | direct |
| `all-features:deep-completion` | `release` | `node ./dist/scripts/all-feature-deep-completion-check.js` | direct |
| `appshots:thread-attachment-discovery` | `release` | `node ./dist/scripts/appshots-thread-attachment-discovery-check.js` | direct |
| `certificate:sla` | `release` | `node ./dist/scripts/certificate-sla-check.js` | direct |
| `codex-app:agent-role-comprehensive` | `release` | `node ./dist/scripts/codex-agent-type-routing-check.js && node ./dist/scripts/codex-agent-role-sync-check.js && node ./dist/scripts/codex-agent-role-rich-content-check.js` | direct |
| `codex-app:execution-profile` | `release` | `node ./dist/scripts/codex-app-execution-profile-check.js` | direct |
| `codex-app:fast-ui-preservation` | `release` | `node ./dist/scripts/codex-app-fast-ui-preservation-check.js` | direct |
| `codex-app:handoff` | `release` | `node ./dist/scripts/codex-app-handoff-check.js` | direct |
| `codex-control:all-pipelines` | `release` | `node ./dist/scripts/codex-control-all-pipelines-check.js` | direct |
| `codex-control:event-stream-ledger` | `release` | `node ./dist/scripts/codex-control-event-stream-ledger-check.js` | direct |
| `codex-native:agent-role-content` | `release` | `node ./dist/scripts/codex-native-agent-role-content-check.js` | direct |
| `codex-native:feature-broker-comprehensive` | `release` | `node ./dist/scripts/codex-native-feature-broker-check.js && node ./dist/scripts/codex-native-feature-broker-blackbox.js && node ./dist/scripts/codex-native-harness-compat-check.js` | direct |
| `codex-native:hook-lifecycle-proof` | `release` | `node ./dist/scripts/codex-native-hook-lifecycle-proof-check.js` | direct |
| `codex-plugin:app-template-policy` | `release` | `node ./dist/scripts/codex-plugin-app-template-policy-check.js` | direct |
| `codex-sdk:all-pipelines` | `release` | `node ./dist/scripts/codex-sdk-all-pipelines-check.js` | direct |
| `codex-sdk:integration-comprehensive` | `release` | `node ./dist/scripts/codex-sdk-backend-router-check.js && node ./dist/scripts/codex-sdk-capability-check.js && node ./dist/scripts/codex-sdk-event-stream-ledger-check.js` | direct |
| `codex:current:app-server-v2` | `release` | `node ./dist/scripts/codex-current-app-server-v2-check.js` | direct |
| `codex:current:binary-identity` | `release` | `node ./dist/scripts/codex-current-binary-identity-check.js` | direct |
| `codex:current:capability` | `release` | `node ./dist/scripts/codex-current-capability-check.js` | direct |
| `codex:current:dependency-graph` | `release` | `node ./dist/scripts/codex-current-dependency-check.js` | direct |
| `codex:current:policy` | `release` | `node ./dist/scripts/codex-current-policy-check.js` | direct |
| `codex:current:thread-store` | `release` | `node ./dist/scripts/codex-current-thread-store-check.js` | direct |
| `codex:app-handoff-comprehensive` | `release` | `node ./dist/scripts/codex-app-handoff-check.js && node ./dist/scripts/codex-app-handoff-launch-check.js && node ./dist/scripts/qa-loop-app-handoff-check.js && node ./dist/scripts/qa-loop-app-handoff-capability-check.js && node ./dist/scripts/qa-loop-app-handoff-cli-check.js && node ./dist/scripts/qa-loop-app-handoff-confirmation-check.js && node ./dist/scripts/qa-loop-app-handoff-gate-lifecycle-check.js && node ./dist/scripts/qa-loop-app-handoff-launch-check.js && node ./dist/scripts/qa-loop-app-handoff-status-lifecycle-check.js` | direct |
| `codex:product-design-plugin-routing` | `release` | `node ./dist/scripts/product-design-plugin-routing-check.js` | direct |
| `config:managed-merge` | `release` | `node ./dist/scripts/managed-config-merge-check.js` | direct |
| `context7:evidence-dedupe` | `release` | `node ./dist/scripts/context7-evidence-dedupe-check.js` | direct |
| `core-skill:card-schema-deployment-snapshot` | `release` | `node ./dist/scripts/core-skill-card-schema-check.js && node ./dist/scripts/core-skill-deployment-snapshot-check.js` | direct |
| `core-skill:heldout-validation` | `release` | `node ./dist/scripts/core-skill-heldout-validation-check.js` | direct |
| `core-skill:no-inference-optimizer` | `release` | `node ./dist/scripts/core-skill-no-inference-optimizer-check.js` | direct |
| `core-skill:patch` | `release` | `node ./dist/scripts/core-skill-patch-check.js && node ./dist/scripts/skills-manifest-continuity-check.js && node ./dist/scripts/uninstall-inventory-check.js` | direct |
| `core-skill:route-runtime-integration` | `release` | `node ./dist/scripts/core-skill-route-runtime-integration-check.js` | `core-skill:route-runtime-integration` |
| `dfix:fixture` | `release` | `node ./dist/scripts/dfix-fixture-check.js` | direct |
| `dfix:patch-handoff` | `release` | `node ./dist/scripts/dfix-patch-handoff-check.js` | direct |
| `dfix:verification` | `release` | `node ./dist/scripts/dfix-verification-check.js` | direct |
| `dfix:verification-recommendation` | `release` | `node ./dist/scripts/dfix-verification-recommendation-check.js` | direct |
| `desktop-bridge:comprehensive` | `release` | `node ./dist/scripts/desktop-bridge-unification-check.js && node ./dist/scripts/desktop-bridge-transport-check.js && node ./dist/scripts/desktop-bridge-latency-check.js && node ./dist/scripts/desktop-bridge-capabilities-check.js` | direct |
| `doctor:codex-app-harness` | `release` | `node ./dist/scripts/doctor-codex-app-harness-check.js` | direct |
| `doctor:fix-proves-codex-read` | `release` | `node ./dist/scripts/doctor-fix-proves-codex-read-check.js` | direct |
| `doctor:fixes-codex-app-fast-ui` | `release` | `node ./dist/scripts/doctor-fixes-codex-app-fast-ui-check.js` | direct |
| `fast:codex-service-tier-proof` | `release` | `node ./dist/scripts/fast-codex-service-tier-proof-check.js` | direct |
| `geo:comprehensive` | `release` | `node ./dist/scripts/geo-claim-evidence-check.js && node ./dist/scripts/geo-cli-blackbox-check.js && node ./dist/scripts/geo-crawler-policy-check.js` | direct |
| `git-collaboration:e2e` | `release` | `node --test test/e2e/git-*.test.mjs test/e2e/shared-triwiki-merge.test.mjs test/e2e/wrongness-shared-sync.test.mjs` | direct |
| `git:worktree-checkpoint-rebase-sync` | `release` | `node ./dist/scripts/git-worktree-checkpoint-check.js && node ./dist/scripts/git-worktree-cross-rebase-check.js` | direct |
| `git:worktree-diff-apply-pipeline` | `release` | `node ./dist/scripts/git-worktree-untracked-diff-check.js && node ./dist/scripts/git-worktree-integration-primary-check.js` | direct |
| `git:worktree-diff-envelope` | `release` | `node ./dist/scripts/git-worktree-diff-envelope-check.js` | direct |
| `git:worktree-dirty-lock` | `release` | `node ./dist/scripts/git-worktree-dirty-lock-check.js` | direct |
| `git:worktree-dirty-main-detection` | `release` | `node ./dist/scripts/git-worktree-dirty-main-detection-check.js` | direct |
| `git:worktree-manifest-append` | `release` | `node ./dist/scripts/git-worktree-manifest-append-check.js` | direct |
| `goal:artifact-compat` | `release` | `node ./dist/scripts/goal-artifact-compat-check.js` | direct |
| `hook:latency-budget` | `release` | `node ./dist/scripts/hook-latency-budget-check.js` | direct |
| `hooks:concurrent-session-collision` | `release` | `node ./dist/scripts/concurrent-session-collision-check.js` | direct |
| `image:artifact-path-contract` | `release` | `node ./dist/scripts/image-artifact-path-contract-check.js` | direct |
| `init-deep:backup-retention` | `release` | `node ./dist/scripts/init-deep-backup-retention-check.js` | direct |
| `migration:current-surface-e2e` | `release` | `node ./dist/scripts/current-surface-update-e2e-check.js` | direct |
| `gpt-final:all-pipelines-required` | `release` | `node ./dist/scripts/gpt-final-all-pipelines-check.js` | direct |
| `loop-integration-finalizer-check` | `release` | `node ./dist/scripts/loop-integration-finalizer-check.js` | direct |
| `mad-sks:app-ui-no-mutation` | `release` | `node ./dist/scripts/mad-sks-app-ui-no-mutation-check.js` | direct |
| `mad:preflight-blocks-unreadable-config` | `release` | `node ./dist/scripts/mad-preflight-blocks-unreadable-config-check.js` | direct |
| `mcp:plugin-inventory` | `release` | `node ./dist/scripts/mcp-plugin-inventory-check.js` | direct |
| `migration:upgrade-safety` | `release` | `node ./dist/scripts/current-upgrade-matrix-check.js` | `migration:upgrade-safety` |
| `model-call:concurrency` | `release` | `node ./dist/scripts/model-call-concurrency-check.js` | direct |
| `naruto:canonical-stop-gate` | `release` | `node ./dist/scripts/official-subagent-workflow-check.js` | direct |
| `naruto:worktree-coding:blackbox` | `release` | `node ./dist/scripts/naruto-worktree-coding-blackbox.js` | direct |
| `native-capability:repair-matrix` | `release` | `node ./dist/scripts/native-capability-repair-matrix-check.js` | direct |
| `native:image-generation-repair` | `release` | `node ./dist/scripts/native-image-generation-repair-check.js` | direct |
| `package:published-contract` | `release` | `node ./dist/scripts/package-published-contract-check.js` | direct |
| `pipeline:codex-native-routing-comprehensive` | `release` | `node ./dist/scripts/pipeline-codex-native-doctor-mad-routing-check.js && node ./dist/scripts/pipeline-codex-native-image-routing-check.js && node ./dist/scripts/pipeline-codex-native-loop-routing-check.js && node ./dist/scripts/pipeline-codex-native-qa-routing-check.js && node ./dist/scripts/pipeline-codex-native-research-routing-check.js` | direct |
| `policy:gate-audit` | `release` | `node ./dist/scripts/gate-policy-audit-check.js && node ./dist/scripts/cli-output-consistency-check.js && node ./dist/scripts/harness-benchmark-check.js` | direct |
| `ppt:full-e2e-blackbox` | `release` | `node ./dist/scripts/ppt-full-e2e-blackbox-check.js` | direct |
| `ppt:real-export-adapter` | `release` | `node ./dist/scripts/ppt-real-export-adapter-check.js` | direct |
| `ppt:real-imagegen-wiring` | `release` | `node ./dist/scripts/ppt-real-imagegen-wiring-check.js` | `ppt:real-imagegen-wiring` |
| `ppt:reexport-rereview` | `release` | `node ./dist/scripts/ppt-reexport-rereview-check.js` | direct |
| `probes:memoization` | `release` | `node ./dist/scripts/probe-memoization-check.js` | direct |
| `prompt:placeholder-guard` | `release` | `node ./dist/scripts/prompt-placeholder-guard-check.js` | direct |
| `proof:root-cause-policy` | `release` | `node ./dist/scripts/proof-root-cause-policy-check.js` | direct |
| `provider:badge-context` | `release` | `node ./dist/scripts/provider-badge-context-check.js` | direct |
| `publish:packlist-performance` | `release` | `node ./dist/scripts/packlist-performance-check.js` | `publish:packlist-performance` |
| `python-sdk:all-pipelines` | `release` | `node ./dist/scripts/python-codex-sdk-all-pipelines-check.js` | direct |
| `qa-loop:comprehensive-verification` | `release` | `node ./dist/scripts/qa-loop-budget-policy-check.js && node ./dist/scripts/qa-loop-effort-escalation-check.js && node ./dist/scripts/qa-loop-execution-profile-routing-check.js && node ./dist/scripts/qa-loop-image-path-exposure-check.js && node ./dist/scripts/qa-loop-image-path-prompt-injection-check.js` | direct |
| `release:aggressive-resource-governor` | `release` | `node ./dist/scripts/release-aggressive-resource-governor-check.js` | direct |
| `release:batch-runner-comprehensive` | `release` | `node ./dist/scripts/release-gate-batch-runner-check.js && node ./dist/scripts/release-full-parallelism-blackbox.js` | direct |
| `release:cache-key-comprehensive` | `release` | `node ./dist/scripts/release-cache-input-classifier-check.js && node ./dist/scripts/release-cache-glob-hashing-check.js && node ./dist/scripts/release-cache-version-neutral-fixture-check.js && node ./dist/scripts/release-cache-neutralization-report-check.js` | direct |
| `release:dag-runner` | `release` | `node ./dist/scripts/release-gate-dag-runner-check.js` | direct |
| `release:gate-selection-comprehensive` | `release` | `node ./dist/scripts/release-dynamic-presets-check.js && node ./dist/scripts/release-affected-selector-check.js` | direct |
| `release:parallel-speed-budget` | `release` | `node ./dist/scripts/release-parallel-speed-budget-check.js` | direct |
| `release:proof-truth` | `release` | `node ./dist/scripts/release-proof-truth-check.js` | direct |
| `release:provenance` | `release` | `node ./dist/scripts/release-provenance-check.js` | `release:provenance` |
| `release:runtime-truth-matrix` | `release` | `node ./dist/scripts/release-runtime-truth-matrix-check.js` | direct |
| `research:claim-builder-blueprint-comprehensive` | `release` | `node ./dist/scripts/research-claim-builder-check.js && node ./dist/scripts/research-blueprint-densifier-check.js` | direct |
| `research:complete-package-final-review-comprehensive` | `release` | `node ./dist/scripts/research-complete-package-fixture-check.js && node ./dist/scripts/research-final-reviewer-blackbox.js` | direct |
| `research:execution-profile-routing` | `release` | `node ./dist/scripts/research-execution-profile-routing-check.js` | direct |
| `responses:retry-policy-centralized` | `release` | `node ./dist/scripts/responses-retry-policy-centralized-check.js` | direct |
| `runtime:proof-summary` | `release` | `node ./dist/scripts/runtime-proof-summary-check.js` | direct |
| `safety:mutation-callsite-coverage` | `release` | `node ./dist/scripts/mutation-callsite-coverage-check.js` | direct |
| `scheduler:comprehensive` | `release` | `node ./dist/scripts/scheduler-batch-dispatch-check.js && node ./dist/scripts/scheduler-utilization-integral-check.js && node ./dist/scripts/scheduler-parallel-proof-consistency-check.js` | direct |
| `schema:check` | `release` | `node ./dist/scripts/check-runtime-schemas.js` | `schema:check` |
| `secret:preservation` | `release` | `node ./dist/scripts/secret-preservation-check.js` | direct |
| `seo-geo:route-identity-comprehensive` | `release` | `node ./dist/scripts/seo-geo-geo-disambiguation-check.js && node ./dist/scripts/seo-geo-route-identity-check.js` | direct |
| `seo-geo:skill-rich-content` | `release` | `node ./dist/scripts/seo-geo-skill-rich-content-check.js` | direct |
| `seo:comprehensive` | `release` | `node ./dist/scripts/seo-audit-fixture-check.js && node ./dist/scripts/seo-cli-blackbox-check.js && node ./dist/scripts/seo-no-mutation-by-default-check.js` | direct |
| `shared-memory:check` | `release` | `node ./dist/bin/sks.js wiki validate-shared --json \|\| node ./dist/scripts/shared-memory-fixture-check.js` | direct |
| `side-effect:runtime-report` | `release` | `node ./dist/scripts/side-effect-runtime-report-check.js` | direct |
| `skill:name-canonicalizer` | `release` | `node ./dist/scripts/skill-name-canonicalizer-check.js` | direct |
| `sksd:daemon` | `release` | `node ./dist/scripts/sksd-daemon-check.js` | direct |
| `super-search:provider-interface` | `release` | `node ./dist/scripts/super-search-provider-interface-check.js` | direct |
| `test:code-index-agent-bridge-regression` | `incremental` | `node --test --test-concurrency=1 dist/core/triwiki/__tests__/*.test.js dist/core/naruto/__tests__/*.test.js dist/core/agent-bridge/__tests__/*.test.js` | direct |
| `test:codex-runtime-recovery` | `incremental` | `node ./dist/scripts/codex-control-tool-output-continuity-audit-check.js && node --test --test-concurrency=1 dist/core/codex-control/__tests__/*.test.js dist/core/codex-lb/__tests__/*.test.js dist/core/codex/__tests__/*.test.js dist/core/hooks-runtime/__tests__/official-light-turn-hooks.test.js` | direct |
| `test:commands-regression` | `incremental` | `node --test --test-concurrency=1 dist/core/commands/__tests__/*.test.js dist/cli/__tests__/*.test.js` | direct |
| `test:core-root-regression` | `incremental` | `node --test --test-concurrency=1 dist/core/__tests__/*.test.js` | direct |
| `test:dfix-ppt-gate` | `incremental` | `node --test --test-concurrency=1 dist/core/dfix/__tests__/*.test.js dist/core/ppt/__tests__/*.test.js` | direct |
| `test:mad-sks-regression` | `incremental` | `node --test --test-concurrency=1 dist/core/mad-sks/__tests__/*.test.js` | direct |
| `test:menubar-doctor` | `incremental` | `node --test --test-concurrency=1 dist/core/codex-app/__tests__/*.test.js dist/core/doctor/__tests__/*.test.js` | direct |
| `test:official-subagent-policy` | `incremental` | `node --test --test-concurrency=1 dist/core/subagents/__tests__/official-subagent-config.test.js dist/core/subagents/__tests__/model-policy.test.js dist/core/subagents/__tests__/task-profile.test.js dist/core/subagents/__tests__/thread-budget-and-plan.test.js dist/core/subagents/__tests__/agent-catalog-fanout.test.js dist/core/subagents/__tests__/official-subagent-prompt.test.js dist/core/__tests__/naruto-route-reasoning.test.js dist/core/commands/__tests__/naruto-command-glm-block.test.js dist/cli/__tests__/router-active-naruto.test.js dist/core/release/__tests__/release-gate-affected-selector.test.js` | direct |
| `test:proof-stop-gate` | `incremental` | `node --test --test-concurrency=1 dist/core/proof/__tests__/*.test.js dist/core/stop-gate/__tests__/*.test.js` | direct |
| `test:triwiki-voxel-integrity` | `incremental` | `node --test --test-concurrency=1 dist/core/__tests__/triwiki-voxel-integrity.test.js` | direct |
| `triwiki:cache-key` | `release` | `node ./dist/scripts/triwiki-cache-key-check.js` | direct |
| `triwiki:proof-comprehensive` | `release` | `node ./dist/scripts/triwiki-proof-card-check.js && node ./dist/scripts/triwiki-proof-bank-check.js && node ./dist/scripts/triwiki-proof-bank-blackbox.js` | direct |
| `trust:check` | `release` | `node ./dist/scripts/trust-fixture-check.js` | direct |
| `type-surface:codex-app` | `release` | `node ./dist/scripts/type-surface-codex-app-check.js` | direct |
| `typecheck` | `release` | `node ./node_modules/typescript/bin/tsc -p tsconfig.json --noEmit` | `typecheck` |
| `ultra-router:auto-router` | `release` | `node ./dist/scripts/ultra-router-auto-router-check.js` | direct |
| `ux-review:extract-wires-real-extractor` | `release` | `node ./dist/scripts/ux-review-extract-wires-real-extractor-check.js` | direct |
| `ux-review:imagegen-blackbox` | `release` | `node ./dist/scripts/ux-review-imagegen-blackbox-check.js` | direct |
| `ux-review:patch-diff-recheck` | `release` | `node ./dist/scripts/ux-review-patch-diff-recheck-check.js` | direct |
| `ux-review:run-wires-imagegen` | `release` | `node ./dist/scripts/ux-review-run-wires-imagegen-check.js` | `ux-review:run-wires-imagegen` |
| `wrongness:check` | `release` | `node ./dist/bin/sks.js wrongness validate project --json && node ./dist/scripts/wrongness-fixture-check.js` | direct |

## 8.1.3 evidence interpretation

| Gate or command lane | Classification | Current boundary |
| --- | --- | --- |
| `desktop-bridge:comprehensive` and focused bridge/CLI/native checks | passed-hermetic | recorded artifacts are historical and must be rerun after final clean integration |
| `release:proof-truth`, `release:provenance`, `policy:gate-audit`, `typecheck`, package/pack checks | passed-hermetic | a previous result does not bind changed source or dist bytes |
| `npm run desktop-bridge:real-evidence` | not-run-real | the current artifact is fail-closed as `real_required_missing`, not a live pass |
| macOS lifecycle, Codex Desktop UI, OAuth, providers, WebSocket, and deep capability receipts | not-run-real | each requires a redacted, target-bound artifact |
| fresh final stamp, GitHub main/tag, npm-owner/stage/2FA action | blocked-external | requires a final clean source binding and separately authorized external action |

The user override removes public legacy runtime/alias paths: `sks codex-lb`
is unknown rather than a deprecated alias. The unified Desktop Bridge gate
therefore intentionally does not invoke the removed legacy catalog-passthrough
check.

The staged-tarball verifier is a maintainer-local read-only command, not a
manifest gate:

```sh
node ./dist/scripts/npm-stage-tarball-verifier.js \
  --stage-id <stage-id> \
  --dispatch-nonce <32-lowercase-hex> \
  --physical-evidence-run-id <physical-capture-workflow-run-id> \
  --workflow-run-id <stage-workflow-run-id> \
  --local-receipt /absolute/path/to/local-pack-receipt.json \
  --local-tarball /absolute/path/to/sneakoscope-8.1.3.tgz \
  --stage-receipt /absolute/path/to/npm-stage-receipt.json
```
