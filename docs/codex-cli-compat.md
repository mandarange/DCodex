# Codex CLI Compatibility

SKS compatibility follows the **current stable** Codex dependency graph declared in `package.json`, then measures the resolved host at runtime. A release number is a dependency input, never a permanent product SSOT or a branch in application logic. App Server compatibility evidence is runtime-generated from `codex app-server generate-json-schema`; the package does not ship a second, version-named schema tree.

Updating SKS converges managed configuration, skills, MCP metadata, hooks, and release proof to the current measured contract instead of preserving historical Codex compatibility matrices. Hook outputs are validated against the vendored OpenAI Codex `latest` generated schemas plus the stricter SKS zero-warning strict subset. The current hook snapshot has 10 events and 20 schema files, including `SubagentStart` and `SubagentStop`.

Computer Use and Desktop Bridge compatibility notes are bounded: native Mac/non-web Computer Use live evidence can be `probe_only`, `live_capture_success`, or a structured blocker depending on the local Codex App/macOS capability, while web/browser/webapp verification uses the Codex Chrome Extension gate first. Bridge profile state and durability are reported independently of native-feature evidence. Recovery commands are `sks computer-use smoke --json` and `sks bridge repair --json`; local screenshots and secrets stay private/redacted by default.

## Desktop Bridge compatibility

SKS 8.1.3 exposes one managed routing runtime through `sks bridge`. Codex-LB
and OpenRouter are simultaneous bridge profiles, not direct Codex provider
activation paths. The removed `sks codex-lb` command returns `unknown_command`
and has no alias.

Compatibility requires v3 status/capability decoding: a combined catalog,
explicit route index, `fallback: none`, provider-scoped credential/catalog
state, and stage-aware WebSocket evidence. A persisted Naruto concurrency
preference above the execution limit is read without rewriting it and clamped
at runtime to 256 children / 257 total threads; explicit CLI values above 256
are rejected.

## Checks

```bash
sks codex compatibility --json
sks codex version --json
sks codex update-status --json
sks codex update
sks codex doctor --json
sks codex schema --json
```

Version detection checks `codex --version`, `codex exec --help`, `codex exec resume --help`, `codex --help`, installed `@openai/codex`, Homebrew cask metadata, and finally the vendored hook snapshot metadata. A missing or older live Codex binary is not accepted as a compatible runtime; a newer host is accepted only after its capabilities are probed. SKS surfaces the update action (induce/check/fail). Host upgrade execution remains the user’s or Codex’s responsibility. Release hook validation uses the vendored snapshot, while App Server protocol validation uses the resolved runtime.

## Prefer-Latest Policy

- **Preferred channel artifact**: the exact `@openai/codex-sdk` dependency in `package.json` selects the tested graph; the lockfile proves the SDK and CLI resolutions agree.
- **Capability matrix**: features such as `multi_agent_v2`, `agents.max_concurrent_threads_per_session`, thread-list search, MCP startup/tool timeouts, and GPT-6 Astra child routing are probed or wrapped; missing capabilities fail that route with `sks codex update` / Menu Bar **Update Codex CLI Now** guidance.
- **Update inducement**: SKS Menu Bar and Control Center surface Codex CLI update status and actions (`sks update status`, `sks codex update`).
- Historical compatibility matrices and their release gates are not part of the active product or release surface.

## Current Measured Package Contract

- `package.json` and `package-lock.json` must agree on one SDK/CLI dependency graph. A version-named release manifest or App Server schema directory is rejected as duplicate truth.
- Naruto enables stable opt-in `features.multi_agent_v2` when the host exposes it, with unified `[agents]` concurrency and default subagent model/reasoning settings. SKS wraps Codex official multi-agent only.
- Binary identity, runtime-generated App Server v2 schema, thread-store behavior, and runtime policy are separate release gates; a version string alone is not sufficient evidence.
- Official subagent lifecycle uses `SubagentStart` and `SubagentStop`, but completion additionally requires a trustworthy structured parent outcome for every thread.
- Missing or malformed tool-output correlation fails closed instead of being treated as a successful continuation.
- Older runtime hosts and historical compatibility reports do not authorize or extend the current release contract. Prerelease or unknown newer fields are also not automatic release evidence.

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
sks codex compatibility --json
sks codex schema --json
npm run release:check:affected
npm run release:check:confidence
```

The release DAG owns the `codex:current:*` dependency-graph, binary-identity, policy, App Server v2, thread-store, and capability gates. Hook warning count must be `0`.
