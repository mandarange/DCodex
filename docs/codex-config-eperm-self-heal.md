# Codex Config EPERM Self-Heal

SKS 1.20.5 treats `.codex/config.toml` readability as a launch-critical proof, not a setup side effect, and keeps config repair separate from launch behavior.

`inspectCodexConfigReadability()` writes `.sneakoscope/reports/codex-config-readability.json` with project config existence, parent traversal, stat/lstat, owner/mode, macOS ACL/flags/xattrs/quarantine, symlink safety, Node read, spawned-child read, and actual Codex CLI config-load checks.

`repairCodexConfigEperm()` writes `.sneakoscope/reports/codex-config-eperm-repair.json` and only performs scoped repairs when fix mode is explicit: user read/write permissions, `.codex` traversal, quarantine removal, immutable flag removal, and project-config policy splitting with backup.
