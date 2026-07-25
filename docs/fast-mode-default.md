# Fast Mode

Fast is a service-tier choice, not a reasoning-effort preset. SKS keeps
those controls independent so changing Fast does not pin or hide the native
Codex Desktop model and effort selectors.

Use the CLI or the macOS menu bar:

```bash
sks fast-mode on
sks fast-mode off
sks fast-mode status
sks fast-mode clear
```

Codex App aliases are `$sks-fast-on`, `$sks-fast-off`, and `$sks-fast-mode`.
The menu bar shows the verified current state and provides direct Fast Mode On
and Fast Mode Off actions. A failed status read is displayed as unavailable;
SKS does not guess or render a false checkmark.

The project preference is written to `.sneakoscope/state/fast-mode.json`.

```json
{
  "schema": "sks.fast-mode-policy.v1",
  "fast_mode": true,
  "service_tier": "fast",
  "default_fast_mode": true
}
```

SKS normalizes its service-tier vocabulary to `fast` and `standard`. Codex
Desktop may describe the equivalent choices as `priority` and `default`.
Routes that support this preference record it in their current policy and
propagation evidence.

Global Desktop repair preserves `service_tier = "fast"` and
`[features].fast_mode = true`. It removes only provenance-marked SKS global
`model_provider`, `model`, and `model_reasoning_effort` locks that can suppress
the native Chat/Pro/model/Fast picker. Unmarked user choices, provider tables,
URLs, and credential references remain untouched.

Config and fixture proof cannot establish live picker visibility. After a
repair, restart ChatGPT/Codex Desktop and verify the visible selector before
claiming the UI is restored on that machine.

Naruto uses the fixed official model-routing policy described in
[`docs/naruto.md`](naruto.md). Its public controls are the official thread
budget, read-only mode, and JSON/status/proof surfaces; backend, scheduler,
worker-model, and service-tier controls are not part of that public contract.

Use the bounded current release checks after changing Fast Mode behavior:

```bash
npm run release:check:affected
npm run release:check:confidence
```
