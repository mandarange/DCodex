# Codex Project Config Policy

SKS project `.codex/config.toml` should keep project-scoped settings such as sandbox, approval, features, and trusted project behavior.

Machine-local provider/profile/auth/notification/telemetry routing keys are split out by `splitCodexProjectConfigPolicy()`. The splitter creates a backup, rewrites the project config, deduplicates moved machine-local fragments in CODEX_HOME config, and writes selected `[profiles.<name>]` bodies to `$CODEX_HOME/<name>.config.toml`.
