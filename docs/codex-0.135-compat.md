# Codex rust-v0.135.0 Compatibility

SKS 1.18.13 records Codex 0.135 compatibility through local probes and release-baseline evidence.

- `npm run codex:0.135-compat` writes `.sneakoscope/reports/codex-0.135-compat.json`.
- `npm run codex:0.135-compat:require-real` blocks when a local Codex CLI at `rust-v0.135.0` or newer is not detected.
- Doctor, named permission profiles, resume/cwd truth, MCP tool naming, retry policy, Markdown table rendering, and runtime state separation each have SKS gates.
