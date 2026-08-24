<div align="center">

# Sneakoscope Codex

**Stop trusting “done.” Make Codex prove it.**

Proof-first orchestration for Codex CLI, ChatGPT Desktop, AI coding agents, multi-agent workflows, release verification, and the macOS menu bar.

<p align="center">
  <img src="docs/assets/sks-logo.svg" alt="Sneakoscope Codex logo" width="160" height="160" />
</p>

[![npm version](https://img.shields.io/npm/v/sneakoscope?color=cb3837&logo=npm)](https://www.npmjs.com/package/sneakoscope)
[![node](https://img.shields.io/badge/node-%3E%3D20.11-339933?logo=node.js&logoColor=white)](#requirements)
[![license](https://img.shields.io/badge/license-MIT-blue)](#license)

![SKS architecture pipeline](https://raw.githubusercontent.com/mandarange/Sneakoscope-Codex/main/docs/assets/sneakoscope-architecture-pipeline.jpg)

</div>

<!-- BEGIN SKS SEARCH VISIBILITY MARKETING -->
Sneakoscope Codex (`sks`) is an open-source trust layer for Codex CLI and ChatGPT Desktop. It coordinates bounded AI coding agents, records machine-verifiable evidence, preserves project memory, and blocks release claims that are not supported by current tests or artifacts. Search visibility outcomes are measured separately; SKS does not promise rankings or traffic.
<!-- END SKS SEARCH VISIBILITY MARKETING -->

This README documents package **SKS 9.2.2** — its own identity, read from `package.json` and subject to release-gate verification, not advice about what to install.

Use the official latest stable SKS and Codex CLI releases. The Codex compatibility SSOT is always the **current latest stable** host; capability probes measure what that host can actually do. Product docs do not crown a fixed `0.x.y` string as SSOT (release pins and schema directories are measured artifacts for the current package, not a permanent product version claim). Menu Bar / Center induce updates to the latest stable build. Run `sks update-check` for what is installed and read the capability report for what is supported. Install SSOT is npm `sneakoscope@latest`; PATH `sks` and Menu Bar stamped generation must match that version or gates fail. It resolves managed SKS skills from the authoritative global install, preserves a runnable Naruto child slot when `max_threads=2`, and keeps Menu Bar repair transactional so stamped generations remain verifiable. Naruto uses stable opt-in multi-agent V2 when the host exposes it (Codex official multi-agent wrap-only; SKS does not reimplement a parallel runtime). Local code search is mode-separated (`sks search files|text|structure|symbol|context`); `context` is answered by the compiled TriWiki Context Graph (`context-graph.json` is exhaustive authority; `context-pack.json` and managed `AGENTS.md` are bounded projections) — see [docs/architecture/context-graph.md](https://github.com/mandarange/Sneakoscope-Codex/blob/main/docs/architecture/context-graph.md) and [docs/PRODUCT-CONTRACT.md](https://github.com/mandarange/Sneakoscope-Codex/blob/main/docs/PRODUCT-CONTRACT.md). See [CHANGELOG.md](https://github.com/mandarange/Sneakoscope-Codex/blob/main/CHANGELOG.md).

## What 8.3.1 Ships

| Problem | 8.3.1 behavior |
| --- | --- |
| Overview mixed Menu Bar, installed SKS, and cached registry versions | Each value is labeled by authority, stale or unavailable probes remain explicit, and Refresh forces a bounded update-status refresh. |
| Naruto stopped creating children after its first wave | The root parent records settled waves, recovers open-thread capacity, rescans the ready DAG, and can launch later direct-child waves under the same workflow run. |
| Most delegated work drifted to Sol Max | Read-heavy discovery uses Terra Max, ordinary implementation uses Sol High, and Sol Max is reserved for focused high-risk or final judgment slices. |
| Goal creation started a second SKS-owned mission and loop | Codex native Goal is the only persisted owner; create/edit objectives are detailed and bounded, while SKS writes no Goal state or fallback loop. |
| Global instructions accumulated duplicated route rules and forced synthetic tests | One Core Engineering Directive anchors all work, route-specific details stay with their route, and verification targets normal behavior, meaningful boundaries, and plausible failures. |
| GUI-launched status commands could hang or contaminate real update state during tests | Menu Bar commands use a safe HOME cwd, closed stdin, and timeouts; update fixtures use isolated HOME and cache paths. |
| Codex routing was split across legacy provider paths | One local Desktop Bridge is the managed routing runtime; Codex-LB and OpenRouter are simultaneous credential profiles. |
| Requests could be coupled to a provider mode or weak model heuristic | The combined catalog's explicit route index resolves provider/model pairs with `fallback: none`; missing or ambiguous routes block. |
| Transport verification was confused with deep evidence | Capability v3 records scope, stage, requested level, execution, and readiness separately; unattempted deep work is not a transport failure. |
| The Menu Bar could terminate with Codex and miss the next Codex launch | A launchd-resident observer remains alive, follows Codex visibility without terminating, and migrates the legacy quit preference. |
| A partial Provider repair could look successful because the CLI exited zero | The Center validates the structured command status, records partial repair as needing action, and shows capability issues before verified diagnostic rows. |

## Install In One Command

```sh
npm exec --yes --package=sneakoscope@latest -- sneakoscope install --yes
```

The explicit `@latest` tag prevents a local package or stale npx cache from silently choosing an older installer. The installer verifies the registry tag, installs the exact version carried by that package, runs the exact installed entrypoint's `doctor --fix`, and succeeds only when the first `sks` on `PATH` targets that entrypoint and reports the same version. An older or same-version shadow prefix that still wins is reported as a blocker with a recoverable prior-version command. The plugin marketplace path is also prepared through `plugins/sks/.codex-plugin/plugin.json`.

For package-managed installs:

The npm lifecycle is non-mutating outside the installed package by default:
it restores only the package-local build stamp and prints the explicit setup
commands. To intentionally run the legacy bootstrap during installation, set
`SKS_POSTINSTALL_BOOTSTRAP=1`; `SKS_POSTINSTALL_NO_BOOTSTRAP=1` remains the
stronger safety override.

```sh
npm install --global sneakoscope@latest
node "$(npm root --global)/sneakoscope/dist/bin/sks.js" bootstrap --yes
node "$(npm root --global)/sneakoscope/dist/bin/sks.js" doctor --fix
sks --version
```

The two setup calls intentionally use the entrypoint under the npm global root.
The final `sks --version` must report that same package version; if it does not,
an older prefix still precedes the new npm bin directory on `PATH`.

The SKS menu bar shows the installed Codex CLI version and latest known version. An `⬆` marker appears when an update is available; **Update Codex CLI Now** uses native `codex update` when the selected CLI advertises it, otherwise it verifies the installation provenance and invokes the matching official standalone-installer, npm-global, or Homebrew-cask update method. If the method cannot be verified, it fails closed instead of guessing. Control Center updates keep the active UI alive until the operation receipt is durable, then relaunch the companion out of process. This is an explicit global tool mutation. **Run sks doctor --fix** performs the global-only menu repair flow without treating the user's home directory as a project.

**Manage MCP Servers…** opens a native macOS manager for the global `~/.codex/config.toml`. It can add remote URL or local stdio servers, enable/disable existing entries, remove entries after confirmation, and refresh the current state. Mutations are lock-protected, backed up, TOML-validated, and written with mode `0600`; configured environment values and command arguments are never rendered in the list. Changes apply to new Codex sessions. The same plumbing is available through the canonical `sks mcp config list|get|add|edit|duplicate|enable|disable|remove|test|login|logout|backups|restore` surface for diagnostics and automation.

### Recommended remote companion: Paseo

For remote and cross-device coding, Sneakoscope officially recommends
[Paseo](https://paseo.sh/docs). Start with the Paseo desktop app. For a
headless machine, install and launch the official CLI:

```sh
npm install -g @getpaseo/cli
paseo
```

Install and authenticate Codex CLI before using it through Paseo. Paseo runs
the existing provider CLI, so your Codex subscription, configuration, skills,
and MCP servers remain owned by Codex rather than copied into Sneakoscope.

From this repository, start Codex in the current workspace with:

```sh
paseo run --provider codex "Review this repository"
```

For an isolated branch-backed worktree based on `main`, use:

```sh
paseo run --new-workspace worktree --worktree-mode branch-off --new-branch paseo-task --base main "Implement the task"
```

The committed `paseo.json` prepares each new worktree with
`npm ci --ignore-scripts` followed by `npm run build:clean`. It also exposes
these named repository actions through Paseo:

| Paseo script | Repository command |
| --- | --- |
| `build` | `npm run build` |
| `typecheck` | `npm run typecheck` |
| `test` | `npm run test` |
| `release-check` | `npm run release:check:affected` |
| `release-confidence` | `npm run release:check:confidence` |

Paseo is an independent project, not bundled with or operated by Sneakoscope.
Sneakoscope maintains only this repository's `paseo.json` and usage guidance;
Paseo installation, authentication, pairing, relay operation, security, and
product support remain with Paseo and its official documentation.

## The Front Door

| Command | What it does |
| --- | --- |
| `$sks-plan "task"` | Planning only. Writes `.sneakoscope/plans/<slug>.md`; no code edits. |
| Explicit `$sks-work` | Executes the latest plan through evidence-gated SKS work. Ordinary prose containing “work” is not treated as this alias. |
| `$sks-naruto "task"` | Runs the Codex official subagent workflow with parent-owned integration and evidence. |
| `$sks-mad-sks` / `sks mad-sks` | Single high-risk MAD route for scoped permission widening plus SQL-plane execution, including read-back proof and profile closure. |
| `$sks-review` / `sks review --staged` | Reviews diffs with `evidence: machine` findings sorted above `evidence: llm`. |

`sks --mad` now prioritizes the interactive ready path: independent macOS config probes run concurrently, failed read-only preflight does not repeat mutation-capable repair inspection, and verified Codex evidence is reused. Existing unreadable or malformed config still blocks safely; pass an explicit repair flag such as `--repair-config` when repair is intended.

## Desktop Bridge

SKS 8.2.0 uses a single local **Desktop Bridge** for managed Codex Desktop and
CLI routing. ChatGPT OAuth stays in the Codex identity plane. Codex-LB and
OpenRouter credentials are independent profiles that can be configured and
validated simultaneously; changing one profile does not remove the other.

The bridge uses an atomically activated combined catalog and explicit route
index. It never guesses a provider from a model name and never silently falls
back. A missing or ambiguous route is a visible blocker. Provider-bound
upstream requests strip incoming ChatGPT OAuth authorization; status and
receipts contain only redacted credential metadata.

```sh
sks bridge status --json
sks bridge ensure --json
sks bridge provider list --json
sks bridge catalog sync --json
sks bridge route explain <model> --json
sks bridge verify --level transport --json
```

Configure secrets through stdin only:

```sh
read -r -s codex_lb_key
printf '\n'
printf '%s\n' "$codex_lb_key" | \
  sks bridge provider configure codex-lb --host lb.example.com --api-key-stdin --json
unset codex_lb_key

read -r -s openrouter_key
printf '\n'
printf '%s\n' "$openrouter_key" | \
  sks bridge provider configure openrouter --api-key-stdin --json
unset openrouter_key
```

`sks codex-lb` is removed and returns `unknown_command`; it has no alias.
Migration recognizes historical SKS-authored routing state only in a private,
receipt-backed path. Ambiguous user-owned configuration fails closed. Use
`sks bridge unmanage --confirm --json` or `sks bridge rollback <receipt-id>
--confirm --json` only for explicit rollback/removal.

## Naruto Workflow

`$sks-naruto` and `sks naruto run "task" --agents 8 --max-threads 12` use Codex official subagents. Standalone and Codex App tasks that request project-host database, spreadsheet, or render tools require the non-persistent `--trusted-project` flag after the operator reviews the checkout; an App session ID scopes evidence but does not grant trust. The parent is GPT-5.6 Sol Max. Tiny mechanical `worker` slices—including clear simple code, configuration, and setup changes—use Luna Max; ordinary UI, logic, backend, and native coding uses Sol High; review, testing, debugging, architecture, integration, security, database, research, release, and other judgment-sensitive work uses Sol Max; long-context scans, long-term memory, large-scale first-draft code processing, and direct Computer Use, Browser/Chrome, or image-generation execution use Terra Max. Mixed execution/judgment work is split when possible, and unsplittable judgment defaults to Sol Max.

Fresh SKS-owned project config enables Codex multi-agent V2 with an effective
cap of `agents.max_concurrent_threads_per_session = 256` children and
`features.multi_agent_v2.max_concurrent_threads_per_session = 257` total
threads, `max_depth = 1`, and `interrupt_message = true`. Nested delegation
remains forbidden. An existing user-owned persisted preference of 1000 is
preserved on disk but normalized at runtime to 256/257 with an explicit
warning; it is not an entitlement to spawn 1000 children. Explicit
`--agents` and `--max-threads` values above 256 are rejected.

Naruto's automatic starting tiers are 4/6/8 children for ordinary work and 16
for mass cheap-model work. After decomposition, either lane may expand to the
SKS-owned ceiling of 256 independent useful children. Explicit
`--agents N` and `--max-threads N` values from 1 through 256 remain
authoritative instead of being reduced to those automatic tiers. A first wave
may reach 256 child slots only when independent ready work, disjoint ownership,
verifier/tool capacity, and the external Codex/session host all permit it;
otherwise Naruto records the exact active limiter and reuses returned capacity
in later waves.

`SKS_NARUTO_REMOTE_API_PARALLEL_BUDGET` declares a lower remote provider/API
parallel-request budget for the governor. It cannot raise a lower external-host
or session limit. The official Codex lane does not impose a local CPU/RAM or
unmeasured API-default clamp; it follows an explicit provider budget and a
measured host cap. The 256 ceiling is structural, not a recommendation or proof
that 256 live agents were load-tested on the current host. The four GPT-5.6
model profiles are routing lanes, not an agent-count limit.

Gates are task-profile aware: greetings and answer-only turns create no mission gate; tiny work gets minimal verification; parallel work gets scoped ownership and verification; high-risk work keeps the full safety gates. `SubagentStart`/`SubagentStop` prove lifecycle only. Completion also requires `subagent-parent-summary.json` with one trustworthy structured outcome per thread, correlated with `subagent-events.jsonl` and `subagent-evidence.json`.

Every installed Codex hook runs one common Naruto decision gate. The gate records `none`, `generic_naruto`, or `route_owned`: Answer, DFix, Wiki, Computer Use, Goal, and simple Git/control turns stay lightweight; ordinary non-trivial work defaults to two independent official subagents; critical work spanning at least three risk domains may use three. Research, AutoResearch, and QA-Loop retain their own exact orchestration contracts instead of receiving a second generic fan-out. Explicit `--agents N` remains authoritative.

SKS installs twenty-five narrow project custom agents, including native AppKit, toolchain, protocol, runtime-reliability, TriWiki-evidence, long-context, Computer Use, Browser/Chrome, and image-generation specialists. Delegation prompts inject at most the three roles recommended for the current goal rather than serializing the full catalog, so expanding role coverage does not serialize the full inventory into every prompt. TriWiki context is also bounded and query-aware: ordinary work receives up to four trust/hydration anchors and complex, parallel, or high-risk work receives up to six, with source hydration required before relying on lower-trust hints. Official event evidence and the parent verdict—not display state—determine completion.

Official subagent requests use `--agents`; removed scheduler, pool, backend, and model flags fail closed.

## Embedding SKS In Another Agent System

For Bridge-managed routing, the bridge owns provider selection and credential
isolation; adapters must not write a competing global routing configuration.
ChatGPT OAuth remains Codex-owned, while provider secrets stay inside their
bridge profiles. An adapter can still run Naruto normally:

```sh
sks naruto run "task" --agents 2 --json
```

| Surface | Flag | Effect |
| --- | --- | --- |
| Parent model / effort | `--parent-model`, `--parent-effort` | Overrides the parent policy when the current host allows it. |
| Subagent model / effort | `--subagent-model`, `--subagent-effort` | Overrides the default subagent policy when the current host allows it. |
| Bridge state | `sks bridge status --json` | Returns secret-free routing/readiness state for the host to inspect. |

Guarantees this contract makes:

- **SKS never logs or serializes bridge credentials.** Provider operations accept
  secrets through stdin and record only redacted metadata.
- **Ambiguous routing blocks the run.** SKS does not silently select another
  profile, provider, or model when a requested route cannot be resolved.
- **Bridge state is not live proof.** Real provider/OAuth/Desktop evidence must
  be collected separately for a release claim.

### Designing an adapter that wraps SKS without fighting it

The rule that keeps an adapter conflict-free: **let SKS own the mission, the evidence, and the gates; let the host own the credential, the model policy, and the workspace.** Cross that line — by patching `dist/`, writing `.sneakoscope/` yourself, or re-implementing the gate DAG — and every SKS update breaks you.

```ts
// acas/adapters/sks.ts — one process boundary, no dist patching.
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const run = promisify(execFile)

export interface SksMissionRequest {
  workspace: string          // host owns the checkout
  task: string
  agents?: number
  tenant: {
    parentModel?: string
    subagentModel?: string
  }
}

export async function runSksMission(request: SksMissionRequest) {
  const { stdout } = await run('sks', [
    'naruto', 'run', request.task,
    '--json',
    ...(request.agents ? ['--agents', String(request.agents)] : []),
    ...(request.tenant.parentModel ? [`--parent-model=${request.tenant.parentModel}`] : []),
    ...(request.tenant.subagentModel ? [`--subagent-model=${request.tenant.subagentModel}`] : [])
  ], {
    cwd: request.workspace,
    maxBuffer: 64 * 1024 * 1024
  })
  // SKS answers with its own result schema; treat it as the source of truth for
  // status and evidence rather than re-deriving success from stdout text.
  return JSON.parse(stdout)
}
```

Then read the outcome through SKS's own surfaces instead of inferring it:

```sh
sks naruto proof --json                 # completion proof, blockers, evidence links
sks triwiki graph-status --fast --json  # is the compiled graph usable right now (no git, no spawn)
sks search context "..." --json         # evidence-backed context with reason paths
```

`graph-status --fast` is the probe to poll from a host loop: it reads the stored
artifacts only, so it costs no subprocess, and it reports which staleness reasons
it could not evaluate rather than returning a `fresh` that means less than it
looks. Drop `--fast` when you want the full git-aware verdict.

Adapter rules that keep updates safe:

1. **One process boundary.** Shell out to the `sks` CLI with `--json`. Do not import SKS internals; they are not a published API and they move.
2. **Never patch `dist/`.** A local patch is overwritten by every install and is asserted against by release gates. If a behaviour you need is missing, it belongs behind a flag like the ones above.
3. **Host owns the workspace, SKS owns `.sneakoscope/`.** Write your own state anywhere else; treat `.sneakoscope/` as SKS-owned and read-only from outside.
4. **Do not write routing state.** Use `sks bridge` for explicit profile and route operations; keep provider secrets out of adapter argv, logs, and local state.
5. **Let the gates fail.** A blocked mission with blockers is a correct answer. Do not retry it with safety flags off, and do not treat `--trusted-project` as a default — it is an operator decision about a reviewed checkout.
6. **Do not pin a version in your own docs or error strings.** Ask for the official latest stable release and read the capability report; SKS enforces this on itself with the `latest-version:guidance` gate.
7. **Parallelism advice is advisory.** `sks naruto` decides its own wave shape; if you plan slices yourself, check them against the graph advisory rather than assuming disjointness.

## Why Not Just An LLM Reviewer?

| Question | Oracle-style LLM review | SKS gate/review |
| --- | --- | --- |
| Did tests/typecheck fail? | Another model may say so. | Machine check output is tagged `evidence: machine`. |
| Are findings ranked? | Usually one blended opinion. | Machine evidence sorts before LLM findings. |
| Can work stop? | The model decides. | Stop gates, Completion Proof, and Honest Mode decide. |
| Can I inspect agent-thread progress? | Usually no runtime UI. | Use the official Codex subagent/thread surfaces and their proof artifacts. |

## Demo

The reproducible VHS script lives at [docs/demo.tape](https://github.com/mandarange/Sneakoscope-Codex/blob/main/docs/demo.tape).

```sh
vhs docs/demo.tape
```

It shows the current quickstart flow: one-line install, `$sks-plan`, `sks review`, `sks status --json`, and an official `$sks-naruto` subagent run.

## Proof Surfaces

- Official subagents: `sks naruto run "task" --agents 14 --max-threads 12 [--trusted-project] --json`
- Review report: `.sneakoscope/reports/review-report.json`
- Harness benchmark: `.sneakoscope/reports/harness-benchmark.json`
- Project memory: `sks memory build`
- Codebase index/pack for LLM context: `sks align run` (wiki/pack rebuild SSOT; `sks wiki refresh --code` aliases into align), `sks wiki validate --json`
- Native capability repair: `sks doctor --fix` (imagegen/Computer Use/Browser Use), `.sneakoscope/reports/native-capability-readiness.json`
- Desktop Bridge: `sks bridge status --json`, `sks bridge route explain <model> --json`, and `sks bridge verify --level transport --json` report service, explicit routing, and staged transport truth. A configured profile or catalog is not routing proof, and a missing route never silently falls back.
- Agent bridge for any agent system: `sks mcp-server`, `sks agent-bridge setup`, `SKS_AGENT_MODE=1` — see [docs/AGENT-BRIDGE.md](https://github.com/mandarange/Sneakoscope-Codex/blob/main/docs/AGENT-BRIDGE.md)
- Release gates: `npm run release:check:affected` for ordinary change-aware verification and `npm run release:check:confidence` for the final local confidence pass. Release claims still require target-bound real evidence for macOS lifecycle, OAuth preservation, both provider profiles, WebSocket protocol/frame truth, and deep artifacts; Paseo installation or pairing is not SKS release evidence, and documentation and fixtures do not satisfy protected gates.
- Direct npm publication: run `npm run release:check:full` (it creates the current clean-HEAD pack receipt), then publish from a clean `main` checkout that exactly matches `origin/main`. The Git release tag may be created afterward, and stage-only physical receipts do not block this direct path. The staged/OIDC workflow still requires all four source-bound physical receipts, exact tag proof, and its authenticated review gates.
- Release evidence boundaries: [docs/release-readiness.md](https://github.com/mandarange/Sneakoscope-Codex/blob/main/docs/release-readiness.md), [docs/release-proof-truth.md](https://github.com/mandarange/Sneakoscope-Codex/blob/main/docs/release-proof-truth.md), and [CHANGELOG.md](https://github.com/mandarange/Sneakoscope-Codex/blob/main/CHANGELOG.md). Local configuration, fixtures, and diagnostics are not live release proof.
- Image generation review routes require Codex App `$imagegen`/`gpt-image-2` evidence with recorded output hashes; direct API fallback and mock fixtures do not satisfy full route gates.

## Requirements

- Node.js `>=20.11`
- Git for diff/review and release proof
- macOS optional: menu bar integration and `/usr/bin/open`
  - The menubar icon shows and hides itself automatically as the Codex desktop app launches/quits; set `quit_with_codex: true` in `~/.codex/sks-menubar/config.json` to have the menubar fully quit with Codex instead of just hiding (default `false`).
  - Native input dialogs and the bridge CLI pass provider secrets via `--api-key-stdin`, never a visible Terminal command or process argument.
  - Codex Desktop keeps `~/.codex/auth.json` byte/semantic-preserved. Desktop Bridge strips incoming OAuth authorization before either provider upstream request.
  - Providers displays one bridge runtime, two independent profile rows, a combined catalog, explicit routes, and a scoped capability matrix. A status row is not a claim that a credential, WebSocket frame, or deep feature has been proven live.
  - Migration recognizes historical SKS-authored values privately, writes a redacted receipt, and fails closed on user-owned/ambiguous configuration. It does not reactivate a legacy mode or create a legacy directory.
  - `sks bridge unmanage --confirm` and `sks bridge rollback <receipt-id> --confirm` are explicit recovery actions; neither deletes newer credentials or OAuth state.
  - The provider services remain independently operated. SKS never deploys them, changes remote credentials, or silently substitutes one profile for another.
  - Full release proof remains `not-run-real` until fresh target-bound evidence covers the real Desktop service/UI, OAuth preservation, both provider profiles, staged WebSocket verification, and each claimed deep artifact.
  - Update installs stop and verify every prior Menu Bar process before replacement, rebuild the companion from the newly installed SKS package, bootstrap it, and require exactly one running process whose version probe equals the current package version.
  - The menubar dropdown's `View Last Log` item opens the most recent background action's log file, so you don't need to keep a Terminal window open to see command output.
  - `Manage MCP Servers…` provides a resizable native table and add/remove/enable/disable controls for global Codex MCP configuration. Secret environment values and command arguments are accepted through native dialogs/stdin but omitted from list output and logs.
  - `sks menubar status --json` reports a `codex_sync` object with `bundle_id`, `codex_running`, and `icon_visible_expected` to show Codex-lifecycle detection state.
  - The menu displays the installed Codex CLI version, adds an `⬆` status icon when `sks codex update-status` sees a newer release, runs the official self-updater through `Update Codex CLI Now`, and exposes `Run sks doctor --fix` as a background repair action.
  - **Codex Fast** is labeled as the official 1.5× Codex speed option, with a verified service-tier status row and direct On/Off actions. Center explains that ChatGPT-sign-in GPT-5.6/GPT-5.5 use 2.5× Standard credits and GPT-5.4 uses 2×, while API-key token pricing and API Priority processing are separate. Model selection, Codex-Spark, and reasoning effort remain independent; status failures render as unavailable with neither choice falsely selected.
- If Codex shows `[No tool output found for custom tool call ...]`, retry or recover in the same thread when possible; move to a new task only if recovery fails. SKS never rewrites session JSONL or fabricates a successful tool output.
- Product naming triangle: **Sneakoscope Codex** (product) / **`sks`** (CLI) / **`sneakoscope`** (npm). Official hosts are Codex CLI and ChatGPT Desktop equally; Cursor and other editors are best-effort only. macOS is fully supported (CLI + Menu Bar/Center); Linux/Windows are CLI best-effort. Product UI/docs language SSOT is English. Support: GitHub Issues. Contract ledger: [docs/AMBIGUITY-RESOLUTIONS.md](https://github.com/mandarange/Sneakoscope-Codex/blob/main/docs/AMBIGUITY-RESOLUTIONS.md) and [docs/PRODUCT-CONTRACT.md](https://github.com/mandarange/Sneakoscope-Codex/blob/main/docs/PRODUCT-CONTRACT.md).

## License

MIT
