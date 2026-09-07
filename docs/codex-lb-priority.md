# Codex-LB priority in Codex App

SKS 10.1.3 routes ordinary Codex App Responses WebSockets using the model in
`response.create`. A WebSocket upgrade usually carries no model. Older bridges
sent an unpinned upgrade to the official upstream before reading any request,
even when Center had enabled Codex-LB priority and the saved model route pointed
to Codex-LB. The opaque tunnel then bypassed the model routing policy.

The bridge accepts the local Responses connection, reads the first model-bearing
request, and resolves the same catalog route and session affinity used by HTTP.
It connects only to that upstream, applies the existing credential header policy,
and replaces public model aliases with the upstream model ID. Each later create
is checked before forwarding. A provider change on an established connection is
rejected before sending the request or changing its durable session pin.

Native Astra steering, tool outputs, async events, and response events continue
over the established WebSocket. Queued messages, message size, connection setup,
and failed-connection cleanup are bounded. A healthy established connection has
no bridge-imposed idle timeout. Requests already sent are never replayed on
another account or on HTTP.

Codex prewarms a Responses WebSocket at startup and may hold it idle until the
first turn; its first frame is a `response.create` with `generate: false`. The
bridge dials nothing until that frame arrives and keeps an unbound socket open
for up to an hour, the connection lifetime upstreams grant, before releasing it
with a normal close and no error event. A request-scale wait here closed every
prewarmed connection before Codex used it.

## Authentication and settings

OAuth login is still the Codex App identity. Seeing a ChatGPT account in the App
does not identify the inference upstream. SKS retains the built-in `openai`
provider and configures user-level `openai_base_url` to its capability-protected
loopback bridge. Explicit official routes and native App services retain that
OAuth identity; provider routes use their registered provider credentials.

Center's priority toggle is a durable preference. With a ready Codex-LB
registration it selects gateway routes for eligible bare official model IDs.
Switching it off restores the saved official-model routing choice. A running
bridge with stale or unhealthy service state reports the preference as
unavailable, rather than active.

`sks update` retains the provider credentials and preference, repairs the bridge
through the current package's service installer when its runtime or configuration
is stale, and checks the version actually serving afterward. A remaining repair
failure is reported. Existing WebSockets must reconnect to run the replacement
code; release/version metadata alone cannot prove traffic routing.

A bridge that came up running is never booted out over a blocker alone. The
entry launchd ran can be an older global install than the CLI that installed
it, which reports `desktop_bridge_runtime_version_stale`; the installer and the
settings restart now return that blocker for the caller instead of stopping a
serving bridge, which left Codex with a dead port.

The launch agent always names an interpreter. launchd starts the service with a
minimal `PATH` that has no `node`, so a `#!/usr/bin/env node` entry reached
through the npm bin symlink failed with `env: node: No such file or directory`
and a failed restart booted the service out. A PATH-resolved JavaScript entry is
now launched through the Node binary running the command, as the argv entry
already was.

## Verification boundaries

Loopback integration tests distinguish provider and official upstream servers,
assert credential isolation, and exercise the real model-less upgrade shape.
They also cover aliases, later provider-change rejection, and transport failures.
These are isolated tests, not proof of a particular installed App task.

A live smoke can start the candidate bridge on a separate loopback port without
rewriting the installed configuration or restarting active App tasks. Recording
the selected route and a completed real upstream response proves that candidate
path. An installed App turn after update remains a separate observation.

## Current documentation

Reviewed 2026-09-07 using official documentation and Context7:

- [OpenAI advanced configuration](https://learn.chatgpt.com/docs/config-file/config-advanced):
  user-level `openai_base_url` proxies the built-in provider while retaining its identity.
- [Codex-LB client setup](https://soju06.github.io/codex-lb/client-setup/):
  Codex App identity, Responses transport, and `supports_websockets` configuration.
- [GPT-6 Astra](https://developers.openai.com/api/docs/models/gpt-6-astra) and
  [steering](https://developers.openai.com/api/docs/guides/steering):
  preserve the native Responses WebSocket path.
- [Async tool calling](https://developers.openai.com/api/docs/guides/async-tool-calling):
  preserve native function/custom call events and call IDs; the proxy does not
  implement or emulate application tool execution.
- [ws API](https://github.com/websockets/ws/blob/master/doc/ws.md):
  `noServer` upgrades, explicit payload limits, connection lifecycle, and send callbacks.
