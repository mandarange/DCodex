# Orca remote coding (external option)

SKS no longer provides a first-party Telegram coding bridge. This page is a
lightweight pointer for teams that want remote access to coding work; it is not
an Orca setup guide or an SKS feature contract.

[Orca](https://github.com/stablyai/orca) is an external, MIT-licensed project
that can run Codex and other CLI agents in worktrees. It is not bundled with
SKS, supported by SKS, or required by SKS. Installing or using Orca adds no
SKS dependency, and SKS does not configure, launch, authenticate, or operate
it.

## What Orca can provide

Orca documents a desktop application that launches `codex` from the selected
worktree after Codex is installed and logged in. Review [Codex in
Orca](https://www.onorca.dev/docs/agents/codex) before connecting an existing
Codex account.

Its [mobile companion](https://www.onorca.dev/docs/mobile) is beta. The paired
desktop remains the source of truth; closing the desktop drops the connection.
For another-device access, Remote Orca Servers are also beta. The server
computer holds repositories, worktrees, terminals, credentials, and agent
sessions, so it must remain awake, online, and running Orca. Orca recommends a
private connection path such as a LAN or Tailscale rather than exposing the
service publicly. See [Remote Orca
Servers](https://www.onorca.dev/docs/remote-servers) for its current pairing
and security guidance.

## Former SKS Telegram users

The retired Telegram bot, Hub, private-pairing flow, and related SKS commands
are not an Orca migration path. There is no automatic migration of Telegram
threads, bots, tokens, or history into Orca.

When an existing installation upgrades, SKS performs only two narrowly scoped
retirement actions:

- It stops the exact old SKS LaunchAgent service and removes its plist only
  after verifying the managed label and program shape. A different file at the
  same path is preserved and reported as a collision.
- It quarantines only bindings whose machine, project, project root, and
  deterministic legacy session ID prove that the old bridge created them. A
  byte-for-byte backup and receipt are written under
  `.sneakoscope/quarantine/retired-remote-bridge/`; nonmatching rows remain in
  place.

Generic SKS remote machine and project registries are left intact. SKS does not
delete macOS Keychain credentials, bot configuration/history, or other
user-controlled data automatically.

1. Choose whether Orca's desktop, mobile companion, or remote-server model fits
   your workflow by reading its official documentation above.
2. Install and authenticate Codex on the computer that will actually run the
   agent; a login on a client device does not transfer to a remote server.
3. If you use remote access, keep the server on a private LAN or Tailscale path
   and treat Orca access links as secrets.
4. Continue using SKS independently for its proof and orchestration workflows.

Optional security cleanup: after confirming an old Telegram bot is no longer
needed, you may review its BotFather token and revoke it there. This is an
external, irreversible credential action; SKS neither performs it nor requires
it for the migration.
