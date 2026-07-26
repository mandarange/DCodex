# Codex CLI Compatibility

SKS 7.4.0 prefers the OpenAI Codex CLI `rust-v0.145.0` channel (July 2026) as the package-tracked latest, without hard-locking the product to that single version. Package metadata pins `@openai/codex-sdk` and its resolved `@openai/codex` CLI to 0.145.0 for the release proof graph, while runtime policy is **prefer latest + capability detection**: a soft minimum (`0.133.0`) keeps general SKS integration alive; features that need newer Codex (for example Naruto multi-agent V2) probe host capabilities and degrade or block only that feature with an update CTA. Hook outputs are validated against the vendored OpenAI Codex `latest` generated schemas plus the stricter SKS zero-warning strict subset. The current hook snapshot has 10 events and 20 schema files, including `SubagentStart` and `SubagentStop`.

Computer Use and codex-lb compatibility notes are bounded: native Mac/non-web Computer Use live evidence can be `probe_only`, `live_capture_success`, or a structured blocker depending on the local Codex App/macOS capability, while web/browser/webapp verification uses the Codex Chrome Extension gate first; codex-lb can be durable or `process_only_ephemeral` depending on setup choices. Recovery commands are `sks computer-use smoke --json` for a probe-only native status and `sks codex-lb setup --write-env-file --keychain --launchctl` for durable persistence. Local screenshots and secrets stay private/redacted by default.

## Checks

```bash
sks codex compatibility --json
sks codex compatibility --require rust-v0.145.0 --json
sks codex version --json
sks codex update-status --json
sks codex update
sks codex doctor --json
sks codex schema --json
sks codex 0.144 --json
```

Version detection checks `codex --version`, `codex exec --help`, `codex exec resume --help`, `codex --help`, installed `@openai/codex`, Homebrew cask metadata, and finally the vendored snapshot metadata. A missing live Codex binary is `integration_optional`; hosts below preferred but at or above the soft minimum are `below_preferred_baseline` (SKS still runs; update inducement is shown). `--require rust-v0.145.0` remains the explicit hard gate for release-style checks. Release hook validation uses the vendored snapshot, not the local binary.

## Prefer-Latest Policy

- **Preferred channel**: `config/codex-releases/rust-v0.145.0.json` (`preferredCliVersion` / `requiredCliVersion` / SDK) tracks the latest Codex SKS has proven against.
- **Soft floor**: `minimumSupportedVersion` (`0.133.0`) blocks only hosts that are too old for general integration safety.
- **Capability matrix**: features such as `multi_agent_v2`, `agents.max_concurrent_threads_per_session`, thread-list search, MCP startup/tool timeouts, and GPT-5.6 Terra/Luna/Sol routing are probed or wrapped; missing capabilities fail that route with `sks codex update` / Menu Bar **Update Codex CLI Now** guidance.
- **Update inducement**: SKS Menu Bar and Control Center (Overview, Updates, Diagnostics) surface Codex CLI update status and actions (`sks update status`, `sks codex update`).
- Older compatibility matrices below remain inherited regression evidence and cannot authorize the current release by themselves.

## Current Codex 0.145.0 Preferred Contract

- `config/codex-releases/rust-v0.145.0.json` is the active preferred-channel manifest and must agree with the exact SDK/CLI dependency graph for package release proof.
- Naruto enables stable opt-in `features.multi_agent_v2` when the host exposes it, with unified `[agents]` concurrency and default subagent model/reasoning settings.
- Binary identity, App Server v2 schema, thread-store behavior, and runtime policy are separate release gates; a version string alone is not sufficient evidence.
- Official subagent lifecycle uses `SubagentStart` and `SubagentStop`, but completion additionally requires a trustworthy structured parent outcome for every thread.
- Missing or malformed tool-output correlation fails closed instead of being treated as a successful continuation.
- Older compatibility matrices below remain inherited regression evidence and cannot authorize the current release by themselves.

## Inherited Codex 0.136 Capabilities

The inherited 0.136 compatibility matrix records these capability ids:

