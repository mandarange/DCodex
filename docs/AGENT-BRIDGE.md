# Agent Bridge

SKS exposes its full command surface to any agent system — not a specific one — through two
contracts every agent host already understands: a stdio MCP server, and a non-interactive CLI
contract. This document is the reference for both, plus the real-time streaming recipe for
answering a chat surface from a long-running SKS command.

## Quick start

```bash
sks agent-bridge setup --json
# After reviewing and trusting the checkout, also probe its project MCP inventory:
sks agent-bridge setup --trusted-project --json
```

This publishes the machine-readable command manifest to `.sneakoscope/agent-bridge/manifest.json`,
prints host registration snippets, and runs a live non-interactive smoke test
(`SKS_AGENT_MODE=1 sks status --json`) so you know the contract actually works on this machine
before wiring anything up. The default command does not read project MCP configuration or start a
project MCP server. `--trusted-project` is the explicit operator decision that enables the bounded
project inventory and health probe included in `host_capability_inventory`.
`sks naruto run` uses the same non-persistent `--trusted-project` spelling when a standalone or
Codex App task requests project-host database, spreadsheet, or render tools. App session identity
scopes runtime evidence but never grants project trust, and neither command stores trust for later
invocations. Machine consumers use the boolean `trusted_project` command-contract field, which maps
to that exact CLI flag. The standalone child receives the raw one-time claim nonce only in its
environment; mission artifacts persist only its SHA-256 and consume the pending grant on first bind.

## Contract 1: stdio MCP server

```bash
sks mcp-server            # exposes read-only commands only
sks mcp-server --expose-exec   # also exposes non-read-only commands
```

Any MCP-capable host can register this as a toolset. It speaks the MCP `2026-07-28` protocol over
stdio. The server is modern-only: clients discover it with `server/discover`, then send
`tools/list` and `tools/call` with the negotiated protocol version and client capabilities in the
standard per-request `_meta` envelope. The retired `initialize`/`initialized` handshake is not
accepted on this SKS-owned surface. SKS's Context7 client uses the official
`@modelcontextprotocol/client` v2 negotiation path in `auto` mode so an external third-party MCP
server can still select the modern era or fall back to its supported legacy handshake.
The SKS server itself is built with `@modelcontextprotocol/server` v2's `McpServer`,
`serveStdio`, and `StdioServerTransport` APIs, with legacy handling set to `reject`. Registered
tool input schemas are adapted from the command contracts with the SDK's `fromJsonSchema` helper.

- **`tools/list`** returns one tool per command in the agent manifest. By default only
  `read_only: true` commands are exposed (see `src/core/agent-bridge/agent-manifest.ts` — derived
  from `src/cli/command-registry.ts`, never hand-maintained separately). Pass `--expose-exec` at
  server startup to also expose mutating commands — off by default, since a generic MCP client
  should not be able to run `sks uninstall` or a MAD-SKS route without an explicit opt-in.
- **`tools/call`** validates the requested tool name against the manifest before spawning
  anything. An unknown or unexposed name returns the MCP JSON-RPC `Invalid Params` error
  (`-32602`) — it never spawns a process for a name the caller invented.
- Each tool call runs `sks <name> [--json]` as a subprocess with `SKS_AGENT_MODE=1` set (see
  Contract 2) so the invocation is guaranteed to be non-interactive and returns clean JSON.
- Every successful modern response carries `resultType: "complete"` and the server identity under
  `_meta["io.modelcontextprotocol/serverInfo"]`. Cacheable discovery/list responses use the
  conservative `ttlMs: 0` and `cacheScope: "private"` defaults.
- Stdio messages are capped at 10 MiB. Tool execution is also bounded to four active calls and 64
  queued calls by default; excess calls return a structured `SERVER_BUSY` tool error.

Register with a CLI host:

```bash
codex mcp add sks -- sks mcp-server
```

Register with any other MCP host — the generic form:

