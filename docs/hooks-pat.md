# Codex App Hooks and PAT Evidence

SKS hook replay uses the same shared hook policy path as runtime hooks. Fixture replay compares the runtime decision against strict expected snapshots and redacts token-shaped values with `[redacted]`.

Core commands:

```sh
sks hooks trust-report --json
sks hooks replay test/fixtures/hooks/pre-tool-db-drop.json --json
sks hooks codex-schema --json
sks hooks codex-validate --json
sks hooks warning-check --json
sks hooks replay-codex-fixtures --json
sks hooks trust-doctor --actual --json
sks hooks trust-state --actual --json
sks hooks install --managed --json
sks hooks official-parity --json
sks codex-app pat status --json
```

## Latest Codex Hook Shape

SKS 1.14.1 validates against the vendored OpenAI Codex `latest` hook snapshot from `openai/codex` HEAD. The snapshot has 10 events and 20 command schema files. `SubagentStart` and `SubagentStop` are release-blocking events, not compatibility warnings.

1.14.1 also writes `codex-hook-parity-1.14.1.json`, uses `sks.codex-hook-official-parity.v2`, and records an official hash oracle result. When the official hash is unavailable, SKS enforces managed-only hook repair and keeps unmanaged trusted-hash writing disabled.

This page is documentation-only evidence: it distinguishes probe/mock/live evidence, avoids universal Computer Use availability claims, and keeps PAT/secret handling private and redacted. For recovery, run `sks hooks warning-check --json`, `sks computer-use smoke --json`, or `sks codex-lb setup --write-env-file --keychain --launchctl` depending on the failing surface.

Supported event names are `PreToolUse`, `PermissionRequest`, `PostToolUse`, `PreCompact`, `PostCompact`, `SessionStart`, `UserPromptSubmit`, `SubagentStart`, `SubagentStop`, and `Stop`.

Command hook config must use the upstream handler fields `command`, `commandWindows` or `command_windows`, `timeout`, `async`, and `statusMessage`. `allow_managed_hooks_only = true` is valid only in `requirements.toml`; SKS must not write it to `config.toml`.

SKS writes command hooks only. It must not generate prompt hooks, agent hooks, async hooks, empty commands, invalid matchers, or same-layer `hooks.json` plus `config.toml` hook definitions. `sks hooks trust-doctor --actual --json` reports `current_hash`, `trusted_hash`, and `trust_status` as `Managed`, `Trusted`, `Modified`, or `Untrusted` from `hooks.json`, inline TOML, `requirements.toml`, and managed directories.

When Codex does not expose an official hook hash list, SKS does not write SKS-only `trusted_hash` values by default. The safe repair is `sks hooks install --managed --json`, which writes `allow_managed_hooks_only = true` in `.codex/requirements.toml` and records managed command hooks under `.codex/managed-hooks/`.

Output uses camelCase Codex fields. Examples:

```json
{
  "continue": true,
  "hookSpecificOutput": {
    "hookEventName": "PreToolUse",
    "permissionDecision": "deny",
    "permissionDecisionReason": "SKS policy blocked the requested command."
  }
}
```

```json
{
  "continue": true,
  "decision": "block",
  "reason": "SKS serious route cannot finalize without valid Completion Proof."
}
```

Snake_case output keys, legacy top-level `permissionDecision`, PermissionRequest reserved fields, unsupported config fields, PreToolUse `permissionDecision:"ask"`, PreToolUse `allow` without `updatedInput`, Stop `continue:false`, Stop `stopReason`, and Stop blocks without a reason are release-blocking warning patterns. `sks hooks warning-check --json` reports them by `schema_violation`, `upstream_semantic_unsupported`, `sks_zero_warning_disallowed`, `legacy_shape`, and `policy_disallowed`.

PreToolUse accepts a non-empty string `hookSpecificOutput.additionalContext` when SKS must refresh verified managed-skill context immediately before tool execution. Top-level `additionalContext` and non-string values remain release-blocking legacy/schema violations. PermissionRequest allow `message` remains intentionally rejected by the SKS strict subset to preserve a zero-warning release surface.

PreToolUse simple allow is:

```json
{
  "continue": true
}
```

PreToolUse rewrite is:

```json
{
  "continue": true,
  "hookSpecificOutput": {
    "hookEventName": "PreToolUse",
    "permissionDecision": "allow",
    "updatedInput": {
      "command": "npm test"
    }
  }
}
```

PAT and access-token policy:

- `CODEX_ACCESS_TOKEN`, `OPENAI_API_KEY`, `CODEX_LB_API_KEY`, GitHub tokens, `sk-*`, `sk-proj-*`, `sk-clb-*`, and bearer tokens must never appear in plaintext artifacts.
- Hook replay output records `secret_policy: "redacted"`.
- Codex App PAT status reports only presence/redacted state, not token contents.

Strict replay supports exact `decision`, `permissionDecision`, `gate`, and `continue` matching plus `reason_contains`, `missing_contains`, and `issues_contains`. Stop fixtures cover missing proof, invalid proof, missing visual anchors, valid visual anchors, and app git/settings events.
