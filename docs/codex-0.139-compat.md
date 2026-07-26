# Codex 0.139 Compatibility Reference

SKS 7.4.0 keeps the historical Codex 0.139 compatibility notes as a fallback baseline while the active release-authorizing Codex surface is `rust-v0.145.0`.

This file is a **legacy compatibility reference**, not the current Codex product manual. It documents the Codex 0.139 capability detection that still ships in SKS, the runtime adaptations that tolerate 0.138/0.139 differences, and the explicit non-goals. Current Codex behavior should be checked against the official Codex Manual and the installed Codex CLI/App runtime; nothing here claims that Codex 0.139 is the current, recommended, or bundled Codex runtime.

## Current Codex Baseline

- SKS bundles @openai/codex-sdk 0.145.0 (the version pinned in `package.json`); the exact pin is re-read by the `docs:codex-0139-wording` release gate so this document cannot drift stale.
- Codex 0.139 features come from the external Codex CLI when that CLI is installed and supports them; SKS is Codex 0.139-aware capability detection, not a claim that every environment bundles or always supports Codex 0.139 features.
- The minimum supported Codex baseline stays `rust-v0.136.0`; 0.139 features are detected, recorded, and used opportunistically rather than assumed for every environment.
- The release gates include hermetic fixtures and optional real probes; `codex:0139-real-probes:require-real` fails when high-value 0.139 probes are skipped or failed. See [Codex 0.139 Real Probes](codex-0.139-real-probes.md).

## Legacy 0.139 Capability Detection

`detectCodex0139Capability` / `writeCodex0139CapabilityArtifacts` (gate: `codex:0139-capability`) write `.sneakoscope/codex-0139-capability.json` plus a mission-scoped copy on `sks --mad` and `sks naruto run` launches, mirroring the 0.138 capability artifacts. Flags:

| Flag | 0.139 surface |
| --- | --- |
| `supports_code_mode_web_search` | Code mode can call standalone web search directly, including from nested JavaScript tool calls (#26719). |
| `supports_rich_tool_schemas` | Tool/connector input schemas preserve `oneOf`/`allOf`; large schemas keep more shallow structure when compacted (#24118, #27084). |
| `supports_doctor_env_details` | `codex doctor` includes editor/pager environment details, redacted in JSON output (#27081). |
| `supports_marketplace_source_field` | `codex plugin marketplace list --json` includes each marketplace `source` (#27009). |
| `supports_plugin_catalog_cache` | Plugin lists can return from the cached remote catalog before refreshing in the background (#26932). |
| `supports_sandbox_profile_alias` | `-P` sandbox permissions profile alias (#27054). |
| `supports_interrupt_agent_rename` | Multi-agent v2 renamed `close_agent` to `interrupt_agent` (#26994). |

Probe mode (`SKS_CODEX_0139_PROBE=1`) additionally exercises `codex plugin marketplace list --json` (checking the new `source` field shape) and the `-P` alias in `codex --help`. `SKS_CODEX_0139_FAKE=1` with `SKS_CODEX_VERSION_FAKE` drives hermetic gate fixtures.

## Legacy Runtime Adaptations

- **`interrupt_agent` event classification.** The cockpit subagent-stage classifier accepts both `close_agent` (≤0.138) and `interrupt_agent` (0.139+) so multi-agent v2 lifecycle events keep mapping to `result` stages on newer CLIs.
- **Marketplace `source` tolerance.** The plugin marketplace JSON parser treats the new per-marketplace `source` field as evidence of the 0.139 surface and tolerates array, `marketplaces`, and `items` wrapper shapes.
- **Richer schemas, fewer workarounds.** SKS-generated worker output schemas already avoid deep nesting for compaction safety; on 0.139 the preserved `oneOf`/`allOf` support is recorded so future schema tightening can be gated on `supports_rich_tool_schemas` instead of version sniffing.

## Legacy Non-Goals

Sandbox proxy-network enforcement (#27035), approval-decision preservation (#24981), TUI fixes, and symbol-archive release chores need no SKS-side changes; they are upstream behavior SKS simply benefits from. The Codex baseline policy (`CODEX_REQUIRED_BASELINE_TAG = rust-v0.136.0`) is unchanged.

Per-release changes that previously accumulated here now live in `CHANGELOG.md` under their respective version headers; this document is intentionally limited to the stable 0.139 compatibility reference.