```json
{ "command": "sks", "args": ["mcp-server"] }
```

## Contract 2: non-interactive CLI (`SKS_AGENT_MODE`)

For agent systems that can only invoke subprocesses (no MCP support), set `SKS_AGENT_MODE=1`:

```bash
SKS_AGENT_MODE=1 sks status --json
```

The contract:

- **stdout is exactly one JSON result** for the invoked command — no banners, no spinners
  (those go to stderr).
- **Never blocks on a prompt.** Any interactive question point returns immediately instead of
  calling `readline`:
  ```json
  { "ok": false, "error": "interactive_input_required", "question": "...", "non_interactive_hint": "..." }
  ```
  with exit code `3`, so a caller can detect this case and either answer it via the hinted flag
  or surface it to a human.
- Update checks and the per-project migration gate are skipped automatically (agent mode implies
  the same env vars the SKS menu bar background process already relies on:
  `SKS_UPDATE_MIGRATION_GATE_DISABLED`, `SKS_DISABLE_UPDATE_CHECK`).
- **Any uncaught error still returns valid JSON on stdout** (`{ "ok": false, "error": ..., "command": ... }`,
  exit code 1) rather than leaving stdout empty — the router's final crash guard (see
  `src/cli/router.ts`) guarantees this for every command, not just agent-mode-aware ones.

## Real-time answers: NDJSON streaming (`--stream`)

For a chat bot that wants to relay progress instead of waiting silently
for a long-running command to finish, pass `--stream` on a command that supports it (currently
piloted on `sks qa-loop run`):

```bash
SKS_AGENT_MODE=1 sks qa-loop run <mission> --mock --stream --json
```

stdout becomes newline-delimited JSON, one event per line:

```json
{"event":"start","ts":"...","data":{...}}
{"event":"progress","ts":"...","data":{"type":"cycle_start","cycle":1}}
{"event":"progress","ts":"...","data":{"type":"cycle_continue","cycle":1}}
{"event":"result","ts":"...","data":{"ok":true,"status":"cycle-done"}}
```

The stream always ends with exactly one `result` event, regardless of which internal branch
produced it.

### Chat Bot Recipe

1. Spawn `sks <command> --stream --json` as a child process (with `SKS_AGENT_MODE=1`).
2. On the first `start` event, open a thread and stash `data.mission_id` for later reference.
3. On each `progress` event, **edit the same thread reply in place** with a human-readable
   rendering of `data.type`/`data.cycle` — don't post a new message per event, or you'll spam
   the channel.
4. On the `result` event, post the final pass/fail summary (`data.ok`, `data.status`) as a new
   message and stop reading.

```js
const child = spawn('sks', ['qa-loop', 'run', missionId, '--mock', '--stream', '--json'], {
  env: { ...process.env, SKS_AGENT_MODE: '1' }
});
let threadTs = null;
for await (const line of readLines(child.stdout)) {
  const evt = JSON.parse(line);
  if (evt.event === 'start') threadTs = await postToThread(evt.data.mission_id);
  else if (evt.event === 'progress') await editThreadReply(threadTs, renderProgress(evt.data));
  else if (evt.event === 'result') await postMessage(renderResult(evt.data));
}
```

## Compatibility and manifest schema (`sks.agent-manifest.v2`)

Host compatibility is determined by these four schema contracts, not by an SKS
package-version comparison:

```text
bridge_contract = sks.agent-bridge.v1
agent_manifest_schema = sks.agent-manifest.v2
naruto_proof_schema = sks.naruto-subagent-workflow.v1
host_capability_schema = sks.host-capabilities.v1
```

Within a schema major, SKS preserves required keys, field types, and enum
meanings; additive optional fields and new capabilities are allowed. A breaking
change requires a new version of the affected schema. For `sks.agent-manifest.v2`,
`compatibility` and `host_capabilities` are required blocks; validators fail closed
when either is missing. `compatibility.package_version`
reports the running package version for diagnostics only: hosts must not use it
for exact-version checks, semver ranges, admission, branching, support lists,
or binary fallback.

