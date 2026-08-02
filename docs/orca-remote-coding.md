# Orca remote coding (external option)

SKS provides Telegram as a first-party transport for its existing typed remote
control contract. Telegram does not create a second control plane or accept
free-form shell commands: it can invoke only commands already marked
`remoteAllowed` by that shared contract. Local setup and pairing commands remain
remote-disallowed.

This page is also a lightweight pointer for teams that prefer Orca. It is not an
Orca setup guide or an SKS feature contract.

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

## Telegram and Orca

Telegram and Orca are independent transports. Telegram reuses the same SKS
typed command contracts, risk classification, remote allowlist, validation, and
confirmation rules as other SKS remote clients. Orca remains an external way to
operate Codex sessions and is not a migration target for Telegram threads, bot
tokens, pairing state, or history.

There is no automatic migration between Telegram and Orca.

Legacy pre-contract Telegram bridge state is not trusted automatically. When an
existing installation upgrades, SKS performs only two narrowly scoped cleanup
actions for that old bridge:

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
4. Continue using SKS independently for its proof and orchestration workflows,
   including the Telegram transport when remote command access is desired.

Optional security cleanup: after confirming an old bot token is no longer
needed, you may review it with BotFather and revoke it there. This is an
external, irreversible credential action; SKS does not perform it automatically.
