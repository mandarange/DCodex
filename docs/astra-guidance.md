# Astra guidance in SKS

Reviewed against [OpenAI's GPT-6 Astra guidance](https://developers.openai.com/api/docs/guides/latest-model) on 2026-09-06.

SKS applies the prompting recommendations at its existing instruction boundaries:

- Honor authorization already given; explain the exact skill instruction behind a necessary pause.
- Keep ordinary bounded work with the parent. Delegate independent work when useful, respecting explicit counts, ownership, and the existing no-nesting boundary.
- Run relevant checks once; repeat them for changed code, a failure, or an unresolved concern.
- Keep responses concise. Copy and translation requests return the requested content.
- Essential prompts omit strict-mode reflection and final-format rituals. Strict retains them.

The existing model split remains: Luna/max for tiny mechanical work; Astra/medium
for exploration and tools, high for implementation, and max for judgment. SDK
requests for the exact `gpt-6-astra` model map retired `none`/`minimal` efforts to
`low`; supported efforts and saved host settings remain unchanged.

## New tool and continuation features

SKS encourages async reads before independent work and waits only at dependency
boundaries. Programmatic calling handles bounded read/transform batches; deferred
tools are loaded first, and approval-sensitive actions remain direct. New user
instructions continue the active work through native steering.

The App Server client now awaits Promise-based dynamic tool handlers while still
processing notifications and other requests. Calls retain their original IDs,
have bounded concurrency and timeouts, and receive an abort signal on timeout or
connection closure. This fixes Promise objects being serialized as empty results.

Desktop Bridge preserves `async`, `previous_response_id`, original `call_id`, and
`configuration_update` data while applying the selected provider route. Stream
parsing isolates steering continuations and keeps explicit incomplete responses
incomplete. Structured extraction cannot accept them as final output.

There is a host boundary: Codex 0.153.4's generated experimental App Server schema
does not expose the Responses tool `async` field. Async host callbacks are not a
claim that the model continues reasoning while the tool runs. Responses clients
can supply the field through the bridge; SKS does not inject it into a host that
has not advertised support or create a second model runtime.

For [API async tools](https://developers.openai.com/api/docs/guides/async-tool-calling),
use direct function/custom tools, preserve original call IDs, and avoid combining
them with parallel calls in multi-agent API mode. For
[effort updates](https://developers.openai.com/api/docs/guides/reasoning#change-reasoning-mid-conversation),
use compatible Astra standard single-agent requests without automatic compaction
or truncation. The existing request prefix and selected service tier stay intact.
See [steering](https://developers.openai.com/api/docs/guides/steering) and
[programmatic calling](https://developers.openai.com/api/docs/guides/tools-programmatic-tool-calling).

Regression checks cover profile-sensitive prompt output, delegation conditions,
SDK configuration, asynchronous callback lifecycle, stream continuation, and local
HTTP forwarding. These checks establish behavior, not a measured reduction in
model cost or latency or a live-provider rollout of every API feature.