`sks agent-bridge setup` writes `.sneakoscope/agent-bridge/manifest.json`:

```json
{
  "schema": "sks.agent-manifest.v2",
  "generated_at": "...",
  "compatibility": {
    "bridge_contract": "sks.agent-bridge.v1",
    "manifest_schema": "sks.agent-manifest.v2",
    "proof_schema": "sks.naruto-subagent-workflow.v1",
    "host_capability_schema": "sks.host-capabilities.v1",
    "package_version": "8.3.3"
  },
  "host_capabilities": {
    "schema": "sks.host-capabilities.v1",
    "capabilities": [],
    "capability_digest": "sha256:..."
  },
  "tools": [
    {
      "name": "status",
      "description": "Show concise active mission and trust status",
      "read_only": true,
      "requires_explicit_opt_in": false,
      "json_output_supported": true,
      "latency_class": "fast",
      "example_invocation": "sks status --json",
      "maturity": "stable"
    }
  ]
}
```

- `read_only` — safe to expose without `--expose-exec`.
- `requires_explicit_opt_in` — destructive or high-risk commands (uninstall, MAD-SKS, update/apply,
  purge, wipe, delete) are flagged so a host can gate them behind extra confirmation even under
  `--expose-exec`.
- `latency_class` — `fast` (read-only), `long` (Naruto, MAD-SKS, update, Loop, QA-Loop,
  Research/AutoResearch, or anything whose summary mentions install/update), `normal` otherwise.
- `json_output_supported` — best-effort static scan of the compiled command module for a
  `--json` literal; conservatively `false` (never fabricated `true`) when the file can't be
  read (e.g. `dist` not built yet).

### Host capability pack

`host_capabilities` describes the capabilities that an ACAS host MCP may make
available to a Naruto parent. Each descriptor records only its ID, provider,
MCP server, tool names, side-effect class, ordinary requested uses, and
`required: false`; SKS does not copy a host tool's full JSON schema. The seven
descriptors are:

| Capability | Host MCP tools | Purpose |
| --- | --- | --- |
| `host.workspace.files.v1` | `read_file`, `write_file`, `edit_file`, `find_workspace_files`, `list_workspace`, `download_url_to_workspace` | Workspace file access |
| `host.web.capture.v1` | `capture_url_screenshot` | Allowed URL screenshot capture |
| `host.document.render.v1` | `html_to_pdf`, `html_to_screenshot` | HTML-to-PDF/PNG rendering |
| `host.datasource.schema.v1` | `datasource_schema_context` | Allowed datasource and schema snapshot |
| `host.datasource.query.readonly.v1` | `datasource_query_readonly` | Parameterized read-only query execution |
| `host.spreadsheet.workbook.v1` | `spreadsheet_create`, `spreadsheet_inspect`, `spreadsheet_update` | XLSX creation, inspection, and update |
| `host.artifact.receipt.v1` | Common output of the write tools | Artifact path, hash, media type, and byte receipt |

`required: false` means ordinary coding or text work is not blocked merely
because a capability is absent. Availability is determined only from the real
project-MCP tool inventory, the setup-declared expected descriptor, and the MCP
inventory actually received by the Codex parent. SKS never guesses capability
availability from configuration-file text and never auto-repairs a `missing` or
`unhealthy` requested capability; existing setup/doctor MCP repair paths remain
the repair mechanism. `sks agent-bridge setup` reports the project inventory as
untrusted/not requested until the operator supplies `--trusted-project`; it does
not read or spawn project-configured MCP servers before that decision. A requested
capability that is missing or unhealthy must produce a blocked proof.

