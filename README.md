# Sneakoscope Codex

![](https://github.com/mandarange/Sneakoscope-Codex/raw/dev/docs/assets/sneakoscope-codex-logo.png)

Codex CLI/App harness for `$` routes, Team/Ralph/QA/Research, Context7, Honest Mode, DB safety, TriWiki, Codex App skills, and release readiness.

Install: `npm i -g sneakoscope && sks bootstrap`
Fallback: `npx -y -p sneakoscope sks bootstrap`
Project: `npm i -D sneakoscope && npx sks setup --install-scope project`

Discover: `sks commands`, `sks dollar-commands`, `sks usage <topic>`
Check: `sks deps check`, `sks doctor --fix`, `sks selftest --mock`

## What It Adds

Sneakoscope (`sks`, displayed as `ㅅㅋㅅ`) wraps Codex with a repeatable control surface:

| Area | What it does |
| --- | --- |
| Codex App commands | Installs generated skills so `$Team`, `$DFix`, `$QA-LOOP`, `$Ralph`, `$DB`, `$Wiki`, `$Help`, and related routes are discoverable in prompt workflows. |
| CLI commands | Provides `sks commands`, `sks dollar-commands`, `sks usage <topic>`, bootstrap, setup, doctor, deps, selftest, wiki, team, QA, Ralph, DB, and GX commands. |
| Team orchestration | Routes substantial code work through ambiguity removal, scouts, TriWiki refresh, debate, consensus, implementation, review, integration, reflection, and Honest Mode. |
| Ralph | Seals a decision contract up front, then continues without more user questions by using the agreed decision ladder. |
| QA loop | Dogfoods UI/API behavior with safety boundaries, evidence capture, safe remediation, and focused rechecks. |
| TriWiki | Keeps `.sneakoscope/wiki/context-pack.json` as the context SSOT, with refresh, pack, prune, validate, and hydratable source-backed claims. |
| Context7 | Requires current external library/API/framework docs for routes whose correctness depends on live package or platform behavior. |
| DB safety | Treats SQL, migrations, Supabase, RLS, and destructive operations as high risk; defaults to inspection and guarded local/branch-safe migration work. |
| Honest Mode | Finishes work with a claim/evidence pass that separates verified facts, unsupported claims, blocked checks, and not-applicable items. |
| GX visual context | Generates deterministic visual context cartridges for structured visual review and drift checks. |
| Research loops | Supports Research and AutoResearch workflows with hypotheses, experiments, falsification, novelty ledgers, SEO/GEO, and evidence-backed conclusions. |
| Release hygiene | Checks versioning, changelog, package contents, tarball size, syntax, selftests, and dry-run packaging before publish. |

## Prompt `$` Commands

Use these inside Codex App or another agent prompt. They are prompt commands, not terminal commands.

| Prompt | Purpose |
| --- | --- |
| `$Team` | Default route for code-changing work and substantial implementation. |
| `$From-Chat-IMG` | Team alias for chat screenshot plus original attachment intake. |
| `$DFix` | Tiny design/content fixes: labels, copy, colors, spacing, translation. |
| `$Answer` | Answer-only route when no implementation should start. |
| `$SKS` | Setup, status, usage, and Sneakoscope workflow help. |
| `$QA-LOOP` | UI/API dogfooding, safe fixes, and rechecks. |
| `$Ralph` | Clarify once, seal a decision contract, then execute. |
| `$Research` | Frontier-style research with hypotheses and falsification. |
| `$AutoResearch` | Iterative improve-test-keep/discard optimization loop. |
| `$DB` | Database and Supabase safety checks. |
| `$GX` | Deterministic visual context generation and validation. |
| `$Wiki` | TriWiki refresh, pack, prune, validate, and maintenance. |
| `$Help` | Installed command and workflow explanation. |

Run `sks dollar-commands` to verify the terminal and Codex App command surfaces agree.

## Terminal Examples

```sh
sks usage install
sks usage team
sks usage qa-loop
sks usage codex-app
sks setup --install-scope project
sks wiki refresh
sks wiki validate .sneakoscope/wiki/context-pack.json
sks versioning status
```

Route examples:

```sh
sks team "implement this" executor:3 reviewer:1
sks team watch <mission-id>
sks qa-loop prepare
sks qa-loop run
sks ralph prepare
sks ralph run
sks db scan
sks gx init
```

## Workflow Rules

For code work, Sneakoscope defaults to Team. The normal flow is: remove ambiguity that can change scope or safety, read/validate TriWiki, gather current source evidence, implement bounded changes, refresh/validate context after meaningful findings, run relevant checks, then finish with reflection and Honest Mode.

For tiny text/design edits use `$DFix`. For questions that should not change files use `$Answer`.

## Codex App Surface

`sks bootstrap` and `sks setup` install `.codex/SNEAKOSCOPE.md`, generated `.agents/skills`, `.codex/hooks.json`, route instructions for `$` commands, and user-home skill state for first-install discoverability.

After install, check:

```sh
sks dollar-commands
sks usage codex-app
```

## Release Checks

Before publish:

```sh
npm run publish:dry
```

This runs repo audit, changelog check, syntax packcheck, mock selftest, sizecheck, and `npm pack --dry-run`. A dry run proves the local package is packable; npm account ownership or OTP can still block the real registry upload.

## Requirements

- Node.js `>=20.11`
- npm
- Codex CLI/App for app-facing workflows
- Context7 MCP for current-docs-gated routes

## License

MIT