- `tui_hyperlink_markdown_tables`: TUI output preserves OSC 8 links and keeps cramped markdown tables readable.
- `session_archive_restore`: `codex archive`, `codex unarchive`, and `/archive` are tracked as first-class session lifecycle surfaces.
- `app_server_resume_status_stdio`: app-server readiness covers resumed turns, MCP status, and `codex app-server --stdio`.
- `remote_api_key_registration_server_tokens`: remote registration records `CODEX_API_KEY` and short-lived remote-control server-token support.
- `windows_sandbox_elevated_setup`: `codex sandbox setup --elevated` is mapped as release-baseline evidence, with live Windows setup remaining environment-specific.
- `native_image_generation_extension_pipeline`: the feature-gated standalone image-generation extension pipeline is recorded, while SKS still requires real Codex App `$imagegen`/`gpt-image-2` output for visual proof.
- `chatgpt_auth_refresh_relogin`: ChatGPT auth refresh and relogin-required handling are treated as explicit readiness signals.
- `command_safety_hardening`: `/diff` helper isolation, non-Windows PowerShell avoidance, and browser-origin websocket rejection remain release safety inputs.
- `sandbox_cleanup_deny_read_preserved`: sandbox cleanup and deny-read preservation are tracked as P0 compatibility risks.
- `tui_resume_hook_vim_stability`: resumed prompt history, multiline hook output, and Vim normal-mode fixes stay mapped to terminal/hook stability gates.
- `app_server_fs_watch_search_activity`: app-server watcher debounce and standalone web search activity restoration are release-readiness evidence.
- `bedrock_region_service_tier_hardening`: Bedrock `AWS_REGION` fallback and unsupported service-tier removal are provider-catalog compatibility notes.
- `rmcp_1_7_compat`: rmcp 1.7.0 compatibility remains connected to MCP scheduler gates.

## Inherited Codex 0.135 And 0.134 Capabilities

The 0.135 matrix remains inherited for named permission profiles, shortcut handling, ChatGPT usage-limit/token refresh reporting, and app-server/remote-control readiness behavior.

The 0.134 compatibility matrix records these capability ids:

- `profile_primary_selector`: Codex `--profile` is the primary selector and SKS native agents pass it without `--ignore-user-config`.
- `local_conversation_history_search`: Source Intelligence can search bounded local Codex history case-insensitively with previews.
- `mcp_per_server_environment`: MCP config classification records per-server environment targeting.
- `mcp_streamable_http_oauth`: streamable HTTP MCP OAuth support is tracked as release-readiness evidence.
- `connector_schema_refs_defs_compaction`: oversized connector schemas are compacted while preserving `$ref` and `$defs`.
- `mcp_readonly_parallel_hint`: `readOnlyHint` is treated as advisory and must pass destructive-name/schema checks before parallel execution.
- `hook_subagent_context`: Subagent hook/cockpit context carries identity, slot, generation, and transcript pointers.
- `managed_network_proxy_env`: Codex child processes receive managed proxy environment keys with redacted reports.

The inherited 0.133 compatibility matrix records these capability ids:

- `exec_output_schema`: preferred structured output for fresh Codex exec sessions used by native agent backends and route automation.
- `exec_resume_output_schema`: preferred structured output for resumed Codex sessions used by native agents, UX-Review callout extraction, Completion Proof, and Wrongness artifacts.
- `exec_syntax_parity`: release-bound check that fresh `codex exec` and `codex exec resume` expose compatible output-schema syntax instead of inferring one from the other.
- `app_server_image_fidelity`: original-resolution image metadata for UX-Review source screenshots, generated callout images, and Image Voxel coordinate alignment.
- `memory_summary_version_rebuild`: schema-versioned TriWiki, Wrongness, and shared memory summaries with rebuild commands.
- `goal_continuation_blocker_stop`: repeated blocker and usage-limit stops for Goal, QA, Research, and UX-Review loops.
- `tui_probe_batching`: batchable doctor/probe inventory with timeout budgets.
- `goals_default_enabled`: native `/goal` is treated as the active persisted continuation surface under Codex 0.133 and later.
- `remote_control_foreground_app_server`: `codex remote-control` readiness prefers the latest foregrounded app-server.
- `permission_profiles_requirements`: Codex 0.133 permission/profile/requirements surfaces are first-class policy inputs; `allow_managed_hooks_only = true` remains in `requirements.toml`.
- `plugin_discovery_marketplaces`: plugin discovery and `marketplaces` are recorded as P1 warning-only unless a route explicitly needs them.
- `extension_lifecycle_events`: extension lifecycle events for turn/tool/model/item phases are tracked separately from hook schema validation.
- `remote_executor_standard_auth`, `python_sdk_auth`, and `python_sdk_turn_result`: P1 warning-only review items unless a route explicitly uses those SDK surfaces.

