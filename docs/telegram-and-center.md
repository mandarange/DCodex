# SKS Center and Telegram remote coding

This is the end-to-end guide for opening **SKS Center** and for pairing a private
**Telegram** bot so you can drive a coding session on this Mac from your phone.

Every GUI step below has an exact CLI equivalent, and every command shown here is
one you can run and verify. macOS only — the token store is the macOS Keychain and
the hub runs as a user LaunchAgent.

---

## Part 1 — SKS Center

### What it is

SKS Center (the window title is "SKS Control Center") is the native macOS companion
UI that ships with SKS. It is not a web app and not a separate download: it is the
menu bar app in `native/sks-menubar`, installed by the SKS CLI.

It has seven sections:

| Section | What it covers |
| --- | --- |
| Overview | Current status, Fast mode, pending approvals |
| Providers | Codex Desktop provider/model selection (incl. OpenRouter) |
| Updates | Codex CLI and SKS update state |
| MCP Servers | Configured MCP servers |
| **Remote & Telegram** | Telegram bot pairing and hub control |
| Diagnostics | Doctor output and receipts |
| Settings | App preferences |

### Install it

```bash
sks menubar install
```

Check it landed:

```bash
sks menubar status --json
```

### Open it

The menu bar app has no Dock icon. Click the **SKS icon in the macOS menu bar**
(tooltip: "SKS Control Center"), then choose **Open SKS Control Center…** — the
first item in the menu.

That menu also exposes `Fast Mode On` / `Fast Mode Off`, `Check for Updates`,
`Update Codex CLI Now`, `Open Updates…`, `View Last Operation`, and `Quit SKS Menu`.

If the icon is not in the menu bar, run `sks menubar install` again, then
`sks menubar restart`. To remove it, `sks menubar uninstall`.

---

## Part 2 — Telegram remote coding

### What you get

A **private, single-operator** bridge: one Telegram bot, paired to exactly one
private chat and one Telegram user, bound to exactly one project directory on this
Mac. Ordinary text you send becomes a turn in a durable Codex thread; the final
response comes back to Telegram.

This is not a shared or multi-user bot, and there is no public endpoint.

### Before you start

1. **This Mac must stay on.** The hub is a local LaunchAgent. It uses
   `caffeinate -i` to prevent idle sleep while you are logged in, but the Mac still
   has to be powered on, logged in, awake and online. Closing the lid or logging out
   can stop access.
2. **Install the menu bar app** if you want the GUI flow (Part 1).
3. **Decide the project.** The pairing binds one project root. Run the setup from
   the directory you want to code in.

### Step 1 — Create the bot in BotFather

