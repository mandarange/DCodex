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

Codex owns Responses tool execution and caching. SKS adds no sampling parameters,
cache configuration, or async tool protocol to forwarded requests. Mid-turn
configuration changes require host support; SKS does not emulate them. Provider
credentials, service tier, and unrelated model preferences remain authoritative.

Regression checks cover profile-sensitive prompt output, delegation conditions,
and SDK configuration. These checks establish behavior, not a measured reduction
in model cost or latency.