The package release proof requires the preferred 0.145.0 SDK/CLI dependency graph, manifest, and schema baseline. Runtime hosts may be older when above the soft floor; feature routes capability-gate. Older 0.134-0.136 rows are historical regression context, and prerelease or unknown newer fields are not automatic release evidence. Output-schema fallbacks cannot support claims above `verified_partial`.

Fresh `codex exec` and `codex exec resume` are checked independently because a release gate that only inspects resume help can miss syntax drift in new sessions. Native agent output-schema fixtures must record which command form was exercised.

## Vendored Snapshot

The release ships upstream generated hook schemas under:

```text
src/vendor/openai-codex/latest/hooks/
```

The snapshot includes input/output schemas for `PreToolUse`, `PermissionRequest`, `PostToolUse`, `PreCompact`, `PostCompact`, `SessionStart`, `UserPromptSubmit`, `SubagentStart`, `SubagentStop`, and `Stop`. Snapshot metadata records upstream repo, tag, commit, and capture time; every release check confirms all 20 schema files exist and parse as JSON.

SKS hook outputs must use Codex camelCase fields such as `hookSpecificOutput`, `stopReason`, `suppressOutput`, `systemMessage`, `permissionDecision`, `permissionDecisionReason`, `additionalContext`, and `updatedInput`. Snake_case or legacy top-level hook fields are release-blocking `legacy_shape` patterns.

## Validation Categories

- `schema_violation`: the output violates the vendored upstream JSON schema.
- `upstream_semantic_unsupported`: the upstream runtime parser currently fails closed or treats the shape as unsupported.
- `sks_zero_warning_disallowed`: upstream may accept the shape, but SKS bans it to keep release fixtures warning-free and consistent.
- `legacy_shape`: old top-level or snake_case output shape.
- `policy_disallowed`: an SKS trust policy or config policy rejected the output.

## Runtime Semantic Rules

- PreToolUse deny uses `hookSpecificOutput.permissionDecision:"deny"` with non-empty `permissionDecisionReason`.
- PreToolUse simple allow is `{ "continue": true }`; `permissionDecision:"allow"` is allowed only with `updatedInput`.
- PreToolUse may attach a non-empty string `hookSpecificOutput.additionalContext` to refresh verified managed-skill context immediately before a tool call. The legacy top-level `additionalContext` shape remains rejected.
- PreToolUse `permissionDecision:"ask"`, `continue:false`, `stopReason`, and `suppressOutput:true` are fatal.
- PermissionRequest uses only `hookSpecificOutput.decision.behavior`; deny requires a non-empty `message`.
- PermissionRequest `updatedInput`, `updatedPermissions`, `interrupt:true`, `continue:false`, `stopReason`, and `suppressOutput:true` are fatal.
- PostToolUse and UserPromptSubmit blocks require non-empty `reason`; PostToolUse `updatedMCPToolOutput` is fatal.
- Stop block is `{ "continue": true, "decision": "block", "reason": "..." }`; Stop `continue:false` and `stopReason` are fatal in release fixtures.
- PreCompact and PostCompact emit `{ "continue": true }`.

SKS strict-subset examples:

- PermissionRequest allow `message` is schema-compatible but `sks_zero_warning_disallowed`.
- Optional `systemMessage` in routes that should not emit user-visible output is policy-sensitive and must be justified before use.

`allow_managed_hooks_only = true` belongs in `requirements.toml`, not `config.toml`.

## Release Invariant

Current local compatibility verification uses:

```bash
sks codex compatibility --require rust-v0.145.0 --json
sks codex 0.144 --json
sks codex schema --json
npm run release:check:affected
npm run release:check:confidence
```

The release DAG owns the `codex:0144:*` manifest, binary-identity, policy, App Server v2, thread-store, and capability gates. Hook warning count must be `0`.
