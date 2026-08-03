# macOS TCC Operator Actions

When Codex reports `Operation not permitted (os error 1)` while Node can read `.codex/config.toml`, SKS treats macOS TCC as a probable diagnosis, not a certain one.

Check:

- System Settings -> Privacy & Security -> Full Disk Access.
- Grant access to the launching app: Warp, Terminal, iTerm, Codex app, or the app that starts Codex CLI.
- If the project is under Desktop, Documents, iCloud Drive, or an external volume, also check Files and Folders.
- Fully restart the terminal/Codex app after changing permissions.
