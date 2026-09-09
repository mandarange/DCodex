# Astra guidance in SKS

Reviewed against [OpenAI's GPT-6 Astra guidance](https://developers.openai.com/api/docs/guides/latest-model) on 2026-09-06.

SKS applies the prompting recommendations at its existing instruction boundaries:

- Honor authorization already given; explain the exact skill instruction behind a necessary pause.
- Keep ordinary bounded work with the parent. Delegate independent work when useful, respecting explicit counts, ownership, and the existing no-nesting boundary.
- Run relevant checks once; repeat them for changed code, a failure, or an unresolved concern.
- Keep responses concise. Copy and translation requests return the requested content.
- Essential prompts omit strict-mode reflection and final-format rituals. Strict retains them.

All managed children use GPT-6 Astra: low for tiny mechanical work, medium
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

## Run native Async tool calling

With the registered Codex-LB bridge running, use:

```sh
sks agent-bridge async --prompt "Check SKS status and stats. While those tools run, explain what each check covers." --tools status,stats --json
```

This explicit Responses mode uses the existing `codex-lb:gpt-6-astra` route and
sets `async: true` on each selected function. It starts a tool when its complete
call arrives, continues reading the model stream, and submits actual results on
the original `call_id`. Stateless continuations preserve output and encrypted
reasoning with `store: false`. No provider or saved Codex session is switched.

The command prefers a persistent WebSocket. Completed turns continue on that
same connection with `previous_response_id` and only new tool outputs. If the
upgrade fails, or the connection closes between completed responses, the next
unsent request uses HTTP/SSE with the full saved context. An interruption after
request transmission stops the run rather than replaying uncertain work. Auth
rejections stay visible. JSON includes connection/request counts, incremental
continuations, and any fallback or failure reason under `transport`.

Only published, remote-readable R0 command contracts are available. Tool inputs
use their existing schemas; credentials in outputs are redacted. The runner
bounds calls, concurrency, response sizes, rounds, and elapsed time. Cancellation
also terminates tool process trees; failures and incomplete responses stay visible.

JSON output reports `model_async_observed` and `continued_before_tool_output`.
The latter records text received before tool-result submission, not a CPU overlap
or speed measurement. A run without an observed native async call cannot report
async success. A live Codex-LB probe confirmed native async calls, independent
text before result submission, and a completed continuation using the actual result.
A live run of the command also completed two responses on one WebSocket with one
incremental continuation and zero HTTP requests.

Codex 0.153.4's generated experimental App Server schema does not expose the
Responses tool `async` field. This command enables native async in the explicit
SKS bridge mode; ordinary Codex App tools remain controlled by the host. Promise
callback support alone does not establish native model async behavior.

For [API async tools](https://developers.openai.com/api/docs/guides/async-tool-calling),
use direct function/custom tools, preserve original call IDs, and avoid combining
them with parallel calls in multi-agent API mode. For
[effort updates](https://developers.openai.com/api/docs/guides/reasoning#change-reasoning-mid-conversation),
use compatible Astra standard single-agent requests without automatic compaction
or truncation. The existing request prefix and selected service tier stay intact.
See [steering](https://developers.openai.com/api/docs/guides/steering) and
[programmatic calling](https://developers.openai.com/api/docs/guides/tools-programmatic-tool-calling).

Regression checks cover profile-sensitive prompt output, delegation conditions,
SDK configuration, asynchronous callback lifecycle, native async dispatch and
cancellation, stateless continuation, and local HTTP forwarding. These checks
establish behavior, not a measured reduction in model cost or latency or a
live-provider rollout of every API feature.
