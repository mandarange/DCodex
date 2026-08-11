# Sneakoscope Codex — Product Contract Summary

SSOT for resolved product contracts: [AMBIGUITY-RESOLUTIONS.md](AMBIGUITY-RESOLUTIONS.md).
This page is the English product-facing projection of those decisions.

## Naming

| Surface | Official name |
| --- | --- |
| Product | Sneakoscope Codex |
| CLI | `sks` |
| npm package | `sneakoscope` |

## Hosts and platforms

- **First-class hosts:** Codex CLI and ChatGPT Desktop (equal).
- **Not official:** Cursor and other editors (best-effort, no product promise).
- **Platforms:** macOS fully supported (CLI + Menu Bar/Center). Linux/Windows: CLI best-effort only.
- **Language SSOT:** English for product UI and external docs.
- **Support channel:** GitHub Issues.
- **Offline / air-gap:** not a required product promise; normal path is online npm `@latest` + Codex host.
- **Concurrency:** multiple simultaneous `sks` processes are best-effort, not a hard guarantee.
- **Third-party MCP servers:** host/user domain; SKS does not warranty them.
- **Telemetry:** no remote usage analytics (default off / none).

## Ownership

- **SKS owns:** missions, evidence, gates, and release-claim blocking.
- **Host owns:** credentials, model policy, and workspace.
- **Persisted Goal owner:** Codex native Goal only. SKS writes no Goal state and no Goal fallback loop (`$sks-loop` is retired).
- **Menu Bar / Center:** UX only; CLI is the functional SSOT; internals call CLI. Not the truth source for mission/evidence.
- **Adapters (e.g. codex-lb):** must not rewrite host credentials/sessions or forge tool output.
- **Installed harness:** immutable outside the engine repo except user-run `sks doctor --fix` and explicit install/update. Agents never run `sks doctor --fix`.

## Desktop Bridge routing (8.1.3)

- **One managed runtime:** SKS routes managed Codex Desktop and CLI traffic through one local Desktop Bridge. There are no competing provider or bridge modes.
- **Profiles, not modes:** Codex-LB and OpenRouter are independent profiles. Both credentials may be configured, validated, enabled, and displayed at the same time; changing one cannot delete the other.
- **Identity boundary:** ChatGPT OAuth remains Codex-owned. SKS preserves its semantic identity and does not forward its authorization to either provider upstream.
- **Explicit routing:** the combined catalog's route index selects a provider and upstream model. Fallback is always `none`; missing and ambiguous routes fail explicitly.
- **Configuration ownership:** only provably SKS-authored historical routing state is migrated. User-owned or ambiguous provider/catalog/base-URL state fails closed instead of being overwritten.
- **Removal boundary:** `sks bridge unmanage --confirm` is an explicit unmanaged/rollback action, not a profile switch. The removed `sks codex-lb` command is unknown and has no alias.

## Codex compatibility SSOT

- Compatibility SSOT is always **current latest stable**, measured by capability probes.
- Product copy must not treat a fixed `0.x.y` as permanent SSOT.
- Package/release/Menu Bar/PATH/marketplace install surfaces must agree on the current measured pin; mismatch is gate fail.
- Install SSOT: npm registry `sneakoscope@latest`. Plugin marketplace is a convenience entry that must yield the same version.
- Product update channel: `@latest` only (`next`/beta are non-product).
- SKS induces/checks/fails on host Codex drift; host upgrade execution remains user/Codex responsibility.
- Fast, Computer Use, imagegen, and other official Codex native surfaces are **consume / bridge / gate only** — SKS does not reimplement them. Local LLM was an opt-in addon outside the core trust-layer contract and was removed entirely in 8.7.0; workers run on Codex official backends only.
- Visual product evidence uses official Codex imagegen only (no placeholder/forged images).
- Multi-agent / Naruto parallel: wrap Codex official multi-agent only; without it the product is incomplete.

## TriWiki

- Dual role: (1) code navigation index, (2) structured project memory/claims.
- Authority: `context-graph.json` is exhaustive code-search authority. `context-pack.json` and managed `AGENTS.md` are bounded projections. Memory is not a code index.
- **triwiki-cleanup** (`$sks-cleanup` / `sks cleanup`): permanently blanks active TriWiki; no backup/quarantine/restore generation on success.
- **`$sks-align` / `sks align`:** independent of cleanup; rebuilds from current repo source only; includes wiki/pack generation. Does not require a cleanup receipt.
- **harness-conflicts-cleanup** (`sks conflicts cleanup`): fully separate path; may keep quarantine backups.
- Avoid bare “cleanup” in user docs; name the path.
- Align is fail-closed on binary/oversized/cap violations (no quiet partial success).

## Completion and verification

- Full / high-risk / release completion requires relevant checks or an explicit justification that checks are unnecessary.
- **Light paths** (relaxed completion): Answer, DFix, and Help/status-class read-only routes. Light completion never substitutes for full-route/release completion.
- Blocked missions with blockers are correct answers; do not disable safety or forge evidence to look green.
- Honest Mode: once at the end of batched work; retry only remaining gaps (not every intermediate step).
- Release required evidence: **release gates**. Typecheck, focused tests, and package dry-run are recommended, not automatic required substitutes.
- Release-core review routes (`$sks-review` / security / bugbot): required for release; run near the end once, then gap-only loops.
- Testing philosophy: main path, meaningful boundaries, credible failures — not low-value matrices or coverage-number goals.
- Release proof bank: keep only essential information; prune when no longer needed.

## Safety and ops

- DB read-only / live-mutation authorization applies to **DB routes** (and SQL-plane / MAD paths), not ordinary workspace file edits.
- Secrets: never store/log/evidence host secrets; fail-closed; no quiet SKS credential fallback.
- Full-route auto-commit is allowed; **push only on explicit user request**.
- Context7 or official vendor docs outrank model memory for stack/API/package/runtime work.
- Managed global skills win over project-local/cache/stale paths; after remap, do not report stale path mismatches to the user.
- Nested subagents are absolutely forbidden; parent owns decomposition/integration/verification/final answer.
- Mission retention: completed missions may be deleted for capacity; deletion must not be misread as “incomplete” (completion receipt before delete; no infinite restart loop).
- `sks uninstall` is the product removal path and must fully remove SKS setup/files.
- SKS product version is a marketing/release identifier, not a strict semver product gate.
- Trusted-project may default on for local personal repos under operator policy; users must not modify the installed SKS engine; Codex `config.toml` remains user-editable.
- Internal/optional routes (not core trust-layer completion): SEO/GEO, Design, PPT, GX, Autoresearch, `$sks-research`.
- Performance: no product SLA or bench-number promises; measurements are internal/optional.
- Naruto accepts an oversized persisted thread preference without rewriting it, but uses an effective maximum of 256 child threads and 257 total threads. Explicit CLI values above 256 are rejected; the parent remains outside the child-slot cap.
- Contributions: welcome via standard PR/issues.
- Default logs are minimal; verbose/debug requires an explicit flag.
