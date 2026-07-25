# MCP ReadOnly Scheduler

SKS requires runtime scheduler proof before `readOnlyHint` is treated as parallel-safe evidence.

MCP `readOnlyHint` is advisory. SKS allows read-only MCP tools to be parallel candidates only after destructive name and schema checks pass.

`mcp:readonly-runtime-scheduler` produces a timestamped proof artifact:

- at least three read-only fixtures run concurrently and include overlap evidence
- write-capable fixtures run serially
- destructive tools with a misleading `readOnlyHint` are blocked from parallel scheduling
- every tool row includes start/end timestamps, duration, scheduled mode, and batch id

Release gates fail when read-only tools are serialized without a reason, write-capable tools overlap without permission, or destructive schema/name signals are treated as safe.
