# SKS Feature Inventory

Generated from `sks commands --json`, `src/cli/command-registry.ts COMMANDS`, `src/core/routes.js`, docs, and skill manifests.

## Coverage

- Status: coverage-ok
- Features: 137
- CLI commands: 100
- Handler keys: 100
- Dollar routes: 31
- App skill aliases: 34
- Skills: 1
- Fixture statuses: pass=127, blocked=10
- Feature quality: runtime_verified=95, wiring_only=19, integration_optional=6, static_contract=17, missing=0

## Release Coverage Rule

`sks features check --json` fails when a CLI command, hidden handler, dollar route, app skill alias, or project skill is not mapped to the feature registry. `npm run release:check` runs that check.

## Stable / Beta / Labs Map

| Feature | Category | Maturity | Commands / Routes | Fixture | Quality | Known Gaps |
| --- | --- | --- | --- | --- | --- | --- |
| `cli-help` | core-cli | stable | sks help [topic] | execute:pass | runtime_verified | none recorded |
| `cli-version` | core-cli | stable | sks version \| sks --version | execute:pass | runtime_verified | none recorded |
| `cli-commands` | core-cli | stable | sks commands [--json] | execute:pass | runtime_verified | none recorded |
| `cli-check` | core-cli | stable | sks check --tier instant\|affected\|confidence\|release\|real-check [--sla 5m] [--changed-since auto] [--json] | execute:pass | runtime_verified | none recorded |
| `cli-gates` | core-cli | stable | sks gates | static:pass | static_contract | none recorded |
| `cli-task` | core-cli | stable | sks task run [--sla 5m] [--json] | execute:pass | runtime_verified | none recorded |
| `cli-release` | core-cli | stable | sks release affected\|full\|background [--json] | execute:blocked | runtime_verified | none recorded |
| `cli-triwiki` | core-cli | stable | sks triwiki index\|affected\|proof-bank [--json] | execute:pass | runtime_verified | none recorded |
| `cli-daemon` | core-cli | stable | sks daemon status\|warm\|stop [--json] | execute:pass | runtime_verified | none recorded |
| `cli-run` | core-cli | beta | sks run "task" [--visual\|--research\|--db] [--json] | execute_and_validate_artifacts:blocked | runtime_verified | none recorded |
| `cli-plan` | core-cli | stable | sks plan "task" [--json] | execute:pass | runtime_verified | none recorded |
| `cli-status` | core-cli | stable | sks status [--json] | execute:pass | runtime_verified | none recorded |
| `cli-review` | core-cli | stable | sks review [--staged\|--diff <ref>] [--fix] [--json] | execute:pass | runtime_verified | none recorded |
| `cli-root` | core-cli | stable | sks root [--json] | execute:pass | runtime_verified | none recorded |
| `cli-update` | core-cli | stable | sks update status\|check\|review\|now\|rollback [--refresh] [--version <version>] [--json] [--dry-run] | execute:pass | runtime_verified | none recorded |
| `cli-uninstall` | core-cli | stable | sks uninstall [--dry-run] [--yes] [--keep-config] [--keep-data] [--purge-projects] [--json] | execute:pass | runtime_verified | none recorded |
| `cli-update-check` | core-cli | stable | sks update-check [--json] | static:pass | static_contract | none recorded |
| `cli-mcp` | core-cli | beta | sks mcp config list\|get\|add\|edit\|duplicate\|enable\|disable\|remove\|test\|login\|logout\|backups\|restore [--scope global\|project\|effective] [--stdin-json] [--json] | execute:pass | runtime_verified | none recorded |
| `cli-wizard` | core-cli | stable | sks wizard | execute:pass | runtime_verified | none recorded |
| `cli-usage` | core-cli | stable | sks usage [install\|setup\|bootstrap\|root\|deps\|auto-review\|naruto\|qa-loop\|ppt\|image-ux-review\|computer-use\|goal\|fast-mode\|review\|research\|seo-geo-optimizer\|git\|codex\|codex-app\|codex-native\|hooks\|features\|all-features\|dfix\|commit\|commit-and-push\|design\|imagegen\|dollar\|context7\|super-search\|pipeline\|reasoning\|guard\|conflicts\|versioning\|eval\|harness\|hproof\|gx\|wiki\|memory\|wrongness\|code-structure\|proof-field\|skill-dream\|rust] | execute:pass | runtime_verified | none recorded |
| `cli-quickstart` | core-cli | stable | sks quickstart | execute:pass | runtime_verified | none recorded |
| `cli-setup` | install | stable | sks setup [--bootstrap] [--install-scope global\|project] [--local-only] [--force] [--json] | real_optional:pass | integration_optional | none recorded |
| `cli-bootstrap` | install | stable | sks bootstrap [--install-scope global\|project] [--local-only] [--json] | execute:pass | runtime_verified | none recorded |
| `cli-init` | install | stable | sks init [--force] [--local-only] [--install-scope global\|project] | execute:pass | runtime_verified | none recorded |
| `cli-deps` | install | stable | sks deps check [--json] [--yes] | execute:pass | runtime_verified | none recorded |
| `cli-fix-path` | install | stable | sks fix-path [--install-scope global\|project] [--json] | execute:pass | runtime_verified | none recorded |
| `cli-doctor` | install | stable | sks doctor [--fix] [--local-only] [--json] [--install-scope global\|project] | execute:pass | runtime_verified | none recorded |
| `cli-git` | core-cli | beta | sks git policy\|install\|status\|doctor\|precommit\|publish-plan\|summary [--json] | execute:pass | runtime_verified | none recorded |
| `cli-paths` | core-cli | beta | sks paths managed [--json] | execute_and_validate_artifacts:pass | runtime_verified | none recorded |
| `cli-rollback` | core-cli | beta | sks rollback list\|apply <id> [--json] | execute:pass | runtime_verified | none recorded |
| `cli-postinstall` | install | stable | sks postinstall | execute_and_validate_artifacts:pass | runtime_verified | default lifecycle is package-local only; external bootstrap requires `SKS_POSTINSTALL_BOOTSTRAP=1` |
| `cli-codex` | integration | beta | sks codex compatibility\|version\|update-status [--refresh]\|update\|doctor\|schema\|0.144 [--json] | execute:pass | runtime_verified | none recorded |
| `cli-codex-app` | integration | beta | sks codex-app [check\|set-openrouter-key --api-key-stdin\|use-openrouter --model <id>\|product-design\|chrome-extension\|pat status\|remote-control] | real_optional:pass | integration_optional | mobile/event payload details remain unknown |
| `cli-codex-native` | integration | beta | sks codex-native status\|feature-broker\|invocation-plan\|init-deep [--json] | execute:pass | runtime_verified | none recorded |
| `cli-codex-lb` | integration | beta | sks codex-lb status\|health\|metrics\|doctor\|circuit\|repair\|setup ... | execute_and_validate_artifacts:pass | runtime_verified | none recorded |
| `cli-menubar` | core-cli | beta | sks menubar | static:pass | static_contract | none recorded |
| `cli-remote` | core-cli | beta | sks remote readiness\|machines\|worker ... [--json] | real_optional:pass | integration_optional | none recorded |
| `cli-hooks` | integration | beta | sks hooks explain\|status\|trust-report\|replay\|codex-validate\|warning-check ... [--json]<br>sks hook | execute:pass | runtime_verified | mobile/event payload details remain unknown |
| `cli-mad-sks` | core-cli | beta | sks mad-sks plan\|run\|apply\|sql\|apply-migration\|status\|close\|rollback-apply ... \| sks --mad [--high] | static:pass | static_contract | none recorded |
| `cli-auto-review` | core-cli | beta | sks auto-review status\|enable\|start [--high] \| sks --Auto-review --high | execute:pass | runtime_verified | none recorded |
| `cli-dollar-commands` | core-cli | stable | sks dollar-commands [--json] | execute:pass | runtime_verified | none recorded |
| `cli-fast-mode` | core-cli | stable | sks fast-mode on\|off\|status\|clear [--project] [--json] | execute:pass | runtime_verified | none recorded |
| `cli-commit` | core-cli | stable | sks commit [--message "msg"] [--json] | mock:pass | wiring_only | none recorded |
| `cli-commit-and-push` | core-cli | stable | sks commit-and-push [--message "msg"] [--json] | mock:pass | wiring_only | none recorded |
| `cli-dfix` | core-cli | stable | sks dfix | execute_and_validate_artifacts:pass | runtime_verified | none recorded |
| `cli-with-local-llm` | core-cli | beta | sks with-local-llm on\|off\|status\|set-model [--json] | execute:pass | runtime_verified | none recorded |
| `cli-naruto` | proof-route | labs | sks naruto run "task" [--agents N] [--max-threads N] [--trusted-project] [--json] \| sks naruto status\|subagents\|proof [latest\|M-...] [--json] | execute_and_validate_artifacts:pass | runtime_verified | none recorded |
| `cli-stop-gate` | core-cli | beta | sks stop-gate | static:pass | static_contract | none recorded |
| `cli-route` | core-cli | beta | sks route | static:pass | static_contract | none recorded |
| `cli-loop` | core-cli | labs | sks loop | static:pass | static_contract | none recorded |
| `cli-qa-loop` | loop | beta | sks qa-loop prepare\|answer\|run\|status ... | execute_and_validate_artifacts:pass | runtime_verified | none recorded |
| `cli-research` | loop | labs | sks research prepare\|run\|status ... | execute_and_validate_artifacts:blocked | runtime_verified | none recorded |
| `cli-autoresearch` | core-cli | labs | sks autoresearch | static:pass | static_contract | none recorded |
| `cli-ppt` | visual-memory | labs | sks ppt build\|status <mission-id\|latest> [--json] | mock:pass | wiring_only | none recorded |
| `cli-image-ux-review` | visual-memory | labs | sks ux-review run --image <path> --fix --json \| sks image-ux-review status <mission-id\|latest> [--json] | execute_and_validate_artifacts:blocked | runtime_verified | none recorded |
| `cli-computer-use` | integration | beta | sks computer-use import\|status\|smoke\|require ... [--json] | real_optional:pass | integration_optional | none recorded |
| `cli-context7` | integration | beta | sks context7 check\|setup\|tools\|resolve\|docs\|evidence ... | real_optional:pass | integration_optional | none recorded |
| `cli-super-search` | core-cli | beta | sks super-search doctor\|run\|x\|fetch\|status\|inspect\|sources\|claims\|cache\|bench | execute:pass | runtime_verified | none recorded |
| `cli-recallpulse` | loop | labs | sks recallpulse run\|status\|eval\|governance\|checklist <mission-id\|latest> | execute_and_validate_artifacts:pass | runtime_verified | none recorded |
| `cli-pipeline` | proof-route | beta | sks pipeline status\|resume\|plan\|answer ... | execute_and_validate_artifacts:pass | runtime_verified | none recorded |
| `cli-guard` | safety | beta | sks guard check [--json] | execute:pass | runtime_verified | none recorded |
| `cli-conflicts` | safety | beta | sks conflicts check\|prompt [--json] | execute:pass | runtime_verified | none recorded |
| `cli-versioning` | safety | stable | sks versioning status\|bump\|disable [--json] | execute:pass | runtime_verified | none recorded |
| `cli-reasoning` | core-cli | labs | sks reasoning ["prompt"] [--json] | execute:pass | runtime_verified | none recorded |
| `cli-aliases` | core-cli | stable | sks aliases | execute:pass | runtime_verified | none recorded |
| `cli-selftest` | core-cli | stable | sks selftest [--mock] | execute:pass | runtime_verified | none recorded |
| `cli-goal` | core-cli | beta | sks goal create\|edit\|pause\|resume\|clear\|status ... | execute:pass | runtime_verified | stateless Codex-native command renderer; no SKS Goal artifacts |
| `cli-seo-geo-optimizer` | core-cli | beta | sks seo-geo-optimizer [seo\|geo] doctor\|audit\|research\|strategy\|plan\|apply\|verify\|status\|rollback\|fixture [mission\|latest] [--mode seo\|geo] [--target auto\|website\|docs\|package] [--include-marketing] [--json] | execute_and_validate_artifacts:pass | runtime_verified | none recorded |
| `cli-hook` | core-cli | beta | sks hook | static:pass | static_contract | none recorded |
| `cli-profile` | core-cli | labs | sks profile show\|set <model> | execute:pass | runtime_verified | none recorded |
| `cli-hproof` | proof-route | beta | sks hproof check [mission-id\|latest] | execute_and_validate_artifacts:pass | runtime_verified | none recorded |
| `cli-validate-artifacts` | proof-route | beta | sks validate-artifacts [mission-id\|latest] [--json] | execute_and_validate_artifacts:pass | runtime_verified | none recorded |
| `cli-proof` | core-cli | beta | sks proof show\|latest\|validate\|export\|smoke [--json\|--md] | execute_and_validate_artifacts:pass | runtime_verified | none recorded |
| `cli-trust` | core-cli | beta | sks trust report\|validate\|status\|explain [latest\|mission-id] [--json] | execute_and_validate_artifacts:pass | runtime_verified | none recorded |
| `cli-wrongness` | visual-memory | beta | sks wrongness list\|show\|add\|resolve\|summarize\|validate\|context\|rules ... | execute_and_validate_artifacts:pass | runtime_verified | none recorded |
| `cli-proof-field` | proof-route | beta | sks proof-field scan [--json] [--intent "task"] [--changed file1,file2] | execute:pass | runtime_verified | none recorded |
| `cli-skill-dream` | loop | labs | sks skill-dream status\|run\|record [--json] | execute:pass | runtime_verified | none recorded |
| `cli-code-structure` | core-cli | labs | sks code-structure scan [--json] | execute:pass | runtime_verified | none recorded |
| `cli-rust` | core-cli | beta | sks rust status\|smoke [--json] [--require-native] | execute:pass | runtime_verified | none recorded |
| `cli-gx` | visual-memory | labs | sks gx init\|render\|validate\|drift\|snapshot [name] | execute_and_validate_artifacts:blocked | runtime_verified | none recorded |
| `cli-eval` | loop | labs | sks eval run\|compare\|thresholds ... | execute:pass | runtime_verified | none recorded |
| `cli-harness` | safety | labs | sks harness fixture\|review [--json] | execute:pass | runtime_verified | none recorded |
| `cli-wiki` | visual-memory | beta | sks wiki coords\|pack\|refresh\|publish\|rebuild-index\|validate\|validate-shared\|wrongness ... | execute_and_validate_artifacts:pass | runtime_verified | none recorded |
| `cli-memory` | core-cli | beta | sks memory build [--json] \| sks memory gc [--dry-run] | execute:pass | runtime_verified | none recorded |
| `cli-gc` | core-cli | labs | sks gc [--dry-run] [--json]<br>sks memory | execute:pass | runtime_verified | none recorded |
| `cli-cleanup` | core-cli | beta | sks cleanup plan\|status\|proof\|run --apply [--json] | execute:pass | static_contract | plan/status/proof only in fixtures; apply remains explicit |
| `cli-stats` | core-cli | labs | sks stats [--full] [--json] | execute:pass | runtime_verified | none recorded |
| `cli-features` | core-cli | beta | sks features list\|check\|inventory [--json] [--write-docs] | execute:pass | runtime_verified | feature fixtures remain progressive |
| `cli-all-features` | core-cli | beta | sks all-features selftest --mock [--json] | execute_and_validate_artifacts:pass | runtime_verified | feature fixtures remain progressive |
| `cli-perf` | loop | beta | sks perf run\|workflow\|cold-start [--json] [--iterations N] | execute:pass | runtime_verified | none recorded |
| `cli-bench` | core-cli | beta | sks bench core\|route-fixtures\|blackbox\|trust-kernel [--json] | execute_and_validate_artifacts:pass | runtime_verified | none recorded |
| `cli-mcp-server` | core-cli | beta | sks mcp-server [--expose-exec] [--probe] | execute:pass | runtime_verified | none recorded |
| `cli-agent-bridge` | core-cli | beta | sks agent-bridge setup [--trusted-project] [--json] | execute_and_validate_artifacts:pass | runtime_verified | none recorded |
| `route-dfix` | route | stable | $sks-dfix | execute_and_validate_artifacts:pass | runtime_verified | none recorded |
| `route-answer` | route | stable | $sks-answer | static:pass | wiring_only | none recorded |
| `route-sks` | route | stable | $sks | static:pass | wiring_only | none recorded |
| `route-plan` | route | labs | $sks-plan | execute:pass | runtime_verified | none recorded |
| `route-review` | route | labs | $sks-review | execute:pass | runtime_verified | none recorded |
| `route-fast-mode` | route | stable | $sks-fast-mode<br>$sks-fast-on<br>$sks-fast-off | execute:pass | runtime_verified | none recorded |
| `route-fast-on` | route | labs | $sks-fast-on | static:pass | wiring_only | none recorded |
| `route-fast-off` | route | labs | $sks-fast-off | static:pass | wiring_only | none recorded |
| `route-with-local-llm-on` | route | labs | $sks-with-local-llm-on<br>$sks-with-local-llm-off | static:pass | wiring_only | none recorded |
| `route-with-local-llm-off` | route | labs | $sks-with-local-llm-off | static:pass | wiring_only | none recorded |
| `route-naruto` | route | beta | $sks-naruto<br>$sks-work<br>$sks-from-chat-img | execute_and_validate_artifacts:pass | runtime_verified | none recorded |
| `route-work` | route | labs | $sks-work | static:pass | wiring_only | none recorded |
| `route-release-review` | route | labs | $sks-release-review | execute_and_validate_artifacts:pass | runtime_verified | none recorded |
| `route-qa-loop` | route | beta | $sks-qa-loop | execute_and_validate_artifacts:blocked | runtime_verified | none recorded |
| `route-ppt` | route | labs | $sks-ppt | mock:pass | wiring_only | live imagegen/CU evidence required |
| `route-image-ux-review` | route | labs | $sks-image-ux-review | mock:pass | wiring_only | live imagegen/CU evidence required; old names are internal compatibility aliases |
| `route-computer-use` | route | beta | $sks-computer-use<br>$sks-computer-use-fast<br>$sks-cu | execute_and_validate_artifacts:blocked | runtime_verified | none recorded |
| `route-cu` | route | beta | $sks-cu | execute_and_validate_artifacts:blocked | runtime_verified | none recorded |
| `route-goal` | route | beta | $sks-goal | static:pass | wiring_only | none recorded |
| `route-commit` | route | labs | $sks-commit | mock:pass | wiring_only | none recorded |
| `route-commit-and-push` | route | labs | $sks-commit-and-push | mock:pass | wiring_only | none recorded |
| `route-research` | route | labs | $sks-research | execute_and_validate_artifacts:pass | runtime_verified | none recorded |
| `route-super-search` | route | labs | $sks-super-search | execute:pass | runtime_verified | none recorded |
| `route-seo-geo-optimizer` | route | labs | $sks-seo-geo-optimizer | execute_and_validate_artifacts:pass | runtime_verified | none recorded |
| `route-autoresearch` | route | labs | $sks-autoresearch | mock:pass | wiring_only | none recorded |
| `route-db` | route | beta | $sks-db | execute:pass | runtime_verified | none recorded |
| `route-mad-sks` | route | beta | $sks-mad-sks | mock:pass | wiring_only | permission closed by owning gate |
| `route-gx` | route | labs | $sks-gx | execute_and_validate_artifacts:blocked | runtime_verified | none recorded |
| `route-wiki` | route | stable | $sks-wiki | execute_and_validate_artifacts:pass | runtime_verified | none recorded |
| `route-cleanup` | route | beta | $Cleanup / sks cleanup plan | execute:pass | static_contract | destructive apply remains explicit (`run --apply`) |
| `route-help` | route | stable | $sks-help | static:pass | wiring_only | none recorded |
| `proof-official-subagent-evidence` | proof-route | stable | subagent-plan.json + subagent-parent-summary.json + subagent-evidence.json | execute_and_validate_artifacts:pass | runtime_verified | parallel speed claims still require measured runtime evidence |
| `doctor:imagegen-repair` | safety | beta | sks doctor --json<br>sks doctor --fix --json<br>repair.imagegen<br>imagegen_repair | execute_and_validate_artifacts:pass | runtime_verified | live Codex App feature enablement remains environment-dependent and reports manual actions when unavailable |
| `ux-review:run-wires-imagegen` | visual-memory | beta | npm run ux-review:run-wires-imagegen<br>sks ux-review run --image <screenshot> --json<br>$sks-image-ux-review | execute_and_validate_artifacts:pass | runtime_verified | live Codex App image generation remains environment-dependent |
| `ppt:real-imagegen-wiring` | visual-memory | beta | npm run ppt:real-imagegen-wiring<br>sks ppt review --deck <pptx> --json<br>$sks-ppt | execute_and_validate_artifacts:pass | runtime_verified | live deck export and live Codex App image generation remain environment-dependent |
| `cli-wiki-code` | triwiki | beta | sks wiki refresh --code --json<br>sks wiki validate --json<br>wiki.code_pack<br>code_pack_refresh | execute_and_validate_artifacts:pass | runtime_verified | ranking is by trust_score only, not live per-prompt keyword relevance, since contextCapsule's call site here refreshes a project-wide pack rather than a per-mission one |
| `skill-quarantine` | skill | labs | $quarantine | static:pass | static_contract | runtime fixtures owned by route |

## Unmapped Coverage

- cli_command_names: none
- handler_keys: none
- dollar_commands: none
- app_skill_aliases: none
- skills: none

## Prompt Checklist Coverage

- [x] Collected the complete `sks commands --json` command surface via `COMMAND_MANIFEST_LITE`.
- [x] Collected the actual `src/cli/command-registry.ts` `COMMANDS` handler keys, including hidden handlers.
- [x] Collected dollar routes and app skill aliases from `src/core/routes.js`.
- [x] Scanned README, Codex quick reference, AGENTS, and generated skill manifest for dollar-route mentions.
- [x] Mapped project skills from `.agents/skills` into the registry.
- [x] Exposed the registry through `sks features list --json`.
- [x] Added a release coverage check through `sks features check --json`.
- [x] Documented fixture status for every registry feature.