In Telegram, open [@BotFather](https://t.me/BotFather):

1. Send `/newbot`.
2. Give it a name and a username ending in `bot`.
3. Copy the token BotFather returns. It looks like `123456789:ABC…`.

The bot is discoverable by its username, but SKS makes the coding bridge private by
pairing it to one private chat and one Telegram user. Do not add the bot to a group:
group chats are rejected by the pairing and runtime checks.

Treat the token like a password. Anyone holding it can act as the bot. Do not put it
in a source file, committed `.env`, chat, screenshot, shell history, or command-line
argument. SKS accepts it over stdin and stores it only in the macOS Keychain.

#### BotFather settings that matter

- **Privacy Mode:** no change is needed. SKS works only in a private chat, so
  BotFather's group-message privacy setting does not affect this integration. Leave
  the default enabled; group operation is not an SKS feature.
- **Commands:** BotFather command registration is optional cosmetic setup. SKS does
  not register a command menu for you, but if you want Telegram's slash-command
  picker, use BotFather's `/setcommands` and enter the commands in the table below.
  Registration does not grant any additional access.

| Command | SKS behavior |
| --- | --- |
| `/status`, `/tail`, `/diff`, `/gates`, `/trust`, `/proof`, `/artifacts`, `/refresh`, `/open` | Read-only session views |
| `/verify` | Request a verification view |
| `/input <text>` | Send coding input; ordinary non-command text does the same thing |
| `/cancel` | Requires a one-time, exact-session confirmation button |

Use only the commands above. `/start` is needed for pairing but is not an SKS coding
command.

### Step 2 — Send `/start` to your bot

From the Telegram account you want to pair, open your new bot and send `/start`.

This is **required**. SKS discovers which chat and user to pair by reading the most
recent matching `/start` update. It only accepts a `/start` sent in a **private**
chat. If matching updates from more than one private chat/user are pending, setup
fails closed instead of guessing which operator to authorize. Send `/start`
immediately before setup and do not send it from a different account or group while
pairing. Without it, setup fails with:

```
telegram_pairing_start_not_found:send_/start_to_the_bot_then_retry
```

### Step 3 — Connect the bot

#### Option A — SKS Center (GUI)

1. Open SKS Center → **Remote & Telegram**.
2. Paste the token into the **Telegram Bot Token** field (placeholder `123456789:ABC…`).
3. Click **Connect Bot & Register Coding Session…**

The panel is organised as `1. Connect your private Telegram bot`,
`2. Keep remote coding available`, `3. Code from Telegram`, and `Project readiness`.

#### Option B — CLI

The token is accepted **on stdin only** — never as an argument, so it cannot land in
your shell history or in the process table:

```bash
read -r -s 'SKS_TELEGRAM_TOKEN?Paste the BotFather token: '
printf '\n'
printf '%s' "$SKS_TELEGRAM_TOKEN" | sks telegram setup --bot-token-stdin --project-root "$PWD" --json
unset SKS_TELEGRAM_TOKEN
```

The token value never appears in this command's shell history or argument list. Do
not replace the variable with a literal token.

Useful flags:

| Flag | Meaning |
| --- | --- |
| `--project-root <path>` | Project to bind. Must be an absolute, existing directory. |
| `--paired-chat-id <id>` | Skip `/start` discovery and pair this chat explicitly. |
| `--paired-user-id <id>` | Skip `/start` discovery and pair this user explicitly. |
| `--new-session` | Discard the existing Codex session binding and register a fresh one. |

`--paired-chat-id` and `--paired-user-id` must be given together, and both must be
positive private IDs.

On success you get `sks.telegram-setup.v1` with the bot id/username, the paired
chat/user, `machine_id`, `project_id`, `session_id`, and
`codex_thread_state: "pending_first_turn"` — the Codex thread is created lazily on
your first real message.

### If this bot used a webhook before

SKS uses Telegram **long polling** (`getUpdates`) and refuses to run when Telegram
reports a non-empty webhook URL. Long polling and webhooks cannot be used together.
SKS checks this before polling and stops with `telegram_webhook_conflict`; it does
**not** delete a webhook automatically or expose a CLI command that clears one.

If you are reusing a bot from another service, remove its webhook in that service or
with the official Bot API `deleteWebhook` procedure first. Do not paste the token
into a shell command or a web-based "bot checker" to do this. `deleteWebhook` can
optionally drop pending updates; leave them intact unless you deliberately intend to
discard them. After the webhook URL is empty, send `/start` again and repeat setup if
discovery did not succeed.

### Step 4 — Start the hub

GUI: click **Start Hub**. CLI:

```bash
sks telegram hub start --project-root "$PWD" --json
```

Other hub actions: `stop`, `restart`, `status`. `sks telegram hub run` runs the hub
in the foreground instead of installing the LaunchAgent — useful for debugging.

### Step 5 — Code from Telegram

Send ordinary text to your bot. On the first real message the hub creates the Codex
thread and starts its first turn inside the same App Server connection, so the thread
is durably resumable. Later messages resume that exact thread.

Useful controls after pairing:

- Send normal text (or `/input <text>`) to request coding work.
- Use `/status`, `/diff`, `/proof`, or `/verify` to inspect the selected session.
- `/cancel` is intentionally not immediate: SKS sends an exact-session confirmation
  button before it can cancel a turn.

---

## Verifying the connection

```bash
sks telegram status --json
```

The report is `sks.telegram-status.v1`. A working setup has `ok: true` and an empty
`blockers` array. Fields worth reading:

| Field | Meaning |
| --- | --- |
| `configured` | A config file exists at all |
| `token_configured` | The Keychain token was resolvable |
| `pairing_valid` | Paired chat and user IDs are present and well-formed |
| `hub_running` | The LaunchAgent is loaded and running |
| `registered_session_count` | Codex session bindings matching a registered target |
| `blockers` | Everything still missing (see below) |

Check the config alone, with secrets redacted:

```bash
sks telegram validate-config --json
```

Check the machine registry that setup wrote:

```bash
sks remote readiness --json
sks remote machines list --json
```

Usage text for either surface:

```bash
sks telegram --help
sks remote --help
```

---

## Where things are stored

| What | Path |
| --- | --- |
| Hub config | `~/.sneakoscope-global/telegram/config.json` |
| Owner lock | `~/.sneakoscope-global/telegram/owner.lock` |
| Topic registry | `~/.sneakoscope-global/telegram/topic-registry.json` |
| Audit ledger | `~/.sneakoscope-global/telegram/audit.jsonl` |
| Idempotency ledger | `~/.sneakoscope-global/telegram/idempotency.jsonl` |
| Bot token | macOS Keychain, service `com.sneakoscope.telegram.bot` |
| LaunchAgent | `~/Library/LaunchAgents/com.sneakoscope.telegram-hub.plist` |

The config stores only a **reference** to the token
(`bot_token_ref: { type: "keychain", service, account }`). The token itself is never
written to disk by SKS.

### Rotate a BotFather token safely

Rotate immediately if the token was pasted into the wrong place, committed, logged,
or otherwise exposed. In BotFather, select the bot and use its token-revoke/regenerate
control; Telegram invalidates the old token and gives you a replacement. Then:

1. Stop the hub: `sks telegram hub stop --project-root "$PWD" --json`.
2. In the bot's private chat, send `/start` again from the same account.
3. Run the normal setup command with the replacement token on stdin.
4. Start the hub and verify status.

```bash
read -r -s 'SKS_TELEGRAM_TOKEN?Paste the replacement BotFather token: '
printf '\n'
printf '%s' "$SKS_TELEGRAM_TOKEN" | sks telegram setup --bot-token-stdin --project-root "$PWD" --json
unset SKS_TELEGRAM_TOKEN
sks telegram hub start --project-root "$PWD" --json
sks telegram status --project-root "$PWD" --json
```

Do not use `--new-session` for a token rotation unless you deliberately want to
discard the existing Codex session binding. Setup replaces the Keychain item while
retaining the existing session binding by default.

Setup refuses to run while the hub owner lock is active. Stop the hub before any
setup rerun or token rotation so no process keeps using the previous credential.
The Keychain credential, session binding, machine registry, session index, and
Telegram config are committed as one failure-safe operation. If a later write or
final `/start` acknowledgement fails, SKS restores the previous files and Keychain
token (or removes a newly created Keychain item) before reporting the error.

---

## Security model

- **Private pairing.** Exactly one chat ID and one user ID are accepted. Messages
  from any other chat or user are refused.
- **Token handling.** stdin only, stored in the macOS Keychain, referenced by name.
  Status output is redacted; the audit ledger records only a token fingerprint.
- **Project binding.** The session is bound to one project root, validated against
  the allowed-roots list. Telegram input cannot target another project.
- **No arbitrary shell.** Telegram input has no arbitrary shell path. It runs with
  approvals disabled and network access disabled inside the Codex workspace sandbox.
- **Single owner.** An owner lock keyed to the token fingerprint prevents two hubs
  polling the same bot; a stale lock expires after `owner_stale_ms` (default 60s).
- **`protect_content`.** Enabled by default, so Telegram marks hub replies as
  protected against forwarding and saving.

---

## Troubleshooting

Blockers come back in `blockers` from `sks telegram status --json`.

| Blocker | Meaning | Fix |
| --- | --- | --- |
| `config:config_not_object` | No hub config yet | Run `sks telegram setup` (Step 3) |
| `telegram_token_not_available` | Keychain lookup failed | Re-run setup; approve the Keychain prompt |
| `telegram_pairing_missing` | No paired chat/user | Send `/start` to the bot, re-run setup |
| `telegram_pairing_invalid:…` | IDs present but malformed | Re-run setup without `--paired-*` and let discovery run |
| `telegram_pairing_multiple_ids_requires_setup` | A legacy v1 config has multiple chat/user IDs whose intended pairing cannot be reconstructed safely | Stop the hub and rerun setup to replace it with one verified private chat and user |
| `no_registered_codex_session` | No session binding for this project | Re-run setup from the intended project root |
| `telegram_hub_not_running` | LaunchAgent not running | `sks telegram hub start --project-root "$PWD"` |
| `machine:…` / `target:…` | Machine registry or session index invalid | `sks remote machines validate --json` |

Setup or hub-runtime errors:

| Error | Meaning |
| --- | --- |
| `telegram_pairing_start_not_found:…` | No `/start` seen yet — send it, then retry |
| `telegram_pairing_ambiguous:…` | Pending `/start` updates identify more than one private operator; supply both verified private IDs, or deliberately clear pending updates through the official Bot API before sending `/start` again |
| `telegram_hub_must_be_stopped_before_setup` | A live hub owner holds the Telegram lock. Stop the hub before setup or token rotation. |
| `telegram_project_root_must_be_absolute` | Pass an absolute `--project-root` |
| `telegram_project_root_not_directory` | Path is not a directory |
| `telegram_project_root_invalid:…` | Root rejected by the allowed-root policy |
| `telegram_keychain_requires_macos` | Not macOS — unsupported |
| `telegram_keychain_store_failed` | Keychain write refused or timed out |
| `telegram_setup_rollback_failed:…` | Setup failed and at least one rollback step also failed. Keep the hub stopped and inspect the reported Keychain/state error before retrying. |
| `telegram_pairing_ids_must_be_positive_private_ids` | `--paired-chat-id`/`--paired-user-id` must both be positive private IDs |
| `telegram_webhook_conflict` | This bot still has a webhook URL, so SKS cannot start long polling. Remove the previous webhook outside SKS, then start the hub again. |
| `telegram_409_conflict` | Another poller is consuming updates for this bot. Stop the other bot process/service; do not run two hubs with the same token. |

### `/start` discovery still fails

1. Confirm you opened the **same bot** whose token you are supplying, from the
   intended Telegram account, and sent exactly `/start` in its direct-message chat.
2. Stop any existing polling service for that bot. A second poller can consume the
   update or cause a `telegram_409_conflict` later.
3. If the bot was previously configured with a webhook, remove that webhook first;
   Telegram does not deliver `getUpdates` while a webhook is active.
4. Send `/start` again, then immediately rerun setup. Setup consumes the matched
   update after pairing so the hub starts from the next update.
5. Only if automatic discovery is unsuitable, supply **both** private IDs with
   `--paired-chat-id` and `--paired-user-id`. Do not guess IDs or derive them from a
   group; SKS rejects group pairing.

If the hub reports `Could not find service "com.sneakoscope.telegram-hub"`, the
LaunchAgent has never been installed — that is expected before Step 4.

To roll the bot token: revoke it in @BotFather, get a new one, and re-run Step 3.
To rebind the Codex session, add `--new-session`.
