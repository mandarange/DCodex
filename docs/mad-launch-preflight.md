# MAD Launch Preflight

SKS 1.20.5 `sks --mad` runs `runCodexLaunchPreflight()` before invoking the native Codex CLI.

The preflight runs read-only config readability, actual Codex config-load probing, project-config policy checks, safe repair when needed, and Fast service-tier CLI proof, then writes `.sneakoscope/reports/mad-launch-preflight.json`.

If blockers remain, the native invocation is skipped and SKS prints blockers plus operator actions.