`capability_digest` is `sha256:` over a code-point-sorted canonical JSON list.
For each capability, only `id`, `mcp_server`, sorted `tool_names`, `side_effect`,
and sorted `required_for` participate. Descriptions, generation time, provider,
`required`, and package version do not participate.

## Naruto host contract fixtures

External hosts that consume `sks naruto proof --json` should treat these checked-in envelopes as
the stable outer contract for `sks.naruto-subagent-workflow.v1`:

- `fixtures/contracts/naruto-proof-v1/completed.json`
- `fixtures/contracts/naruto-proof-v1/blocked.json`
- `fixtures/contracts/naruto-proof-v1/incomplete.json`

All three states share the same top-level key set. `blockers`, `result.changed_files`, and
`result.verification` are always arrays. Explicit reserved mission IDs may first-create on
`sks naruto run --mission <id>`; `status` / `subagents` / `proof` remain create-free.

## Codex parent nonsecret host env allowlist

When SKS launches a standalone Codex parent for Naruto, only these additional host keys may pass
through the fixed child-env allowlist (exact names, no wildcards):

- `SKS_AGENT_MODE`
- `ACAS_CUSTOMER_ID`
- `SKS_NARUTO_PARENT_EDGE_ID`
- `SKS_NARUTO_PARENT_LEASE_OWNER`
- `SKS_NARUTO_PARENT_LEASE_GENERATION`
- `SKS_NARUTO_PARENT_MISSION_GENERATION`
- `ACAS_AGENT_SLUG`
- `ACAS_AGENT_WORKSPACE`
- `ALFREDO_AGENT_SOULS_FILE`
- `ACAS_CHROME_PATH`
- `ACAS_HTML_TO_PDF_ENGINE`
- `ACAS_HTML_TO_PDF_ALLOW_CHROME_CLI_FALLBACK`

The customer, edge, lease, and mission-generation values are non-secret identity/fence inputs.
The lease owner is child-only identity: its raw value is never persisted in mission proofs or
workflow results. SKS separately generates the owning mission ID, workflow run ID, and one-time
host-capability nonce for the launch; the nonce remains confined to the child environment while
mission artifacts persist only its SHA-256 binding.

Connection tokens, Center URLs, Supabase access tokens, provider API keys, Slack `*TOKEN`
variables, `HTTP_PROXY` / `HTTPS_PROXY` / `ALL_PROXY`, and env-file path overrides are never
copied into the child environment.

## Desktop Bridge command contract

Agent consumers that need managed Codex routing use the `bridge` command
manifest entry. The command owns one local Desktop Bridge runtime and exposes
profile, catalog, route, verification, unmanage, and receipt-based rollback
operations. Codex-LB and OpenRouter are profiles in the command payload; they
are not agent-visible runtime modes.

Provider secrets are accepted only through the command's stdin path. Agent
manifests and JSON results must contain no raw credential. A non-strict
`bridge verify` result may have a completed execution with unmet readiness;
agents must inspect both fields and must not infer deep verification from a
transport report. The removed `sks codex-lb` name is absent from the manifest
and returns `unknown_command` if invoked.

## Security notes

- `--expose-exec` is off by default on `sks mcp-server`. A generic MCP client only sees
  read-only commands unless the operator explicitly opts in at server startup.
- `tools/call` never spawns a tool name absent from the manifest, whether or not
  `--expose-exec` is set.
- `sks agent-bridge setup` never reads or starts a project-configured MCP server unless the
  operator explicitly supplies `--trusted-project` after reviewing the checkout.
- Every subprocess invocation runs with `SKS_AGENT_MODE=1`, so it inherits the same
  never-block-on-a-prompt guarantee described above.
- The generated manifest contains only the current command registry and is written to
  `.sneakoscope/agent-bridge/manifest.json` as a local generated artifact (not tracked in git).
  `sks doctor --fix` and `sks update` reconcile SKS-owned installed manifests and remove
  retired managed entries; user-authored collisions are preserved in quarantine instead of
  overwritten.
